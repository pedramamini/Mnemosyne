import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentResponse } from "../src/agents/schemas.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import {
  addToWhitelist,
  createAccount,
  createReport,
  listReportsByAgent,
  listWhitelist,
} from "../src/db/index.ts";
import worker from "../src/index.ts";

const BASE = "https://mnemosyne.test";

// Seed an account + KV session and hand back the Cookie header that
// authenticates it - the same primitives MNEMO-03 uses, so we exercise the real
// requireAuth path rather than stubbing it.
async function authed(): Promise<{ accountId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `agents-${crypto.randomUUID()}@example.com`,
  });
  const sessionId = await createSession(env, account.id);
  return { accountId: account.id, cookie: `${SESSION_COOKIE}=${sessionId}` };
}

// Drive a request through the worker with the execution-context dance.
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

describe("agent registry routes - happy path", () => {
  it("creates, lists, gets, and patches an agent, syncing the DO on create", async () => {
    const { cookie } = await authed();

    // POST /agents → 201 with an app-generated id.
    const createRes = await call("POST", "/agents", {
      cookie,
      body: {
        name: "Acme vendor watch",
        description: "Tracks Acme releases",
        template: "vendor",
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as AgentResponse;
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Acme vendor watch");
    expect(created.template).toBe("vendor");
    expect(created.status).toBe("active"); // DB default

    // D1↔DO sync: the always-home DO carries the seeded template before any
    // sandbox wake. Read it straight off the stub (the test DO helper path).
    const settings = await env.AGENT.get(
      env.AGENT.idFromName(created.id),
    ).getSettings();
    expect(settings.template).toBe("vendor");

    // GET /agents lists the new agent.
    const listRes = await call("GET", "/agents", { cookie });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as AgentResponse[];
    expect(list.some((a) => a.id === created.id)).toBe(true);

    // GET /agents/:id returns exactly the created row.
    const getRes = await call("GET", `/agents/${created.id}`, { cookie });
    expect(getRes.status).toBe(200);
    expect((await getRes.json()) as AgentResponse).toEqual(created);

    // PATCH /agents/:id updates description + template; response reflects it.
    const patchRes = await call("PATCH", `/agents/${created.id}`, {
      cookie,
      body: { description: "Now also tracks pricing", template: "product" },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as AgentResponse;
    expect(patched.description).toBe("Now also tracks pricing");
    expect(patched.template).toBe("product");
    expect(patched.id).toBe(created.id);

    // The PATCH also re-synced the DO settings.
    const after = await env.AGENT.get(
      env.AGENT.idFromName(created.id),
    ).getSettings();
    expect(after.template).toBe("product");
  });
});

describe("agent registry routes - ownership + validation", () => {
  it("401s every /agents route without a session", async () => {
    expect((await call("GET", "/agents")).status).toBe(401);
    expect(
      (await call("POST", "/agents", { body: { name: "x" } })).status,
    ).toBe(401);
    expect((await call("GET", `/agents/${crypto.randomUUID()}`)).status).toBe(
      401,
    );
    expect(
      (
        await call("PATCH", `/agents/${crypto.randomUUID()}`, {
          body: { name: "x" },
        })
      ).status,
    ).toBe(401);
  });

  it("404s (not 403) a GET/PATCH for another account's agent", async () => {
    const owner = await authed();
    const created = (await (
      await call("POST", "/agents", {
        cookie: owner.cookie,
        body: { name: "Owner's agent" },
      })
    ).json()) as AgentResponse;

    const intruder = await authed();
    const getRes = await call("GET", `/agents/${created.id}`, {
      cookie: intruder.cookie,
    });
    expect(getRes.status).toBe(404);

    const patchRes = await call("PATCH", `/agents/${created.id}`, {
      cookie: intruder.cookie,
      body: { description: "mine now" },
    });
    expect(patchRes.status).toBe(404);

    // The owner can still see the unmodified agent - the intruder changed nothing.
    const ownerGet = (await (
      await call("GET", `/agents/${created.id}`, { cookie: owner.cookie })
    ).json()) as AgentResponse;
    expect(ownerGet.description).toBeNull();
  });

  it("400s POST /agents with an empty name", async () => {
    const { cookie } = await authed();
    const res = await call("POST", "/agents", { cookie, body: { name: "" } });
    expect(res.status).toBe(400);
  });

  it("400s PATCH with an invalid template enum", async () => {
    const { cookie } = await authed();
    const created = (await (
      await call("POST", "/agents", { cookie, body: { name: "Valid" } })
    ).json()) as AgentResponse;

    const res = await call("PATCH", `/agents/${created.id}`, {
      cookie,
      body: { template: "not-a-template" },
    });
    expect(res.status).toBe(400);
  });

  it("400s PATCH with an empty patch body", async () => {
    const { cookie } = await authed();
    const created = (await (
      await call("POST", "/agents", { cookie, body: { name: "Valid" } })
    ).json()) as AgentResponse;

    const res = await call("PATCH", `/agents/${created.id}`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("agent registry routes - delete", () => {
  it("deletes an owned agent (204) and the agent then 404s", async () => {
    const { cookie } = await authed();
    const created = (await (
      await call("POST", "/agents", { cookie, body: { name: "Deletable" } })
    ).json()) as AgentResponse;

    const delRes = await call("DELETE", `/agents/${created.id}`, { cookie });
    expect(delRes.status).toBe(204);

    // The row is gone: GET 404s and the list no longer carries it.
    expect(
      (await call("GET", `/agents/${created.id}`, { cookie })).status,
    ).toBe(404);
    const list = (await (
      await call("GET", "/agents", { cookie })
    ).json()) as AgentResponse[];
    expect(list.some((a) => a.id === created.id)).toBe(false);
  });

  it("cascades to dependent D1 rows (reports, whitelist)", async () => {
    const { cookie } = await authed();
    const created = (await (
      await call("POST", "/agents", { cookie, body: { name: "Has deps" } })
    ).json()) as AgentResponse;

    // Seed dependent rows that reference the agent.
    await createReport(env, {
      agent_id: created.id,
      title: "R",
      r2_key: `agents/${created.id}/reports/x/`,
    });
    await addToWhitelist(env, created.id, "+15125550100");
    expect((await listReportsByAgent(env, created.id)).length).toBe(1);
    expect((await listWhitelist(env, created.id)).length).toBe(1);

    expect(
      (await call("DELETE", `/agents/${created.id}`, { cookie })).status,
    ).toBe(204);

    // The cascade cleared the dependents too.
    expect((await listReportsByAgent(env, created.id)).length).toBe(0);
    expect((await listWhitelist(env, created.id)).length).toBe(0);
  });

  it("detaches the usage_events ledger so a metered agent still deletes", async () => {
    const { accountId, cookie } = await authed();
    const created = (await (
      await call("POST", "/agents", { cookie, body: { name: "Metered" } })
    ).json()) as AgentResponse;

    // An append-only billing-ledger row attributed to this agent. Production D1
    // enforces its `agent_id -> agents(id)` FK, so a naive cascade that keeps
    // this row would fail the agents-row delete (regression: staging 500).
    const eventId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO usage_events
         (id, account_id, agent_id, kind, quantity, unit, cost_cents, period, created_at)
       VALUES (?, ?, ?, 'llm_tokens', 100, 'tokens', 0.5, '2026-05', '2026-05-29T00:00:00.000Z')`,
    )
      .bind(eventId, accountId, created.id)
      .run();

    expect(
      (await call("DELETE", `/agents/${created.id}`, { cookie })).status,
    ).toBe(204);

    // The agent is gone, but the ledger row SURVIVES with agent_id detached -
    // account_id + cost stay intact for account-level billing reconciliation.
    const row = await env.DB.prepare(
      "SELECT account_id, agent_id, cost_cents FROM usage_events WHERE id = ?",
    )
      .bind(eventId)
      .first<{
        account_id: string;
        agent_id: string | null;
        cost_cents: number;
      }>();
    expect(row).not.toBeNull();
    expect(row?.agent_id).toBeNull();
    expect(row?.account_id).toBe(accountId);
    expect(row?.cost_cents).toBe(0.5);
  });

  it("404s (not 403) a DELETE for another account's agent, leaving it intact", async () => {
    const owner = await authed();
    const created = (await (
      await call("POST", "/agents", {
        cookie: owner.cookie,
        body: { name: "Owner's agent" },
      })
    ).json()) as AgentResponse;

    const intruder = await authed();
    const delRes = await call("DELETE", `/agents/${created.id}`, {
      cookie: intruder.cookie,
    });
    expect(delRes.status).toBe(404);

    // The owner's agent is untouched.
    expect(
      (await call("GET", `/agents/${created.id}`, { cookie: owner.cookie }))
        .status,
    ).toBe(200);
  });

  it("401s DELETE without a session", async () => {
    expect(
      (await call("DELETE", `/agents/${crypto.randomUUID()}`)).status,
    ).toBe(401);
  });
});
