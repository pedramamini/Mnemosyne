import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  createAccount,
  createAgent,
  SHARED_BRAND_ID,
  updateBrand,
} from "../src/db/index.ts";
import worker from "../src/index.ts";
import {
  ensureBrand,
  ensureCampaign,
  getA2pStatus,
} from "../src/messaging/a2p.ts";

// MNEMO-47: A2P 10DLC orchestration + the enable route (PRD §9.1/§9.2). Runs in the
// workers pool: D1 `DB` is real; the Twilio Trust Hub / Messaging A2P + number
// search/purchase calls are stubbed at globalThis.fetch. The shared brand/campaign
// are a SINGLETON in D1, so each test resets the a2p tables for isolation.

const CANDIDATE = "+15005559876";
const BASE = "https://mnemosyne.test";

/** A fresh Response per call (body is single-use). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Route a stubbed Twilio call by URL. Order matters: the specific number resources
 * (`AvailablePhoneNumbers`/`IncomingPhoneNumbers` both contain "PhoneNumbers") are
 * matched before the campaign-attach (`/Campaigns/<sid>/PhoneNumbers`).
 */
function twilioRouter(input: RequestInfo | URL): Promise<Response> {
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
  if (url.includes("BrandRegistrations")) {
    return Promise.resolve(json({ sid: "BN_test" }, 201));
  }
  if (url.includes("Campaigns") && url.includes("PhoneNumbers")) {
    return Promise.resolve(json({}, 201)); // campaign attach
  }
  if (url.includes("Campaigns")) {
    return Promise.resolve(json({ sid: "CMP_test" }, 201)); // campaign create
  }
  return Promise.resolve(json({}));
}

/** The shared brand/campaign are a singleton - reset for per-test isolation. */
async function resetA2p(): Promise<void> {
  await env.DB.prepare("DELETE FROM a2p_campaign").run();
  await env.DB.prepare("DELETE FROM a2p_brand").run();
}

beforeEach(resetA2p);
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureBrand / ensureCampaign (PRD §9.1)", () => {
  it("submits a pending brand and records the SID (pending → submitted)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(twilioRouter);
    const brand = await ensureBrand(env);
    expect(brand.status).toBe("submitted");
    expect(brand.twilio_brand_sid).toBe("BN_test");
  });

  it("is idempotent when the brand is already approved (no re-submit)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(twilioRouter);
    await ensureBrand(env); // pending → submitted
    await updateBrand(env, SHARED_BRAND_ID, { status: "approved" });
    spy.mockClear();

    const again = await ensureBrand(env);
    expect(again.status).toBe("approved");
    // No brand-registration call was made for an already-approved brand.
    expect(
      spy.mock.calls.filter(([u]) => String(u).includes("BrandRegistrations")),
    ).toHaveLength(0);
  });

  it("ensureCampaign requires an APPROVED brand (null until then, submitted after)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(twilioRouter);
    await ensureBrand(env); // brand submitted, NOT approved

    // Brand not approved yet → no campaign is created.
    expect(await ensureCampaign(env)).toBeNull();

    // Approve the brand (simulating carrier approval) → campaign submits.
    await updateBrand(env, SHARED_BRAND_ID, { status: "approved" });
    const campaign = await ensureCampaign(env);
    expect(campaign?.status).toBe("submitted");
    expect(campaign?.twilio_campaign_sid).toBe("CMP_test");
  });

  it("getA2pStatus reflects the current shared state", async () => {
    // Fresh: nothing registered.
    expect(await getA2pStatus(env)).toEqual({ brand: null, campaign: null });

    vi.spyOn(globalThis, "fetch").mockImplementation(twilioRouter);
    await ensureBrand(env);
    const status = await getA2pStatus(env);
    expect(status.brand?.status).toBe("submitted");
    expect(status.campaign).toBeNull();
  });
});

describe("POST /agents/:agentId/messaging/enable (PRD §9.1)", () => {
  async function seedAuthedAgent(): Promise<{
    agentId: string;
    cookie: string;
  }> {
    const account = await createAccount(env, {
      email: `a2p-${crypto.randomUUID()}@example.com`,
    });
    const agent = await createAgent(env, {
      account_id: account.id,
      name: "A2P agent",
    });
    const sessionId = await createSession(env, account.id);
    return { agentId: agent.id, cookie: `${SESSION_COOKIE}=${sessionId}` };
  }

  async function postEnable(
    agentId: string,
    cookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cookie) headers.Cookie = cookie;
    const req = new Request(`${BASE}/agents/${agentId}/messaging/enable`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("401s an unauthenticated request", async () => {
    const res = await postEnable("any-agent-id");
    expect(res.status).toBe(401);
  });

  it("409s when the shared 10DLC registration is not ready", async () => {
    const { agentId, cookie } = await seedAuthedAgent();
    const res = await postEnable(agentId, cookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("10DLC onboarding incomplete");
  });

  it("provisions a number and returns the e164 when 10DLC is ready", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(twilioRouter);
    // Drive the shared registration to ready: brand approved + campaign submitted.
    await ensureBrand(env);
    await updateBrand(env, SHARED_BRAND_ID, { status: "approved" });
    await ensureCampaign(env);

    const { agentId, cookie } = await seedAuthedAgent();
    const res = await postEnable(agentId, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { e164: string };
    expect(body.e164).toBe(CANDIDATE);
  });
});
