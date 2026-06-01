import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type ArtifactRecord,
  archiveHtmlArtifact,
} from "../src/artifacts/store.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";

// The HTML artifact retrieval surface (renderHtml tool). Drives the FULL worker
// (requireAuth + ownership guard + the artifacts route group). We seed an artifact
// straight through archiveHtmlArtifact (R2 + D1), then assert the list / raw reads,
// the LOCKED-DOWN security headers on the raw HTML, and the missing/non-owning/
// unauthenticated cases. Mirrors reports-api.test.ts.

const BASE = "https://mnemosyne.test";
const HTML = "<!doctype html><html><body><p>artifact</p></body></html>";

/** Seed account + owned agent + session + ONE archived artifact. */
async function seeded(): Promise<{
  agentId: string;
  cookie: string;
  record: ArtifactRecord;
}> {
  const account = await createAccount(env, {
    email: `artifact-api-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Artifact subject",
  });
  const sessionId = await createSession(env, account.id);
  const record = await archiveHtmlArtifact(env, {
    agentId: agent.id,
    conversationId: "conv-1",
    title: "Acme Dashboard",
    html: HTML,
  });
  return {
    agentId: agent.id,
    cookie: `${SESSION_COOKIE}=${sessionId}`,
    record,
  };
}

/** A second, unrelated authenticated account - the non-owning "intruder". */
async function intruderCookie(): Promise<string> {
  const account = await createAccount(env, {
    email: `intruder-${crypto.randomUUID()}@example.com`,
  });
  return `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
}

async function call(
  path: string,
  opts: { cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  const req = new Request(`${BASE}${path}`, { method: "GET", headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("artifacts API - list + raw retrieval", () => {
  it("lists artifact metadata for the owning account", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(`/agents/${agentId}/artifacts`, { cookie });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      id: string;
      title: string;
      content_type: string;
      byte_size: number;
    }>;
    const found = list.find((a) => a.id === record.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe("Acme Dashboard");
    expect(found?.content_type).toBe("text/html; charset=utf-8");
  });

  it("returns the artifact HTML as text/html", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(`/agents/${agentId}/artifacts/${record.id}/raw`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toBe(HTML);
  });

  it("serves the raw HTML behind a locked-down sandbox CSP (no egress)", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(`/agents/${agentId}/artifacts/${record.id}/raw`, {
      cookie,
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    // The load-bearing pair: opaque-origin sandbox (no cookies/DOM) + no network.
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    // Type is pinned and the response is treated as private, uncached content.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("artifacts API - guards", () => {
  it("404s a missing artifact", async () => {
    const { agentId, cookie } = await seeded();
    const missing = crypto.randomUUID();
    expect(
      (await call(`/agents/${agentId}/artifacts/${missing}/raw`, { cookie }))
        .status,
    ).toBe(404);
  });

  it("401s without a session", async () => {
    const { agentId, record } = await seeded();
    expect((await call(`/agents/${agentId}/artifacts`)).status).toBe(401);
    expect(
      (await call(`/agents/${agentId}/artifacts/${record.id}/raw`)).status,
    ).toBe(401);
  });

  it("404s a non-owning account (no existence leak)", async () => {
    const { agentId, record } = await seeded();
    const cookie = await intruderCookie();
    expect(
      (await call(`/agents/${agentId}/artifacts`, { cookie })).status,
    ).toBe(404);
    expect(
      (await call(`/agents/${agentId}/artifacts/${record.id}/raw`, { cookie }))
        .status,
    ).toBe(404);
  });
});
