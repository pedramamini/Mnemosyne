import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import {
  guardBodyLength,
  REPLY_SEGMENT_LIMIT,
} from "../src/messaging/reply.ts";
import { countSegments } from "../src/messaging/segmentation.ts";
import type { InboundMessage } from "../src/messaging/types.ts";
import { capturingGenerateModel, generateModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-46: the inbound→loop→async-reply lifecycle (PRD §9.3/§9.5). Runs in the
// workers pool so the AGENT DO + DO-SQLite are real. The agent loop is stubbed via
// `testModelOverride` (a fixed reply) and the sandbox via `testSandboxOverride`;
// the outbound Twilio POST is stubbed at globalThis.fetch (the channel send path).
// onInboundMessage DEFERS the reply to a DO alarm; here we drive the alarm
// callback (runInboundReply) directly for determinism, canceling the pending
// alarm first so it doesn't also auto-fire (a delay-0 alarm fires once in the
// pool) - see cancelDeferredReply below.

const AGENT_NUMBER = "+15005550006"; // the agent's provisioned E.164 (the `From`)
const SENDER = "+14155551212"; // the counterparty (the `To` of the reply)

afterEach(() => {
  vi.restoreAllMocks();
});

/** A normalized 1:1 inbound SMS (what the MNEMO-45 gateway hands the DO). */
function inbound(body: string): InboundMessage {
  return {
    from: SENDER,
    to: AGENT_NUMBER,
    body,
    channel: "sms",
    threadId: null,
    providerMessageId: "SM00000000000000000000000000000000",
    mediaUrls: [],
  };
}

/**
 * Mock a successful Twilio send (2xx + a message sid). A FRESH Response per call
 * (mockImplementation, not mockResolvedValue) so the body is readable on every
 * invocation - a Response body can only be consumed once.
 */
function mockTwilioOk(sid = "SM_reply"): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ sid }), { status: 201 })),
    );
}

/**
 * onInboundMessage DEFERS the reply onto a DO alarm (§9.3). In the workers pool a
 * delay-0 alarm auto-fires runInboundReply once; the tests below drive
 * runInboundReply EXPLICITLY for determinism, so cancel the pending alarm first
 * (within the same input-gated call, so it never fires) to avoid a double run.
 */
async function cancelDeferredReply(instance: MnemosyneAgent): Promise<void> {
  const agent = instance as unknown as {
    getSchedules(): { id: string }[];
    cancelSchedule(id: string): Promise<unknown>;
  };
  for (const s of agent.getSchedules()) await agent.cancelSchedule(s.id);
}

