import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AuditLog } from "../src/audit/index.ts";
import type { AuditEvent, AuditInput } from "../src/audit/types.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";

// MNEMO-22: the HTTP surface of the glass cockpit. These tests drive the FULL
// worker (requireAuth + ownership guard + the audit route group) and assert the
// `/events` filter and `/search` endpoints pass the spike's `AuditQuery`/`search`
// semantics through faithfully - kept parallel to test/audit-store.test.ts. NB:
// the `level` altitude default is `milestone` (§6.7), so events that must be
// returned by an unfiltered/level-agnostic query are seeded at `milestone`.

const BASE = "https://mnemosyne.test";

/** Seed an account + an agent owned by it + a KV session; return cookie + id. */
async function ownedAgent(): Promise<{ agentId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `audit-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Audit subject",
  });
  const sessionId = await createSession(env, account.id);
  return { agentId: agent.id, cookie: `${SESSION_COOKIE}=${sessionId}` };
}

/** A second, unrelated authenticated account - the non-owning "intruder". */
async function intruderCookie(): Promise<string> {
  const account = await createAccount(env, {
    email: `intruder-${crypto.randomUUID()}@example.com`,
  });
  return `${SESSION_COOKIE}=${await createSession(env, account.id)}`;
}

/** Emit events into the agent's AuditLog DO; return them (with assigned seq/ts). */
async function seed(
  agentId: string,
  inputs: AuditInput[],
): Promise<AuditEvent[]> {
  const stub = env.AUDIT.get(env.AUDIT.idFromName(agentId));
  return runInDurableObject(stub, (audit: AuditLog) =>
    inputs.map((input) => audit.emit(input)),
  );
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

describe("audit API - /events filter", () => {
  it("filters by level (the milestone altitude vs. info detail)", async () => {
    const { agentId, cookie } = await ownedAgent();
    await seed(agentId, [
      { type: "narration", level: "info", text: "thinking out loud" },
      {
        type: "memory.wrote",
        level: "milestone",
        text: "wrote neuron acme.md",
      },
      {
        type: "memory.linked",
        level: "milestone",
        text: "linked acme.md -> funding.md",
      },
    ]);

    const milestones = (await (
      await call(`/agents/${agentId}/audit/events?level=milestone`, { cookie })
    ).json()) as AuditEvent[];
    expect(milestones.length).toBe(2);
    expect(milestones.every((e) => e.level === "milestone")).toBe(true);

    const info = (await (
      await call(`/agents/${agentId}/audit/events?level=info`, { cookie })
    ).json()) as AuditEvent[];
    expect(info.length).toBe(1);
    expect(info[0].type).toBe("narration");
  });

  it("level=all returns every altitude (the Show the work mode)", async () => {
    const { agentId, cookie } = await ownedAgent();
    await seed(agentId, [
      { type: "narration", level: "info", text: "thinking out loud" },
      { type: "memory.wrote", level: "milestone", text: "wrote acme.md" },
      { type: "error", level: "error", text: "fetch failed" },
    ]);

    const all = (await (
      await call(`/agents/${agentId}/audit/events?level=all`, { cookie })
    ).json()) as AuditEvent[];
    expect(all.length).toBe(3);
    expect(new Set(all.map((e) => e.level))).toEqual(
      new Set(["info", "milestone", "error"]),
    );
  });

  it("filters by type", async () => {
    const { agentId, cookie } = await ownedAgent();
    await seed(agentId, [
      { type: "source.read", level: "milestone", text: "read TechCrunch" },
      { type: "memory.wrote", level: "milestone", text: "wrote acme.md" },
    ]);

    const reads = (await (
      await call(`/agents/${agentId}/audit/events?type=source.read`, { cookie })
    ).json()) as AuditEvent[];
    expect(reads.length).toBe(1);
    expect(reads[0].type).toBe("source.read");
  });

  it("supports the sinceSeq cursor (returns only seq > N)", async () => {
    const { agentId, cookie } = await ownedAgent();
    const seeded = await seed(
      agentId,
      [0, 1, 2, 3].map((i) => ({
        type: "memory.wrote" as const,
        level: "milestone" as const,
        text: `step ${i}`,
      })),
    );
    const cursor = seeded[1].seq; // second event

    const tail = (await (
      await call(`/agents/${agentId}/audit/events?sinceSeq=${cursor}`, {
        cookie,
      })
    ).json()) as AuditEvent[];
    expect(tail.map((e) => e.seq)).toEqual([cursor + 1, cursor + 2]);
  });

  it("windows by time (fromTs/toTs)", async () => {
    const { agentId, cookie } = await ownedAgent();
    const seeded = await seed(agentId, [
      { type: "memory.wrote", level: "milestone", text: "first" },
      { type: "memory.wrote", level: "milestone", text: "second" },
    ]);

    const fromFirst = (await (
      await call(`/agents/${agentId}/audit/events?fromTs=${seeded[0].ts}`, {
        cookie,
      })
    ).json()) as AuditEvent[];
    expect(fromFirst.length).toBeGreaterThanOrEqual(1);

    const beforeEpoch = (await (
      await call(`/agents/${agentId}/audit/events?toTs=0`, { cookie })
    ).json()) as AuditEvent[];
    expect(beforeEpoch.length).toBe(0);
  });
});

describe("audit API - /search", () => {
  it("returns the matching event and an empty array for a miss", async () => {
    const { agentId, cookie } = await ownedAgent();
    await seed(agentId, [
      {
        type: "source.read",
        level: "milestone",
        text: "Acme raised a Series B led by Sequoia",
      },
      {
        type: "source.read",
        level: "milestone",
        text: "Globex shipped a new product",
      },
    ]);

    const hits = (await (
      await call(`/agents/${agentId}/audit/search?q=series`, { cookie })
    ).json()) as AuditEvent[];
    expect(hits.length).toBe(1);
    expect(hits[0].text).toMatch(/Series B/);

    const miss = (await (
      await call(`/agents/${agentId}/audit/search?q=nonexistentterm`, {
        cookie,
      })
    ).json()) as AuditEvent[];
    expect(miss.length).toBe(0);
  });

  it("400s an empty search term", async () => {
    const { agentId, cookie } = await ownedAgent();
    expect(
      (await call(`/agents/${agentId}/audit/search?q=`, { cookie })).status,
    ).toBe(400);
    expect(
      (await call(`/agents/${agentId}/audit/search`, { cookie })).status,
    ).toBe(400);
  });
});

describe("audit API - input hardening + ownership", () => {
  it("400s an unknown type or level", async () => {
    const { agentId, cookie } = await ownedAgent();
    expect(
      (
        await call(`/agents/${agentId}/audit/events?type=bogus.type`, {
          cookie,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(`/agents/${agentId}/audit/events?level=loud`, { cookie }))
        .status,
    ).toBe(400);
  });

  it("401s without a session", async () => {
    const { agentId } = await ownedAgent();
    expect((await call(`/agents/${agentId}/audit/events`)).status).toBe(401);
    expect((await call(`/agents/${agentId}/audit/search?q=x`)).status).toBe(
      401,
    );
  });

  it("404s a request from a non-owning account (no existence leak)", async () => {
    const { agentId } = await ownedAgent();
    const cookie = await intruderCookie();
    expect(
      (await call(`/agents/${agentId}/audit/events`, { cookie })).status,
    ).toBe(404);
    expect(
      (await call(`/agents/${agentId}/audit/search?q=x`, { cookie })).status,
    ).toBe(404);
  });
});
