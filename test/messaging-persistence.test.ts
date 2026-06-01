import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import {
  appendMessage,
  dayKey,
  getOrCreate1to1Session,
  listMessages,
  listSessions,
} from "../src/messaging/persistence.ts";

// MNEMO-46: the messaging transcript store (PRD §9.5). `dayKey` is pure and tested
// directly; the session/message helpers run against a REAL DO-SQLite handle via
// runInDurableObject - calling a public DO method first triggers `ensureInit`
// (which creates the msg_session/msg_message schema), then we drive the persistence
// helpers against `ctx.storage.sql` inside the DO. Each test uses a distinct
// idFromName so DO state never collides.

/** Reach the DO's SqlStorage (the `ctx` is protected; cast past it for the test). */
function sqlOf(instance: MnemosyneAgent): SqlStorage {
  return (instance as unknown as { ctx: { storage: { sql: SqlStorage } } }).ctx
    .storage.sql;
}

function freshStub() {
  return env.AGENT.get(env.AGENT.idFromName(`persist-${crypto.randomUUID()}`));
}

describe("dayKey", () => {
  it("returns the UTC YYYY-MM-DD for a timestamp", () => {
    expect(dayKey(Date.UTC(2026, 4, 25, 13, 30, 0))).toBe("2026-05-25");
  });

  it("buckets by UTC calendar day regardless of intra-day time", () => {
    expect(dayKey(Date.UTC(2026, 4, 25, 0, 0, 0))).toBe("2026-05-25");
    expect(dayKey(Date.UTC(2026, 4, 25, 23, 59, 59))).toBe("2026-05-25");
    expect(dayKey(Date.UTC(2026, 4, 26, 0, 0, 0))).toBe("2026-05-26");
  });
});

describe("getOrCreate1to1Session - daily bucketing (§9.5)", () => {
  it("maps two same-day inbound messages to ONE session, a new day to a NEW one", async () => {
    const out = await runInDurableObject(
      freshStub(),
      (instance: MnemosyneAgent) => {
        instance.listMessagingSessions(); // triggers ensureInit (schema)
        const sql = sqlOf(instance);
        const counterparty = "+14155550000";
        const morning = Date.UTC(2026, 4, 25, 8, 0, 0);
        const evening = Date.UTC(2026, 4, 25, 20, 0, 0);
        const nextDay = Date.UTC(2026, 4, 26, 9, 0, 0);
        return {
          s1: getOrCreate1to1Session(sql, {
            counterparty,
            channel: "sms",
            ts: morning,
          }).id,
          s2: getOrCreate1to1Session(sql, {
            counterparty,
            channel: "sms",
            ts: evening,
          }).id,
          s3: getOrCreate1to1Session(sql, {
            counterparty,
            channel: "sms",
            ts: nextDay,
          }).id,
        };
      },
    );

    expect(out.s1).toBe(out.s2); // same calendar day → same session
    expect(out.s3).not.toBe(out.s1); // next calendar day → new session
  });

  it("keeps different counterparties on the same day in separate sessions", async () => {
    const out = await runInDurableObject(
      freshStub(),
      (instance: MnemosyneAgent) => {
        instance.listMessagingSessions();
        const sql = sqlOf(instance);
        const ts = Date.UTC(2026, 4, 25, 8, 0, 0);
        return {
          a: getOrCreate1to1Session(sql, {
            counterparty: "+14155550000",
            channel: "sms",
            ts,
          }).id,
          b: getOrCreate1to1Session(sql, {
            counterparty: "+14155551111",
            channel: "sms",
            ts,
          }).id,
        };
      },
    );
    expect(out.a).not.toBe(out.b);
  });
});

describe("appendMessage / listSessions / listMessages (§9.5)", () => {
  it("round-trips from/direction/channel and returns sessions + messages ordered", async () => {
    const out = await runInDurableObject(
      freshStub(),
      (instance: MnemosyneAgent) => {
        instance.listMessagingSessions();
        const sql = sqlOf(instance);
        const counterparty = "+14155552222";
        const t0 = Date.UTC(2026, 4, 25, 8, 0, 0);
        const { id } = getOrCreate1to1Session(sql, {
          counterparty,
          channel: "sms",
          ts: t0,
        });
        appendMessage(sql, {
          sessionId: id,
          fromId: counterparty,
          direction: "in",
          channel: "sms",
          body: "what's the latest?",
          ts: t0 + 1000,
        });
        appendMessage(sql, {
          sessionId: id,
          fromId: "agent",
          direction: "out",
          channel: "sms",
          body: "Here is the latest.",
          ts: t0 + 2000,
        });
        return {
          id,
          sessions: listSessions(sql),
          messages: listMessages(sql, id),
        };
      },
    );

    // Session carries the badge fields + message count (§9.5).
    const session = out.sessions.find((s) => s.id === out.id);
    expect(session).toBeDefined();
    expect(session?.counterparty).toBe("+14155552222");
    expect(session?.channel).toBe("sms");
    expect(session?.kind).toBe("1to1");
    expect(session?.day).toBe("2026-05-25");
    expect(session?.threadId).toBeNull();
    expect(session?.messageCount).toBe(2);

    // Messages keep their from/direction/channel tags and come back in seq order.
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({
      from: "+14155552222",
      direction: "in",
      channel: "sms",
      body: "what's the latest?",
    });
    expect(out.messages[1]).toMatchObject({
      from: "agent",
      direction: "out",
      channel: "sms",
      body: "Here is the latest.",
    });
    expect(out.messages[0].seq).toBeLessThan(out.messages[1].seq);
  });
});
