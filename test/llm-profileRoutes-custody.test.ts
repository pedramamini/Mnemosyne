import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, getLlmProfile } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { decryptKey } from "../src/llm/secrets.ts";

const BASE = "https://mnemosyne.test";

async function authed(): Promise<{ accountId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `custody-${crypto.randomUUID()}@example.com`,
  });
  const sessionId = await createSession(env, account.id);
  return { accountId: account.id, cookie: `${SESSION_COOKIE}=${sessionId}` };
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("BYOK key custody via routes", () => {
  it("PUT persists an ENCRYPTED key_ref (never the plaintext), GET hides it", async () => {
    const { accountId, cookie } = await authed();
    const RAW_KEY = "sk-or-custody-plaintext-secret";

    const putRes = await call("PUT", "/api/llm-profile", {
      cookie,
      body: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        key: RAW_KEY,
      },
    });
    expect(putRes.status).toBe(200);

    // The stored key_ref must be ciphertext, not the raw key - and must decrypt
    // back to it under the same master secret.
    const profile = await getLlmProfile(env, accountId);
    expect(profile?.key_ref).toBeTruthy();
    expect(profile?.key_ref).not.toBe(RAW_KEY);
    expect(JSON.stringify(profile)).not.toContain(RAW_KEY);
    expect(await decryptKey(env, profile?.key_ref ?? "")).toBe(RAW_KEY);

    // GET reports hasKey but never the key itself.
    const getRes = await call("GET", "/api/llm-profile", { cookie });
    const got = (await getRes.json()) as { hasKey: boolean; key?: unknown };
    expect(got.hasKey).toBe(true);
    expect(got.key).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain(RAW_KEY);
  });

  it("PUT /api/llm-profile/spend-cap then GET /api/llm-spend reflects the cap", async () => {
    const { cookie } = await authed();

    const capRes = await call("PUT", "/api/llm-profile/spend-cap", {
      cookie,
      body: { usdMilli: 2500 },
    });
    expect(capRes.status).toBe(200);
    const cap = (await capRes.json()) as { spendCapUsdMilli: number };
    expect(cap.spendCapUsdMilli).toBe(2500);

    const spendRes = await call("GET", "/api/llm-spend", { cookie });
    expect(spendRes.status).toBe(200);
    const spend = (await spendRes.json()) as {
      tokensIn: number;
      tokensOut: number;
      costUsdMilli: number;
      capUsdMilli: number;
      period: string;
    };
    expect(spend.capUsdMilli).toBe(2500);
    expect(spend.tokensIn).toBe(0);
    expect(spend.tokensOut).toBe(0);
    expect(spend.costUsdMilli).toBe(0);
    expect(spend.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("rejects an invalid spend-cap body (non-numeric usdMilli)", async () => {
    const { cookie } = await authed();
    const res = await call("PUT", "/api/llm-profile/spend-cap", {
      cookie,
      body: { usdMilli: "lots" },
    });
    expect(res.status).toBe(400);
  });

  it("401s unauthenticated custody + spend calls", async () => {
    expect((await call("GET", "/api/llm-spend")).status).toBe(401);
    expect(
      (
        await call("PUT", "/api/llm-profile/spend-cap", {
          body: { usdMilli: 1000 },
        })
      ).status,
    ).toBe(401);
  });
});
