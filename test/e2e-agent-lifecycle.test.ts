import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import type { AgentResponse } from "../src/agents/schemas.ts";
import type { AuditEvent } from "../src/audit/types.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { generateModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// END-TO-END spine. The per-subsystem suites prove each stage in isolation
// (discovery-do, build-do, agent-headless, audit-api, graph-index, …). THIS
// suite proves the stages WIRE TOGETHER for one real agent, threaded through the
// real worker + real Durable Objects: create → build (provision + go live) → a
// research run → and that the run's trail + the built brain read back over the
// owner-scoped HTTP surfaces (and stay invisible to a non-owner). Only the two
// things the Workers pool genuinely cannot host - the LLM and the sandbox
// container - are mocked (testModelOverride / testSandboxOverride), exactly as
// the unit suites do; everything else is the production code path.

const BASE = "https://mnemosyne.test";
const RUN_SESSION = "e2e-run-1";

/** A finalized Discovery spec, so Build's spec-gate passes (mirrors build-do.test). */
const VALID_SPEC: DiscoverySpec = {
  name: "Acme Watcher",
  description: "Track Acme Corp's product and security news.",
  subject: "Acme Corp, the SaaS vendor",
  entityType: "vendor",
  sources: ["acme.example/blog", "security advisories"],
  cadence: "weekly on Mondays",
  outputFormat: "a short markdown brief, newest changes first",
  confidence: 0.92,
  facetNotes: {
    subject: "Acme Corp specifically.",
    entityType: "A vendor.",
    sources: "Blog + advisories.",
    cadence: "Weekly.",
    outputFormat: "Brief, change-led.",
  },
  finalizedAt: "2026-05-25T00:00:00.000Z",
};

async function authed(
  prefix: string,
): Promise<{ accountId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `${prefix}-${crypto.randomUUID()}@example.com`,
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

let owner: { accountId: string; cookie: string };
let intruder: { accountId: string; cookie: string };
let agentId: string;
let buildPhase: string;
let runFinishReason: string;

beforeAll(async () => {
  owner = await authed("e2e-owner");
  intruder = await authed("e2e-intruder");

  // 1) Create the agent over HTTP (the MNEMO-05 registry path).
  const created = (await (
    await call("POST", "/agents", {
      cookie: owner.cookie,
      body: { name: "Acme Watcher", template: "vendor" },
    })
  ).json()) as AgentResponse;
  agentId = created.id;

  const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

  // 2) Finalize Discovery + Build (provision the brain FS, assemble the prompt,
  //    enable tools, promote the D1 row to operational). The sandbox is stubbed -
  //    the workers pool can't boot a container - but the build code path is real.
  buildPhase = await runInDurableObject(stub, async (a: MnemosyneAgent) => {
    a.testSandboxOverride = stubSandboxClient().client;
    a.completeDiscovery(VALID_SPEC);
    return (await a.build()).phase;
  });

  // 3) Run one research pass through the REAL agentic loop (mock model so it's
  //    hermetic). It emits session.started/completed into the AuditLog DO under
  //    RUN_SESSION - the same DO the cockpit HTTP API reads.
  runFinishReason = await runInDurableObject(
    stub,
    async (a: MnemosyneAgent) => {
      a.testModelOverride = generateModel(
        "Reviewed Acme. Nothing material today.",
      );
      a.testSandboxOverride = stubSandboxClient().client;
      const r = await a.runHeadless({
        prompt: "Do a research pass on Acme.",
        sessionId: RUN_SESSION,
      });
      return r.finishReason;
    },
  );
});

describe("E2E - create → build → operational", () => {
  it("built the agent and promoted the D1 registry row to operational", async () => {
    expect(buildPhase).toBe("ready");

    // Build status reads back ready over HTTP.
    const build = (await (
      await call("GET", `/agents/${agentId}/build`, { cookie: owner.cookie })
    ).json()) as { phase: string };
    expect(build.phase).toBe("ready");

    // The registry row is live + carries the discovered template.
    const agent = (await (
      await call("GET", `/agents/${agentId}`, { cookie: owner.cookie })
    ).json()) as AgentResponse;
    expect(agent.status).toBe("operational");
    expect(agent.template).toBe("vendor");
    expect(agent.system_prompt).toBeTruthy();
  });
});

describe("E2E - a research run's trail reads back over the cockpit", () => {
  it("the loop finished and emitted a session-scoped audit trail", async () => {
    expect(runFinishReason).toBe("stop");

    const events = (await (
      await call(
        "GET",
        `/agents/${agentId}/audit/events?level=all&sessionId=${RUN_SESSION}`,
        { cookie: owner.cookie },
      )
    ).json()) as AuditEvent[];

    // session.started + session.completed both landed, all tagged to this run.
    const types = events.map((e) => e.type);
    expect(types).toContain("session.started");
    expect(types).toContain("session.completed");
    expect(events.every((e) => e.sessionId === RUN_SESSION)).toBe(true);
  });

  it("the started/completed pair is searchable by its human summary (FTS)", async () => {
    const hits = (await (
      await call("GET", `/agents/${agentId}/audit/search?q=research`, {
        cookie: owner.cookie,
      })
    ).json()) as AuditEvent[];
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E - the built brain is reachable over HTTP", () => {
  it("brain-size answers from the DO index (provisioned, no sandbox warm)", async () => {
    const res = await call("GET", `/agents/${agentId}/brain/size`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const size = (await res.json()) as { neurons: number; synapses: number };
    expect(typeof size.neurons).toBe("number");
    expect(typeof size.synapses).toBe("number");
  });
});

describe("E2E - ownership holds across every surface of a real agent", () => {
  it("404s a non-owner on the registry, build, audit, and brain surfaces", async () => {
    const surfaces = [
      `/agents/${agentId}`,
      `/agents/${agentId}/build`,
      `/agents/${agentId}/audit/events`,
      `/agents/${agentId}/brain/size`,
    ];
    for (const path of surfaces) {
      const res = await call("GET", path, { cookie: intruder.cookie });
      expect(res.status, path).toBe(404);
    }
  });
});