describe("onInboundMessage → runInboundReply (PRD §9.3)", () => {
  it("persists the inbound, runs the loop on the body, sends, and persists the outbound", async () => {
    const agentId = `inbound-${crypto.randomUUID()}`;
    const fetchSpy = mockTwilioOk();
    const cm = capturingGenerateModel("Here is the latest.");
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const out = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testModelOverride = cm.model;
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testAuditSink = [];

        await instance.onInboundMessage(inbound("what's the latest?"));
        // Drive the deferred reply (§9.3) explicitly; cancel the alarm first.
        await cancelDeferredReply(instance);
        const sessions = instance.listMessagingSessions();
        await instance.runInboundReply({
          sessionId: sessions[0].id,
          to: SENDER,
          fromNumber: AGENT_NUMBER,
          channel: "sms",
        });
        return {
          messages: instance.listMessagingMessages(sessions[0].id),
          sessionCount: sessions.length,
        };
      },
    );

    // (a) the inbound turn was persisted, direction 'in', with the sender's id.
    expect(out.sessionCount).toBe(1);
    expect(out.messages[0]).toMatchObject({
      direction: "in",
      from: SENDER,
      channel: "sms",
      body: "what's the latest?",
    });

    // (b) the loop ran ON THE BODY - the model saw the inbound text in its prompt.
    expect(cm.calls).toHaveLength(1);
    expect(JSON.stringify(cm.calls[0].prompt)).toContain("what's the latest?");

    // (c) send called once: From the agent's number, To the counterparty, the reply body.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("From")).toBe(AGENT_NUMBER);
    expect(form.get("To")).toBe(SENDER);
    expect(form.get("Body")).toBe("Here is the latest.");

    // (d) the outbound copy was persisted, direction 'out', fromId 'agent'.
    expect(out.messages[1]).toMatchObject({
      direction: "out",
      from: "agent",
      channel: "sms",
      body: "Here is the latest.",
    });
  });

  it("audits an error and does NOT crash the DO when the send fails", async () => {
    const agentId = `inbound-${crypto.randomUUID()}`;
    // Twilio answers non-2xx → SendResult { ok: false }.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const out = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testModelOverride = generateModel("a reply");
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testAuditSink = [];

        await instance.onInboundMessage(inbound("hello?"));
        await cancelDeferredReply(instance);
        const sessions = instance.listMessagingSessions();
        // Must resolve (not throw) even though the send returned { ok: false }.
        await instance.runInboundReply({
          sessionId: sessions[0].id,
          to: SENDER,
          fromNumber: AGENT_NUMBER,
          channel: "sms",
        });
        return {
          messages: instance.listMessagingMessages(sessions[0].id),
          audit: instance.testAuditSink ?? [],
        };
      },
    );

    // No outbound was persisted (the send failed) - only the inbound remains.
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].direction).toBe("in");
    // An error event was logged to the audit stream.
    expect(out.audit.some((e) => e.type === "error")).toBe(true);
  });

  it("truncates an over-long reply and appends a web-thread link (reply.ts cost guard)", async () => {
    const agentId = `inbound-${crypto.randomUUID()}`;
    const longReply = "A".repeat(1200); // ~8 GSM-7 segments, well over the limit
    const fetchSpy = mockTwilioOk("SM_long");
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    await runInDurableObject(stub, async (instance: MnemosyneAgent) => {
      instance.testModelOverride = generateModel(longReply);
      instance.testSandboxOverride = stubSandboxClient().client;
      instance.testAuditSink = [];

      await instance.onInboundMessage(inbound("tell me everything"));
      await cancelDeferredReply(instance);
      const sessions = instance.listMessagingSessions();
      await instance.runInboundReply({
        sessionId: sessions[0].id,
        to: SENDER,
        fromNumber: AGENT_NUMBER,
        channel: "sms",
      });
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentBody = new URLSearchParams(init.body as string).get("Body") ?? "";
    // Truncated (shorter than the full reply), bounded to the segment budget, and
    // ending with a link to the full web thread instead of fanning out segments.
    expect(sentBody.length).toBeLessThan(longReply.length);
    expect(sentBody).toContain("…");
    expect(sentBody).toContain(`/agents/${agentId}/messages`);
    expect(countSegments(sentBody)).toBeLessThanOrEqual(REPLY_SEGMENT_LIMIT);
  });
});

describe("guardBodyLength (reply.ts §9.2 cost guard)", () => {
  const LINK = "https://app.example/agents/x/messages";

  it("returns a short body unchanged", () => {
    expect(guardBodyLength("short and sweet", LINK)).toBe("short and sweet");
  });

  it("truncates an over-long body and appends the link within the segment budget", () => {
    const long = "A".repeat(1200);
    const out = guardBodyLength(long, LINK);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith(LINK)).toBe(true);
    expect(out).toContain("…");
    expect(countSegments(out)).toBeLessThanOrEqual(REPLY_SEGMENT_LIMIT);
  });

  it("appends a bare ellipsis when no link is available", () => {
    const long = "A".repeat(1200);
    const out = guardBodyLength(long, "");
    expect(out.endsWith("…")).toBe(true);
    expect(countSegments(out)).toBeLessThanOrEqual(REPLY_SEGMENT_LIMIT);
  });
});
