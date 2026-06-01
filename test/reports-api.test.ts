import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { archiveReport, type ReportRecord } from "../src/reports/archive.ts";
import type { GeneratedReport } from "../src/reports/types.ts";

// MNEMO-25: the HTTP retrieval surface. These drive the FULL worker (requireAuth +
// ownership guard + the reports route group). We seed an archived report straight
// through archiveReport (R2 + D1), then assert the list / markdown / asset reads,
// the traversal guard, and the missing/non-owning 404s.

const BASE = "https://mnemosyne.test";
const ASSET_FILE = "funding-by-year.png";
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
const MARKDOWN = "---\ntitle: Acme Review\n---\n\n# Acme Review\n\nBody.\n";

function fakeGenerated(agentId: string): GeneratedReport {
  return {
    markdown: MARKDOWN,
    frontMatter: {
      title: "Acme Review",
      type: "report",
      agentId,
      tags: ["vendor"],
      created: "2026-05-24T12:00:00.000Z",
    },
    brainPath: "/brain/reports/acme-review-1.md",
    assets: [
      {
        path: `/brain/reports/assets/${ASSET_FILE}`,
        bytes: PNG_BYTES,
        title: "Funding",
      },
    ],
  };
}

/** Seed account + owned agent + session + ONE archived report. */
async function seeded(): Promise<{
  agentId: string;
  cookie: string;
  record: ReportRecord;
}> {
  const account = await createAccount(env, {
    email: `report-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Report subject",
  });
  const sessionId = await createSession(env, account.id);
  const record = await archiveReport(env, agent.id, fakeGenerated(agent.id));
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

describe("reports API - list + retrieval", () => {
  it("lists report metadata for the owning account", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(`/agents/${agentId}/reports`, { cookie });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      id: string;
      title: string;
      created_at: string;
      front_matter: string | null;
    }>;
    const found = list.find((r) => r.id === record.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe("Acme Review");
    expect(found?.created_at).toBe(record.created_at);
    expect(JSON.parse(found?.front_matter as string).agentId).toBe(agentId);
  });

  it("returns the report markdown as text/markdown", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(`/agents/${agentId}/reports/${record.id}`, {
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await res.text()).toBe(MARKDOWN);
  });

  it("streams a PNG asset as image/png with the stored bytes", async () => {
    const { agentId, cookie, record } = await seeded();
    const res = await call(
      `/agents/${agentId}/reports/${record.id}/assets/${ASSET_FILE}`,
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });
});

describe("reports API - guards", () => {
  it("rejects a traversal-y asset :file", async () => {
    const { agentId, cookie, record } = await seeded();
    // %2F keeps the traversal inside one path segment so it reaches the handler's
    // SAFE_ASSET_FILE guard (which rejects the `/` + non-.png shape) → 400.
    for (const bad of ["..%2Freport.md", "x%2F..%2F..%2Fy"]) {
      const res = await call(
        `/agents/${agentId}/reports/${record.id}/assets/${bad}`,
        { cookie },
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it("404s a missing report (both markdown and asset)", async () => {
    const { agentId, cookie } = await seeded();
    const missing = crypto.randomUUID();
    expect(
      (await call(`/agents/${agentId}/reports/${missing}`, { cookie })).status,
    ).toBe(404);
    expect(
      (
        await call(
          `/agents/${agentId}/reports/${missing}/assets/${ASSET_FILE}`,
          {
            cookie,
          },
        )
      ).status,
    ).toBe(404);
  });

  it("401s without a session", async () => {
    const { agentId, record } = await seeded();
    expect((await call(`/agents/${agentId}/reports`)).status).toBe(401);
    expect((await call(`/agents/${agentId}/reports/${record.id}`)).status).toBe(
      401,
    );
  });

  it("404s a non-owning account (no existence leak)", async () => {
    const { agentId, record } = await seeded();
    const cookie = await intruderCookie();
    expect((await call(`/agents/${agentId}/reports`, { cookie })).status).toBe(
      404,
    );
    expect(
      (await call(`/agents/${agentId}/reports/${record.id}`, { cookie }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          `/agents/${agentId}/reports/${record.id}/assets/${ASSET_FILE}`,
          { cookie },
        )
      ).status,
    ).toBe(404);
  });
});
