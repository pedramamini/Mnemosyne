import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, BackendAuditEvent } from "../audit";
import type { AuditStreamStatus } from "../auditStream";
import { openAuditStream } from "../auditStream";

/** Build a streaming Response whose body yields `chunks` then closes. */
function streamResponse(
  chunks: string[],
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): Response {
  const enc = new TextEncoder();
  return {
    ok,
    status,
    body: ok
      ? new ReadableStream({
          start(controller) {
            for (const ch of chunks) controller.enqueue(enc.encode(ch));
            controller.close();
          },
        })
      : null,
  } as unknown as Response;
}

/** A never-resolving body so a reconnect stays "live" without spamming further connects. */
function openStreamResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({ start() {} }),
  } as unknown as Response;
}

function backend(seq: number): BackendAuditEvent {
  return {
    seq,
    id: `e${seq}`,
    agentId: "a1",
    ts: 0,
    type: "tool.ran",
    level: "info",
    sessionId: "s1",
    text: `event ${seq}`,
    payload: { command: "ls" },
  };
}

function frame(ev: BackendAuditEvent): string {
  return `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

describe("openAuditStream", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let events: AuditEvent[];
  let statuses: AuditStreamStatus[];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    events = [];
    statuses = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("transitions connecting→live, maps each frame, then reconnects when the stream ends", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        ": keep-alive\n\n", // comment frame - ignored
        frame(backend(1)),
        frame(backend(2)),
      ]),
    );
    fetchMock.mockResolvedValue(openStreamResponse()); // the reconnect stays open

    const handle = openAuditStream(
      "a1",
      {},
      (e) => events.push(e),
      (s) => statuses.push(s),
    );

    await vi.waitFor(() => expect(statuses).toContain("reconnecting"));
    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("live");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    // toAuditEvent mapping applied (epoch→ISO, payload→detail)
    expect(events[0].ts).toBe("1970-01-01T00:00:00.000Z");
    expect(events[0].detail).toEqual({ command: "ls" });
    handle.close();
  });

  it("ignores keep-alive lines and tolerates a malformed-JSON frame", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse([`data: not valid json\n\n`, frame(backend(5))]),
    );
    fetchMock.mockResolvedValue(openStreamResponse());

    const handle = openAuditStream(
      "a1",
      {},
      (e) => events.push(e),
      (s) => statuses.push(s),
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].seq).toBe(5); // the bad frame produced no event
    handle.close();
  });

  it("puts sinceSeq + filters on the initial connect URL", async () => {
    fetchMock.mockResolvedValue(openStreamResponse());
    const handle = openAuditStream(
      "a1",
      {
        sinceSeq: 10,
        filters: { type: ["tool.ran", "error"], level: "all", sessionId: "s7" },
      },
      () => {},
      (s) => statuses.push(s),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/agents/a1/audit/stream?");
    expect(url).toContain("sinceSeq=10");
    expect(url).toContain("type=tool.ran");
    expect(url).toContain("type=error");
    expect(url).toContain("level=all");
    expect(url).toContain("sessionId=s7");
    // sends the session cookie + SSE Accept header
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
    handle.close();
  });

  it("reconnects resuming from the HIGHEST seq seen", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([frame(backend(7))]));
    fetchMock.mockResolvedValue(openStreamResponse());

    const handle = openAuditStream(
      "a1",
      {},
      (e) => events.push(e),
      (s) => statuses.push(s),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("sinceSeq=7");
    handle.close();
  });

  it("treats a non-ok response as a disconnect (reconnects, never goes live)", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse([], { ok: false, status: 503 }),
    );
    fetchMock.mockResolvedValue(openStreamResponse());

    const handle = openAuditStream(
      "a1",
      {},
      () => {},
      (s) => statuses.push(s),
    );
    await vi.waitFor(() => expect(statuses).toContain("reconnecting"));
    expect(statuses).not.toContain("live");
    handle.close();
  });

  it("close() emits closed, aborts, and prevents further reconnects", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([frame(backend(1))]));
    fetchMock.mockResolvedValue(openStreamResponse());

    const handle = openAuditStream(
      "a1",
      {},
      (e) => events.push(e),
      (s) => statuses.push(s),
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    handle.close();
    expect(statuses[statuses.length - 1]).toBe("closed");

    const callsAfterClose = fetchMock.mock.calls.length;
    // A second close() is a no-op; no new connects accrue.
    handle.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.length).toBe(callsAfterClose);
  });
});
