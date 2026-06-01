import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccount, createAgent, getAgentNumber } from "../src/db/index.ts";
import { provisionAgentNumber } from "../src/messaging/provisioning.ts";

// MNEMO-47: Twilio number provisioning (PRD §9.1). Runs in the workers pool so the
// D1 `DB` binding is real; the Twilio REST calls (number search + purchase) are
// stubbed at globalThis.fetch. Asserts the happy path persists the row + wires the
// inbound SmsUrl to the gateway, and that both failure modes return a typed result
// WITHOUT throwing.

const CANDIDATE = "+15005551234";

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedAgent(): Promise<string> {
  const account = await createAccount(env, {
    email: `prov-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Provision agent",
  });
  return agent.id;
}

/** A fresh Response per call (body is single-use). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("provisionAgentNumber (PRD §9.1)", () => {
  it("searches, purchases, persists the row, and wires SmsUrl to the gateway", async () => {
    const agentId = await seedAgent();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("AvailablePhoneNumbers")) {
          return Promise.resolve(
            json({ available_phone_numbers: [{ phone_number: CANDIDATE }] }),
          );
        }
        if (url.includes("IncomingPhoneNumbers")) {
          return Promise.resolve(
            json({ sid: "PN_test", phone_number: CANDIDATE }, 201),
          );
        }
        return Promise.resolve(json({}));
      });

    const result = await provisionAgentNumber(env, { agentId });
    expect(result).toEqual({ ok: true, e164: CANDIDATE, sid: "PN_test" });

    // The registry row persisted, carrying the Twilio SID (for later release).
    const row = await getAgentNumber(env, agentId);
    expect(row?.e164).toBe(CANDIDATE);
    expect(row?.twilio_sid).toBe("PN_test");

    // The purchase wired inbound SMS straight to the MNEMO-45 gateway.
    const purchase = spy.mock.calls.find(([u]) =>
      String(u).includes("IncomingPhoneNumbers"),
    );
    const init = purchase?.[1] as RequestInit;
    const form = new URLSearchParams(init.body as string);
    expect(form.get("SmsUrl")).toContain("/webhooks/twilio/sms");
    expect(form.get("SmsMethod")).toBe("POST");
    expect(form.get("PhoneNumber")).toBe(CANDIDATE);
  });

  it("returns { ok: false } when no number matches the search (no throw)", async () => {
    const agentId = await seedAgent();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("AvailablePhoneNumbers")) {
          return Promise.resolve(json({ available_phone_numbers: [] }));
        }
        return Promise.resolve(json({}));
      },
    );

    const result = await provisionAgentNumber(env, {
      agentId,
      areaCode: "415",
    });
    expect(result.ok).toBe(false);
    // Nothing persisted.
    expect(await getAgentNumber(env, agentId)).toBeNull();
  });

  it("returns { ok: false, status: 400 } when the purchase fails (no throw)", async () => {
    const agentId = await seedAgent();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("AvailablePhoneNumbers")) {
          return Promise.resolve(
            json({ available_phone_numbers: [{ phone_number: CANDIDATE }] }),
          );
        }
        if (url.includes("IncomingPhoneNumbers")) {
          return Promise.resolve(new Response("bad request", { status: 400 }));
        }
        return Promise.resolve(json({}));
      },
    );

    const result = await provisionAgentNumber(env, { agentId });
    expect(result).toMatchObject({ ok: false, status: 400 });
    // A failed purchase persists nothing.
    expect(await getAgentNumber(env, agentId)).toBeNull();
  });
});
