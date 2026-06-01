import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditLog } from "../src/audit/index.ts";
import type { AuditEvent, AuditInput } from "../src/audit/types.ts";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import worker from "../src/index.ts";

// MNEMO-22: the live SSE tail through the full worker - content type, a live
// frame whose `id:` is the event `seq`, reconnect backfill (Last-Event-ID /
// ?sinceSeq → the missed gap arrives first, exclusive of the cursor, before any
// live frame), and the `level` altitude filter (a milestone stream drops info).
// Open streams never close, so every reader is cancelled in afterEach and reads
// are bounded by a deadline so a test can't hang.

const BASE = "https://mnemosyne.test";

// An open SSE stream never closes on its own, so each test's reader + execution
// context is tracked and torn down here: cancel the reader first (which cancels
// the DO-side subscriber), THEN drain the context so the isolate exits cleanly.
const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];
const openContexts: ExecutionContext[] = [];
afterEach(async () => {
  for (const reader of openReaders.splice(0)) {
    await reader.cancel().catch(() => {});
  }
  for (const ctx of openContexts.splice(0)) {
    await waitOnExecutionContext(ctx).catch(() => {});
  }
});

async function ownedAgent(): Promise<{ agentId: string; cookie: string }> {
  const account = await createAccount(env, {
    email: `stream-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Stream subject",
  });
  const sessionId = await createSession(env, account.id);
  return { agentId: agent.id, cookie: `${SESSION_COOKIE}=${sessionId}` };
}

/** Emit events into the agent's AuditLog DO; return them (with assigned seq). */
async function emit(
  agentId: string,
  inputs: AuditInput[],
): Promise<AuditEvent[]> {
  const stub = env.AUDIT.get(env.AUDIT.idFromName(agentId));
  return runInDurableObject(stub, (audit: AuditLog) =>
    inputs.map((input) => audit.emit(input)),
  );
}

/** Open the SSE stream through the worker. NOT awaited on the execution context
 * (the stream stays open), so the caller reads the body directly. */
async function openStream(
  agentId: string,
  cookie: string,
  opts: { query?: string; lastEventId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: cookie };
  if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
  const req = new Request(
    `${BASE}/agents/${agentId}/audit/stream${opts.query ?? ""}`,
    { method: "GET", headers },
  );
  const ctx = createExecutionContext();
  openContexts.push(ctx);
  return worker.fetch(req, env, ctx);
}

/** Read raw chunks until `count` complete SSE frames (`\n\n`-terminated) are
 * buffered or the deadline passes; return the parsed frames. Tolerant of the
 * transport batching several frames into one chunk. */
async function collectFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  ms = 3000,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let buffer = "";
  const complete = () => (buffer.match(/\n\n/g) ?? []).length;

  while (complete() < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), remaining),
    );
    const next = reader
      .read()
      .then(({ value, done }) =>
        done || !value ? null : decoder.decode(value),
      )
      .catch(() => null);
    const chunk = await Promise.race([next, timeout]);
    if (chunk == null) break;
    buffer += chunk;
  }
  return buffer.split("\n\n").filter((frame) => frame.trim().length > 0);
}

function reader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  const r = (res.body as ReadableStream<Uint8Array>).getReader();
  openReaders.push(r);
  return r;
}

describe("audit stream - live tail", () => {
  it("opens a text/event-stream and delivers a live frame keyed by seq", async () => {
    const { agentId, cookie } = await ownedAgent();
    const res = await openStream(agentId, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const r = reader(res);
    const [event] = await emit(agentId, [
      { type: "memory.wrote", level: "milestone", text: "wrote acme.md" },
    ]);
    const frames = await collectFrames(r, 1);
    expect(frames.length).toBe(1);
    expect(frames[0].startsWith(`id: ${event.seq}\n`)).toBe(true);
    expect(frames[0]).toContain("wrote acme.md");
  });
});

describe("audit stream - reconnect backfill", () => {
  it("backfills the missed gap (exclusive of the cursor) before resuming live", async () => {
    const { agentId, cookie } = await ownedAgent();
    // Three events happen BEFORE the (re)connect: seq 1, 2, 3.
    const seeded = await emit(
      agentId,
      [0, 1, 2].map((i) => ({
        type: "memory.wrote" as const,
        level: "milestone" as const,
        text: `before ${i}`,
      })),
    );
    const cursor = seeded[0].seq; // reconnect having last seen seq 1

    // Reconnect with Last-Event-ID: 1 → backfill must be seq 2 then seq 3.
    const res = await openStream(agentId, cookie, {
      lastEventId: String(cursor),
    });
    const r = reader(res);

    // A new live event after the reconnect: seq 4.
    const [live] = await emit(agentId, [
      { type: "memory.wrote", level: "milestone", text: "after reconnect" },
    ]);

    const frames = await collectFrames(r, 3);
    const seqs = frames.map((f) => Number(f.match(/^id: (\d+)/)?.[1]));
    expect(seqs).toEqual([cursor + 1, cursor + 2, live.seq]); // 2, 3, 4
    expect(seqs).not.toContain(cursor); // the cursor event is excluded
    expect(frames[0]).toContain("before 1");
    expect(frames[2]).toContain("after reconnect");
  });

  it("accepts the cursor via ?sinceSeq= as well", async () => {
    const { agentId, cookie } = await ownedAgent();
    const seeded = await emit(
      agentId,
      [0, 1, 2].map((i) => ({
        type: "memory.wrote" as const,
        level: "milestone" as const,
        text: `e${i}`,
      })),
    );
    const cursor = seeded[1].seq; // last seen seq 2

    const res = await openStream(agentId, cookie, {
      query: `?sinceSeq=${cursor}`,
    });
    const frames = await collectFrames(reader(res), 1);
    const seqs = frames.map((f) => Number(f.match(/^id: (\d+)/)?.[1]));
    expect(seqs).toEqual([cursor + 1]); // only seq 3
  });
});

describe("audit stream - altitude filter", () => {
  it("a milestone stream drops info events", async () => {
    const { agentId, cookie } = await ownedAgent();
    const res = await openStream(agentId, cookie, {
      query: "?level=milestone",
    });
    const r = reader(res);

    // The info event must be filtered out; the milestone event must arrive - so
    // the first (and only) frame is the milestone, never the info detail.
    await emit(agentId, [
      { type: "narration", level: "info", text: "info detail" },
      { type: "memory.wrote", level: "milestone", text: "milestone headline" },
    ]);

    const frames = await collectFrames(r, 1);
    expect(frames.length).toBe(1);
    expect(frames[0]).toContain("milestone headline");
    expect(frames[0]).not.toContain("info detail");
  });

  it("a level=all stream carries every altitude (Show the work)", async () => {
    const { agentId, cookie } = await ownedAgent();
    const res = await openStream(agentId, cookie, { query: "?level=all" });
    const r = reader(res);

    // Both the info detail AND the milestone headline must arrive - `all` opts
    // out of the altitude filter, so nothing is dropped.
    await emit(agentId, [
      { type: "narration", level: "info", text: "info detail" },
      { type: "memory.wrote", level: "milestone", text: "milestone headline" },
    ]);

    const frames = await collectFrames(r, 2);
    expect(frames.length).toBe(2);
    const joined = frames.join("\n");
    expect(joined).toContain("info detail");
    expect(joined).toContain("milestone headline");
  });
});
