import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { addToWhitelist, createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";

// MNEMO-45: the public inbound gateway (POST /webhooks/twilio/sms). Runs in the
// workers pool so the D1 `DB` + `AGENT` DO bindings (wrangler.toml) and Web Crypto
// (the HMAC-SHA1 signature routine) are the real Workers implementations. We seed
// agent_numbers, post a genuinely Twilio-signed webhook, and assert the §9.3
// contract: a 200 empty-TwiML ack, the inbound handed to the per-agent DO via
// waitUntil (NOT awaited inline), and that an unauthenticated/unroutable call is
// rejected with NO handoff.

const GATEWAY_URL = "https://mnemosyne.test/webhooks/twilio/sms";
const TEST_AUTH_TOKEN = "test-twilio-auth-token-mnemo-45";

/** A unique E.164 per test so DO state (keyed by agentId) never collides. */
function uniqueNumber(): string {
  return `+1500${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
}

/** The standard counterparty across the accepted-message tests. */
const SENDER = "+14155551212";

/**
 * Seed account → agent → its provisioned number; return the agent id. Since
 * MNEMO-47 the gateway enforces access control (whitelist-by-default), so the
 * standard {@link SENDER} is whitelisted here - otherwise an unknown sender to a
 * closed agent is silently dropped (asserted separately below).
 */
async function seedAgentWithNumber(
  e164: string,
  { whitelistSender = true }: { whitelistSender?: boolean } = {},
): Promise<string> {
  const account = await createAccount(env, {
    email: `gw-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Messaging agent",
  });
  await env.DB.prepare(
    "INSERT INTO agent_numbers (agent_id, e164, provider, created_at) VALUES (?, ?, 'twilio', ?)",
  )
    .bind(agent.id, e164, new Date().toISOString())
    .run();
  if (whitelistSender) await addToWhitelist(env, agent.id, SENDER);
  return agent.id;
}

/**
 * Compute the X-Twilio-Signature exactly as src/messaging/twilioSignature.ts
 * validates it: sort params by key, append `key+value` to the full URL, HMAC-SHA1
 * under the auth token, base64. The test signer + the gateway's validator are the
 * two halves of the same scheme.
 */
async function signTwilio(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
): Promise<string> {
  let signing = fullUrl;
  for (const key of Object.keys(params).sort()) signing += key + params[key];
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(signing));
  let binary = "";
  for (const b of new Uint8Array(mac)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Build a form-encoded POST to the gateway carrying `signature` (or none). */
function gatewayPost(
  params: Record<string, string>,
  signature: string | null,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (signature !== null) headers["X-Twilio-Signature"] = signature;
  return new Request(GATEWAY_URL, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

/** Worker env with the test auth token standing in for the Wrangler secret. */
const testEnv = { ...env, TWILIO_AUTH_TOKEN: TEST_AUTH_TOKEN };

/** Read back what (if anything) the agent's DO recorded as last-received. */
function lastInbound(agentId: string) {
  const stub = env.AGENT.get(
    env.AGENT.idFromName(agentId),
  ) as unknown as DurableObjectStub<MnemosyneAgent>;
  return stub.getLastInboundMessage();
}

describe("inbound gateway - valid signature", () => {
  it("acks with empty TwiML and hands the inbound to the agent DO via waitUntil", async () => {
    const e164 = uniqueNumber();
    const agentId = await seedAgentWithNumber(e164);

    const params: Record<string, string> = {
      From: "+14155551212",
      To: e164,
      Body: "what's the latest?",
      MessageSid: "SM0123456789abcdef0123456789abcdef",
      NumMedia: "0",
      AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };
    const signature = await signTwilio(TEST_AUTH_TOKEN, GATEWAY_URL, params);
    const request = gatewayPost(params, signature);

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);

    // (a) The ack is immediate - empty TwiML, text/xml, 200 - and does NOT depend
    // on the agent loop (the handoff runs in waitUntil, drained below).
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/xml");
    expect(await response.text()).toBe("<Response></Response>");

    // The DO handoff is fire-and-forget: it only completes once the execution
    // context's waitUntil work is drained - proving the ack didn't await it.
    await waitOnExecutionContext(ctx);

    // (b) The DO received the normalized inbound (read back the stub's receipt).
    expect(await lastInbound(agentId)).toEqual({
      from: "+14155551212",
      to: e164,
      body: "what's the latest?",
      channel: "sms",
      threadId: null,
      providerMessageId: "SM0123456789abcdef0123456789abcdef",
      mediaUrls: [],
    });
  });
});

describe("inbound gateway - rejected calls receive no handoff", () => {
  it("returns 403 on an invalid signature and hands nothing to the DO", async () => {
    const e164 = uniqueNumber();
    const agentId = await seedAgentWithNumber(e164);

    const params: Record<string, string> = {
      From: "+14155551212",
      To: e164,
      Body: "spoofed",
      MessageSid: "SMdeadbeefdeadbeefdeadbeefdeadbeef",
      NumMedia: "0",
    };
    // A wrong signature - computed under a DIFFERENT token than the env's.
    const badSignature = await signTwilio(
      "not-the-real-token",
      GATEWAY_URL,
      params,
    );
    const request = gatewayPost(params, badSignature);

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
    expect(await lastInbound(agentId)).toBeNull();
  });

  it("returns 204 for an unknown destination number and hands nothing to the DO", async () => {
    // Seed a known agent/number, then target a DIFFERENT (unprovisioned) number.
    const knownNumber = uniqueNumber();
    const agentId = await seedAgentWithNumber(knownNumber);
    const unknownNumber = uniqueNumber();

    const params: Record<string, string> = {
      From: "+14155551212",
      To: unknownNumber,
      Body: "anyone home?",
      MessageSid: "SM99999999999999999999999999999999",
      NumMedia: "0",
    };
    // Validly signed - the 204 is because no agent owns the number, not auth.
    const signature = await signTwilio(TEST_AUTH_TOKEN, GATEWAY_URL, params);
    const request = gatewayPost(params, signature);

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(204);
    // The known agent's DO is untouched (the message targeted another number).
    expect(await lastInbound(agentId)).toBeNull();
  });

  it("acks an unknown sender to a closed agent but hands nothing to the DO (MNEMO-47 §9.6)", async () => {
    // A provisioned agent that is NOT open to the world and has NOT whitelisted
    // the sender - whitelist-by-default means the message is dropped silently.
    const e164 = uniqueNumber();
    const agentId = await seedAgentWithNumber(e164, { whitelistSender: false });

    const params: Record<string, string> = {
      From: SENDER,
      To: e164,
      Body: "let me in",
      MessageSid: "SM77777777777777777777777777777777",
      NumMedia: "0",
    };
    // Validly signed - the drop is access control, not auth.
    const signature = await signTwilio(TEST_AUTH_TOKEN, GATEWAY_URL, params);
    const request = gatewayPost(params, signature);

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // Still ack with empty TwiML 200 (so Twilio doesn't retry) - but no handoff.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<Response></Response>");
    expect(await lastInbound(agentId)).toBeNull();
  });
});
