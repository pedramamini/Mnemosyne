import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import type { AgentResponse } from "../src/agents/schemas.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount } from "../src/db/index.ts";
import worker from "../src/index.ts";
import { SandboxClient } from "../src/sandbox/client.ts";
import { makeStubSandbox } from "./stub-sandbox.ts";

// MNEMO-09/10/11/12 HTTP surface. The brain DO methods are unit-tested directly
// elsewhere (memory-write / brain-explorer / brain-versioning / graph-index);
// THIS suite proves the src/index.ts route layer that fronts them - auth, the
// per-route ownership 404 (no existence leak), Zod boundary validation, and the
// no-sandbox read happy-paths - none of which any other suite drives over HTTP.

const BASE = "https://mnemosyne.test";

async function authed(): Promise<{ accountId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `brain-${crypto.randomUUID()}@example.com`,
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

async function createAgentFor(cookie: string): Promise<string> {
  const res = await call("POST", "/agents", {
    cookie,
    body: { name: "Brain host" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as AgentResponse).id;
}

let owner: { accountId: string; cookie: string };
let intruder: { accountId: string; cookie: string };
let agentId: string;

beforeAll(async () => {
  owner = await authed();
  intruder = await authed();
  agentId = await createAgentFor(owner.cookie);
});

describe("brain routes - auth + ownership", () => {
  // One representative route proves the `/agents/:agentId/*` requireAuth wildcard.
  it("401s a brain route with no session cookie", async () => {
    expect((await call("GET", `/agents/${agentId}/brain/size`)).status).toBe(
      401,
    );
  });

  // Every brain route runs the same getAgentOwned → 404 guard. A logged-in
  // stranger must get 404 (NOT 403 - no existence leak) on each verb+path.
  it("404s every brain route for a non-owned agent", async () => {
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "brain/size"],
      ["GET", "brain/graph?start=root"],
      ["GET", "brain/search?q=x"],
      ["GET", "brain/files"],
      ["GET", "brain/file?path=brain/notes/x.md"],
      ["PUT", "brain/file", { path: "brain/notes/x.md", content: "x" }],
      ["DELETE", "brain/file?path=brain/notes/x.md"],
      ["GET", "brain/archive"],
      ["GET", "brain/history"],
      ["GET", "brain/history/file?path=brain/notes/x.md"],
      ["GET", "brain/diff?sha=abcdef"],
      ["GET", "brain/file-at?path=brain/notes/x.md&sha=abcdef"],
      ["POST", "brain/restore", { sha: "abcdef" }],
      ["POST", "brain/notes", { slug: "x", content: "y" }],
      ["PATCH", "brain/notes/x", { content: "y" }],
      ["DELETE", "brain/notes/x"],
      ["POST", "brain/consolidate"],
      ["POST", "brain/commit"],
      ["POST", "sandbox/run", { cmd: "echo hi" }],
    ];
    for (const [method, sub, body] of cases) {
      const res = await call(method, `/agents/${agentId}/${sub}`, {
        cookie: intruder.cookie,
        body,
      });
      expect(res.status, `${method} ${sub}`).toBe(404);
    }
  });
});

describe("brain routes - read happy paths (no sandbox warm)", () => {
  it("GET /brain/size returns the (empty) brain-size metric", async () => {
    const res = await call("GET", `/agents/${agentId}/brain/size`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const size = (await res.json()) as { neurons: number; synapses: number };
    expect(size.neurons).toBe(0);
    expect(size.synapses).toBe(0);
  });

  it("GET /brain/graph with no start returns the whole (empty) brain", async () => {
    // No `start` → whole-graph mode (not a 400). A fresh brain yields empty
    // arrays, but the route still answers 200 without warming the sandbox.
    const res = await call("GET", `/agents/${agentId}/brain/graph`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const graph = (await res.json()) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it("GET /brain/graph traverses from a start slug, clamping depth to the cap", async () => {
    // depth=999 is clamped to GRAPH_CAPS.maxDepth server-side; an unknown start
    // yields an empty subgraph but the route still answers 200.
    const res = await call(
      "GET",
      `/agents/${agentId}/brain/graph?start=root&depth=999`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(200);
    const graph = (await res.json()) as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  it("GET /brain/search returns index hits (empty on a fresh brain)", async () => {
    const res = await call(
      "GET",
      `/agents/${agentId}/brain/search?q=anything&limit=5`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("brain routes - boundary validation (400 before the DO)", () => {
  // Each asserts the Zod boundary guard returns 400 on its own owned agent, so
  // the failure is validation (not ownership). Covers the safeParse branches the
  // canonical in-DO guards would otherwise only reject at 500-across-RPC.
  const bad: Array<[string, string, unknown?]> = [
    ["GET", "brain/graph?start="], // present-but-empty start (whole-graph is `start` ABSENT)
    ["GET", "brain/search"], // missing required `q`
    ["GET", "brain/file"], // missing required `path`
    ["DELETE", "brain/file"], // missing required `path`
    ["GET", "brain/files?path=../escape"], // traversal in optional path
    ["GET", "brain/file?path=brain/notes/..%2Fx"], // traversal segment
    ["PUT", "brain/file", { path: "ok/x.md" }], // missing content
    ["GET", "brain/archive?format=rar"], // bad enum
    ["GET", "brain/history?cursor="], // empty cursor fails min(1)
    ["GET", "brain/history/file"], // missing required `path`
    ["GET", "brain/diff"], // neither sha nor path/from
    ["GET", "brain/diff?sha=abcd&path=brain/x.md&from=HEAD"], // both modes
    ["GET", "brain/diff?sha=zzzz"], // non-hex sha
    ["GET", "brain/file-at?path=brain/x.md"], // missing sha
    ["POST", "brain/restore", { path: "brain/x.md" }], // missing sha
    ["POST", "brain/notes", { slug: "x" }], // missing content
    ["POST", "brain/notes", { slug: "/abs", content: "y" }], // bad slug
    ["PATCH", "brain/notes/x", {}], // empty append content
    ["PATCH", "brain/notes/x%5Cbad", { content: "y" }], // backslash slug
    ["DELETE", "brain/notes/x%5Cbad"], // backslash slug
  ];
  for (const [method, sub, body] of bad) {
    it(`400s ${method} ${sub}`, async () => {
      const res = await call(method, `/agents/${agentId}/${sub}`, {
        cookie: owner.cookie,
        body,
      });
      expect(res.status).toBe(400);
    });
  }
});

describe("sandbox-run smoke route - validation", () => {
  it("400s a missing cmd", async () => {
    const res = await call("POST", `/agents/${agentId}/sandbox/run`, {
      cookie: owner.cookie,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("400s an over-long cmd", async () => {
    const res = await call("POST", `/agents/${agentId}/sandbox/run`, {
      cookie: owner.cookie,
      body: { cmd: "x".repeat(4097) },
    });
    expect(res.status).toBe(400);
  });
});

describe("brain write/read routes - sandbox-mediated happy paths", () => {
  // The write pipeline + sandbox-warming reads need a container. Inject the
  // recording stub onto the live DO instance (the same id src/index.ts resolves),
  // then drive the real HTTP routes so their DO-call + response lines execute.
  async function withStubSandbox(): Promise<void> {
    const stub = makeStubSandbox();
    // git/ls plumbing the write + explorer pipelines shell out to.
    stub.onRun("rev-parse", { stdout: "main\n" });
    stub.setDefaultRead("");
    const client = new SandboxClient(stub);
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = client;
      },
    );
  }

  it("POST /brain/notes writes a note (201)", async () => {
    await withStubSandbox();
    const res = await call("POST", `/agents/${agentId}/brain/notes`, {
      cookie: owner.cookie,
      body: { slug: "first-note", title: "First", content: "# Hello\n" },
    });
    expect(res.status).toBe(201);
  });

  it("GET /brain/files lists the tree (200)", async () => {
    await withStubSandbox();
    const res = await call("GET", `/agents/${agentId}/brain/files`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
  });

  it("POST /brain/consolidate previews by default (200)", async () => {
    await withStubSandbox();
    const res = await call("POST", `/agents/${agentId}/brain/consolidate`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
  });
});
