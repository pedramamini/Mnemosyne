import { describe, expect, it } from "vitest";
import { formatSseFrame, SseHub } from "../src/audit/sse.ts";
import type { AuditEvent } from "../src/audit/types.ts";

// MNEMO-20: the SSE fan-out helper is decoupled from the DO so it is unit-testable
// without booting a Durable Object. `formatSseFrame` is pure (no streams); the
// `SseHub` tests exercise the real ReadableStream the DO hands back from `/stream`.

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    seq: 7,
    id: "abc123",
    agentId: "agent-test",
    ts: 1_700_000_000_000,
    type: "source.read",
    level: "milestone",
    sessionId: null,
    text: "read TechCrunch on Acme",
    payload: { url: "https://techcrunch.com/acme" },
    ...overrides,
  };
}

describe("formatSseFrame", () => {
  it("emits id/event/data lines whose JSON round-trips, terminated by a blank line", () => {
    const event = sampleEvent();
    const frame = formatSseFrame(event);
    const lines = frame.split("\n");

    expect(lines[0]).toBe(`id: ${event.seq}`);
    expect(lines[1]).toBe(`event: ${event.type}`);
    expect(lines[2].startsWith("data: ")).toBe(true);
    // A well-formed SSE frame is terminated by a blank line (\n\n).
    expect(frame.endsWith("\n\n")).toBe(true);

    const json = lines[2].slice("data: ".length);
    expect(JSON.parse(json)).toEqual(event);
  });

  it("uses the event seq as the SSE id (Last-Event-ID ↔ sinceSeq cursor, §6.7)", () => {
    expect(formatSseFrame(sampleEvent({ seq: 42 }))).toContain("id: 42\n");
  });
});

describe("SseHub", () => {
  it("subscribe() returns a text/event-stream Response and tracks the subscriber", () => {
    const hub = new SseHub();
    const res = hub.subscribe();

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.body).toBeInstanceOf(ReadableStream);
    // The stream's `start` runs during construction, so the subscriber is live now.
    expect(hub.size).toBe(1);
  });

  it("publish() writes a readable SSE frame to the subscriber's stream", async () => {
    const hub = new SseHub();
    const res = hub.subscribe();
    const event = sampleEvent({ seq: 3, text: "wrote neuron acme.md" });

    hub.publish(event);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("wrote neuron acme.md");
    expect(chunk).toContain(`id: ${event.seq}`);
    reader.releaseLock();
  });
});
