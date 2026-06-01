import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount } from "../src/db/index.ts";
import worker from "../src/index.ts";

const BASE = "https://mnemosyne.test";

// Drive GET /api/me through the full worker, optionally authenticated. Uses the
// same session primitives MNEMO-03 ships, so this exercises the real requireAuth
// path rather than stubbing it.
async function callMe(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  const req = new Request(`${BASE}/api/me`, { headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function putProfile(cookie: string, body: unknown): Promise<Response> {
  const req = new Request(`${BASE}/api/me/profile`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function authedAccount() {
  const email = `me-${crypto.randomUUID()}@example.com`;
  const account = await createAccount(env, { email });
  const cookie = `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
  return { account, email, cookie };
}

describe("GET /api/me (session probe)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callMe();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when the cookie names an unknown session", async () => {
    const res = await callMe(`${SESSION_COOKIE}=${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("returns the account id/email + an empty owner profile for a new account", async () => {
    const { account, email, cookie } = await authedAccount();
    const res = await callMe(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: account.id,
      email,
      profile: { timezone: null, name: null, notes: null },
    });
  });
});

describe("PUT /api/me/profile (owner profile)", () => {
  it("requires auth", async () => {
    const req = new Request(`${BASE}/api/me/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "America/Chicago" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("saves the profile and reflects it on the next GET /api/me", async () => {
    const { cookie } = await authedAccount();
    const put = await putProfile(cookie, {
      timezone: "America/Chicago",
      name: "Pedram",
      notes: "Direct, no fluff. Action over process.",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      profile: {
        timezone: "America/Chicago",
        name: "Pedram",
        notes: "Direct, no fluff. Action over process.",
      },
    });

    const me = (await (await callMe(cookie)).json()) as {
      profile: unknown;
    };
    expect(me.profile).toEqual({
      timezone: "America/Chicago",
      name: "Pedram",
      notes: "Direct, no fluff. Action over process.",
    });
  });

  it("merges a partial patch (omitted fields untouched) and clears with null", async () => {
    const { cookie } = await authedAccount();
    await putProfile(cookie, { timezone: "Europe/London", name: "Ada" });
    // Patch only notes - timezone/name must survive.
    await putProfile(cookie, { notes: "Prefers terse markdown." });
    let me = (await (await callMe(cookie)).json()) as { profile: unknown };
    expect(me.profile).toEqual({
      timezone: "Europe/London",
      name: "Ada",
      notes: "Prefers terse markdown.",
    });
    // Explicit null clears just that field.
    await putProfile(cookie, { name: null });
    me = (await (await callMe(cookie)).json()) as { profile: unknown };
    expect(me.profile).toEqual({
      timezone: "Europe/London",
      name: null,
      notes: "Prefers terse markdown.",
    });
  });

  it("rejects an invalid IANA timezone with 400", async () => {
    const { cookie } = await authedAccount();
    const res = await putProfile(cookie, { timezone: "Mars/Olympus_Mons" });
    expect(res.status).toBe(400);
  });
});
