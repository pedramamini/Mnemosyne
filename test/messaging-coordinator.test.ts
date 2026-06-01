import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentStub } from "../src/agent/index.ts";
import {
  addAgentNumber,
  createAccount,
  createAgent,
  isWhitelisted,
} from "../src/db/index.ts";
import type { GroupInbound } from "../src/messaging/groupTypes.ts";
import type { ThreadCoordinator } from "../src/messaging/ThreadCoordinator.ts";

// MNEMO-48: the ThreadCoordinator (PRD §9.4/§9.5). Runs in the workers pool with
// REAL THREAD + AGENT DO bindings: the per-member `recordGroupMessage` persistence
// runs for real (so we can assert the multi-party history landed + the whitelist
// expanded), while each member's triage bid and floor-winner loop are STUBBED via
// the coordinator's `test*` overrides - so we drive deterministic bids and capture
// the floor decision without inference.

/** Seed an account with N agents (given names) and return their ids in order. */
async function seedAgents(names: string[]): Promise<string[]> {
  const account = await createAccount(env, {
    email: `grp-${crypto.randomUUID()}@example.com`,
  });
  const ids: string[] = [];
  for (const name of names) {
    const agent = await createAgent(env, { account_id: account.id, name });
    ids.push(agent.id);
  }
  return ids;
}

/** The per-thread coordinator stub. */
function threadStub(threadId: string) {
  return env.THREAD.get(env.THREAD.idFromName(threadId));
}

/** Build a group inbound (SMS channel). `ts` defaults to now (kept distinct per call). */
function groupMsg(args: {
  threadId: string;
  from: string;
  body: string;
  members: string[];
  memberNumbers: string[];
  ts?: number;
}): GroupInbound {
  return {
    threadId: args.threadId,
    from: args.from,
    body: args.body,
    channel: "sms",
    memberAgentIds: args.members,
    memberNumbers: args.memberNumbers,
    ts: args.ts ?? Date.now(),
  };
}

/** The group-session messages recorded into one agent's DO (multi-party history). */
async function groupMessagesOf(agentId: string) {
  const stub = getAgentStub(env, agentId);
  const sessions = await stub.listMessagingSessions();
  const group = sessions.find((s) => s.kind === "group");
  return group ? stub.listMessagingMessages(group.id) : [];
}

