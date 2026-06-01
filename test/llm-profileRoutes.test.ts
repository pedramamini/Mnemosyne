import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/llm/types.ts";

const BASE = "https://mnemosyne.test";

interface ProfileResponse {
  provider: string;
  model: string;
  hasKey: boolean;
  // Present only if the route leaked it - asserted absent.
  key?: unknown;
}

// Seed an account + KV session, returning the Cookie header - same primitives as
// MNEMO-03, exercising the real requireAuth path (mirrors agents-routes.test.ts).
async function authed(): Promise<{ accountId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `llm-routes-${crypto.randomUUID()}@example.com`,
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

describe("LLM profile routes", () => {
  it("GET returns the workers-ai default with hasKey:false for a fresh account", async () => {
    const { cookie } = await authed();
    const res = await call("GET", "/api/llm-profile", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileResponse;
    expect(body.provider).toBe("workers-ai");
    expect(body.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(body.hasKey).toBe(false);
    expect(body.key).toBeUndefined();
  });

  it("PUT a valid openrouter BYOK config, then GET reflects it with hasKey:true and no key", async () => {
    const { cookie } = await authed();

    const putRes = await call("PUT", "/api/llm-profile", {
      cookie,
      body: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        key: "sk-or-secret-value",
      },
    });
    expect(putRes.status).toBe(200);
    const put = (await putRes.json()) as ProfileResponse;
    expect(put.provider).toBe("openrouter");
    expect(put.model).toBe("anthropic/claude-sonnet-4.5");
    expect(put.hasKey).toBe(true);
    expect(put.key).toBeUndefined();

    const getRes = await call("GET", "/api/llm-profile", { cookie });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as ProfileResponse;
    expect(got.provider).toBe("openrouter");
    expect(got.model).toBe("anthropic/claude-sonnet-4.5");
    expect(got.hasKey).toBe(true);
    // The raw key must never round-trip back to the client.
    expect(got.key).toBeUndefined();
    expect(JSON.stringify(got)).not.toContain("sk-or-secret-value");
  });

  it("PUT { provider: workers-ai } resets to the free default", async () => {
    const { cookie } = await authed();
    // First set a BYOK profile…
    await call("PUT", "/api/llm-profile", {
      cookie,
      body: { provider: "openai", model: "gpt-4o", key: "sk-secret" },
    });
    // …then reset it.
    const resetRes = await call("PUT", "/api/llm-profile", {
      cookie,
      body: { provider: "workers-ai" },
    });
    expect(resetRes.status).toBe(200);
    const reset = (await resetRes.json()) as ProfileResponse;
    expect(reset.provider).toBe("workers-ai");
    expect(reset.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(reset.hasKey).toBe(false);

    const got = (await (
      await call("GET", "/api/llm-profile", { cookie })
    ).json()) as ProfileResponse;
    expect(got.provider).toBe("workers-ai");
    expect(got.hasKey).toBe(false);
  });

  it("400s a body with an invalid provider enum", async () => {
    const { cookie } = await authed();
    const res = await call("PUT", "/api/llm-profile", {
      cookie,
      body: { provider: "gemini", model: "gemini-pro", key: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("401s an unauthenticated request", async () => {
    expect((await call("GET", "/api/llm-profile")).status).toBe(401);
    expect(
      (
        await call("PUT", "/api/llm-profile", {
          body: { provider: "workers-ai" },
        })
      ).status,
    ).toBe(401);
  });
});