describe("ThreadCoordinator.onGroupMessage (PRD §9.4/§9.5)", () => {
  it("fans the inbound to every member, records full history, expands the whitelist, and clears only the top bids", async () => {
    const [atlas, scout, beacon] = await seedAgents([
      "Atlas",
      "Scout",
      "Beacon",
    ]);
    const members = [atlas, scout, beacon];
    const threadId = `thread-${crypto.randomUUID()}`;
    const HUMAN = "+15551230000";
    const body = "What's the latest on Acme?";
    const confidence: Record<string, number> = {
      [atlas]: 0.9,
      [scout]: 0.4,
      [beacon]: 0.1,
    };
    const replied: string[] = [];

    const decision = await runInDurableObject(
      threadStub(threadId),
      async (coord: ThreadCoordinator) => {
        coord.testTriageOverride = ({ agentId }) => ({
          agentId,
          wantsToRespond: true,
          confidence: confidence[agentId] ?? 0,
          reason: "",
        });
        coord.testReplyInvoker = async (agentId) => {
          replied.push(agentId);
        };
        return coord.onGroupMessage(
          groupMsg({
            threadId,
            from: HUMAN,
            body,
            members,
            memberNumbers: [HUMAN],
          }),
        );
      },
    );

    // (b) Only the top MAX_FLOOR_WINNERS bids (Atlas 0.9, Scout 0.4) run the loop;
    // Beacon (0.1) is below the floor - no pile-on.
    expect([...decision.winners].sort()).toEqual([atlas, scout].sort());
    expect([...replied].sort()).toEqual([atlas, scout].sort());
    expect(replied).not.toContain(beacon);

    // (a) EVERY member agent's group session received the inbound (full multi-party
    // history with `from` + `channel`, §9.5).
    for (const id of members) {
      const msgs = await groupMessagesOf(id);
      expect(
        msgs.some(
          (m) => m.from === HUMAN && m.channel === "sms" && m.body === body,
        ),
      ).toBe(true);
    }

    // (e) expandWhitelistForGroup ran on first sight - members are whitelisted
    // (MNEMO-47-a §9.6 permissive auto-expansion).
    for (const id of members) {
      expect(await isWhitelisted(env, id, HUMAN)).toBe(true);
    }
  });

  it("(c) an @-mention forces a response even when every bid is declined", async () => {
    const [atlas, scout, beacon] = await seedAgents([
      "Atlas",
      "Scout",
      "Beacon",
    ]);
    const members = [atlas, scout, beacon];
    const threadId = `thread-${crypto.randomUUID()}`;
    const HUMAN = "+15551231111";
    const replied: string[] = [];

    const decision = await runInDurableObject(
      threadStub(threadId),
      async (coord: ThreadCoordinator) => {
        // Everyone DECLINES via triage…
        coord.testTriageOverride = ({ agentId }) => ({
          agentId,
          wantsToRespond: false,
          confidence: 0,
          reason: "not my area",
        });
        coord.testReplyInvoker = async (agentId) => {
          replied.push(agentId);
        };
        // …but the message @-mentions Beacon, which must answer regardless.
        return coord.onGroupMessage(
          groupMsg({
            threadId,
            from: HUMAN,
            body: "hey @Beacon any updates?",
            members,
            memberNumbers: [HUMAN],
          }),
        );
      },
    );

    expect(decision.forcedByMention).toContain(beacon);
    expect(decision.winners).toContain(beacon);
    expect(replied).toContain(beacon);
    // The others declined → no pile-on.
    expect(replied).not.toContain(atlas);
    expect(replied).not.toContain(scout);
  });

  it("(d) an @-mention overrides agent-to-agent silence (before the cap)", async () => {
    const [atlas, scout, beacon] = await seedAgents([
      "Atlas",
      "Scout",
      "Beacon",
    ]);
    const members = [atlas, scout, beacon];
    const threadId = `thread-${crypto.randomUUID()}`;
    const N1 = "+15551232222"; // Atlas's provisioned number → Atlas is an agent sender
    await addAgentNumber(env, atlas, N1);
    const replied: string[] = [];

    const decision = await runInDurableObject(
      threadStub(threadId),
      async (coord: ThreadCoordinator) => {
        coord.testTriageOverride = ({ agentId }) => ({
          agentId,
          wantsToRespond: false,
          confidence: 0,
          reason: "",
        });
        coord.testReplyInvoker = async (agentId) => {
          replied.push(agentId);
        };
        return coord.onGroupMessage(
          groupMsg({
            threadId,
            from: N1,
            body: "@Scout thoughts?",
            members,
            memberNumbers: [N1],
          }),
        );
      },
    );

    // The mentioned agent answers even though the sender is another agent…
    expect(decision.forcedByMention).toContain(scout);
    expect(replied).toContain(scout);
    // …but an un-mentioned agent stays silent on an agent's message.
    expect(replied).not.toContain(beacon);
  });

  it("(d) an agent message draws no replies, and the turn cap halts the chain", async () => {
    const [atlas, scout, beacon] = await seedAgents([
      "Atlas",
      "Scout",
      "Beacon",
    ]);
    const members = [atlas, scout, beacon];
    const threadId = `thread-${crypto.randomUUID()}`;
    const N1 = "+15551233333";
    await addAgentNumber(env, atlas, N1);

    const out = await runInDurableObject(
      threadStub(threadId),
      async (coord: ThreadCoordinator) => {
        const replied: string[] = [];
        // Bids all eager - so the ONLY thing keeping the floor empty is the §9.4
        // agent-to-agent silence + the hard turn cap, not a low bid.
        coord.testTriageOverride = ({ agentId }) => ({
          agentId,
          wantsToRespond: true,
          confidence: 1,
          reason: "",
        });
        coord.testReplyInvoker = async (agentId) => {
          replied.push(agentId);
        };

        const base = Date.now();
        // (i) An agent message with NO mention → other agents stay silent.
        const noMention = await coord.onGroupMessage(
          groupMsg({
            threadId,
            from: N1,
            body: "musing 0",
            members,
            memberNumbers: [N1],
            ts: base,
          }),
        );
        // Two more un-mentioned agent messages drive agentTurnsSinceHuman to the cap
        // WITHOUT any agent speaking (so no post-speak cooldown clouds the result).
        await coord.onGroupMessage(
          groupMsg({
            threadId,
            from: N1,
            body: "musing 1",
            members,
            memberNumbers: [N1],
            ts: base + 1,
          }),
        );
        await coord.onGroupMessage(
          groupMsg({
            threadId,
            from: N1,
            body: "musing 2",
            members,
            memberNumbers: [N1],
            ts: base + 2,
          }),
        );
        // (ii) Now @-mention a FRESH agent (Beacon never spoke → no cooldown). The
        // hard turn cap STILL blocks it - the mention can't keep the chain alive.
        const capped = await coord.onGroupMessage(
          groupMsg({
            threadId,
            from: N1,
            body: "hey @Beacon",
            members,
            memberNumbers: [N1],
            ts: base + 3,
          }),
        );
        return { noMention, capped, replied };
      },
    );

    // (i) No other agent answered the un-mentioned agent message.
    expect(out.noMention.winners).toEqual([]);
    // (ii) The cap halts the chain - even the @-mentioned agent is blocked.
    expect(out.capped.winners).toEqual([]);
    expect(out.capped.forcedByMention).toEqual([]);
    expect(out.replied).toEqual([]);
  });

  it("dedupes a redelivered message (idempotent floor)", async () => {
    const [atlas, scout] = await seedAgents(["Atlas", "Scout"]);
    const members = [atlas, scout];
    const threadId = `thread-${crypto.randomUUID()}`;
    const HUMAN = "+15551234444";
    const ts = Date.now();
    let triageCalls = 0;

    const { first, second } = await runInDurableObject(
      threadStub(threadId),
      async (coord: ThreadCoordinator) => {
        coord.testTriageOverride = ({ agentId }) => {
          triageCalls += 1;
          return { agentId, wantsToRespond: true, confidence: 0.5, reason: "" };
        };
        coord.testReplyInvoker = async () => {};
        const msg = groupMsg({
          threadId,
          from: HUMAN,
          body: "same message",
          members,
          memberNumbers: [HUMAN],
          ts,
        });
        const first = await coord.onGroupMessage(msg);
        const second = await coord.onGroupMessage(msg); // identical → deduped
        return { first, second };
      },
    );

    expect(first.winners.length).toBeGreaterThan(0);
    expect(second.winners).toEqual([]); // the redelivery is a no-op
    const callsAfterFirst = triageCalls;
    expect(callsAfterFirst).toBe(2); // both members triaged ONCE (not re-run)
  });
});
