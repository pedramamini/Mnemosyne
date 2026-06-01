/**
 * ThreadCoordinator - the per-group-thread orchestrator Durable Object (MNEMO-48,
 * PRD §9.4/§9.5).
 *
 * One instance per group thread via `env.THREAD.idFromName(threadId)` (the same
 * idFromName idiom as the agent DO, MNEMO-04). It ORCHESTRATES only - each agent
 * keeps its own DO (identity / memory / tools). For each inbound message it:
 *
 *   1. fans the message into EVERY member agent's group session (full multi-party
 *      history with `from`+`channel` tags, §9.5) and seeds group access (§9.6);
 *   2. resolves @-mentions → forced floor winners (a named agent always responds);
 *   3. applies loop-prevention (agent↔agent silence + turn cap + cooldown, §9.4),
 *      skipping gated, un-mentioned agents;
 *   4. fans the cheap Haiku triage gate out to the remaining members and collects
 *      their confidence bids within {@link TRIAGE_DEBOUNCE_MS};
 *   5. picks the floor: mentioned agents always win, then the top
 *      {@link MAX_FLOOR_WINNERS} bids by confidence - "no pile-on, only signal";
 *   6. invokes each winner's group loop and reply, stamping floor state.
 *
 * Its floor-control state (turn counter, per-agent last-spoke, message dedupe)
 * lives in `ctx.storage.sql` (declared in a `new_sqlite_classes` migration), built
 * via the one-statement-per-entry `SCHEMA: string[]` init pattern from
 * `src/audit/store.ts`. The coordinator's outward calls (record / triage / reply)
 * are injectable for hermetic tests via the `test*` override fields below.
 */
import { DurableObject } from "cloudflare:workers";
import { getAgentStub } from "../agent/index.ts";
import { type AgentRow, getAgent, getAgentNumber } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  type FloorDecision,
  GroupInbound,
  type GroupRecordInput,
  type GroupRecordResult,
  type GroupReplyInput,
  MAX_FLOOR_WINNERS,
  type TriageBid,
} from "./groupTypes.ts";
import { gateAgentTurn, isFromAgent } from "./loopPrevention.ts";
import { type MentionMember, parseMentions } from "./mentions.ts";
import { triageGate } from "./triage.ts";

/** One statement per entry (mirrors src/audit/store.ts `SCHEMA`). */
const SCHEMA: string[] = [
  // Per-thread key/value: the roster (members + numbers) and the agent-turn counter.
  `CREATE TABLE IF NOT EXISTS thread_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // Per-agent floor state: when each member last took the floor (post-speak
  // cooldown, §9.4). The agent-turn counter is a single value in thread_meta.
  `CREATE TABLE IF NOT EXISTS floor_state (
     agent_id      TEXT PRIMARY KEY,
     last_spoke_ts INTEGER NOT NULL
   )`,
  // Message dedupe: a webhook may redeliver, and a fan-out must not double-run the
  // floor for one message. Keyed by the coordinator's derived message id.
  `CREATE TABLE IF NOT EXISTS seen_messages (
     message_id TEXT PRIMARY KEY,
     ts         INTEGER NOT NULL
   )`,
];

/** thread_meta key holding the consecutive-agent-turns-since-human counter (§9.4). */
const TURNS_KEY = "agentTurnsSinceHuman";

/** A member agent's resolved context for one message (roster + transcript tail). */
interface MemberContext extends MentionMember {
  /** The agent's provisioned E.164, or null if it has no number yet. */
  number: string | null;
  /** A short role/specialty descriptor fed to the triage gate. */
  role: string;
  /** This member's recent group transcript (for the triage prompt). */
  tail: GroupRecordResult["tail"];
}

/** The input the (injectable) triage call receives per member. */
interface TriageCall {
  agentId: string;
  role: string;
  tail: GroupRecordResult["tail"];
  message: string;
}

export class ThreadCoordinator extends DurableObject<Env> {
  /** The DO's SQL handle (schema ensured in the constructor). */
  private readonly store: SqlStorage;

  /**
   * TEST-ONLY triage override (mirrors `MnemosyneAgent.testModelOverride`). When
   * set, the coordinator scores each eligible member through this instead of the
   * real cheap-model {@link triageGate}, so a workers-pool test can drive
   * deterministic bids without inference. Production leaves it undefined.
   */
  testTriageOverride?: (input: TriageCall) => TriageBid | Promise<TriageBid>;

  /**
   * TEST-ONLY floor-winner reply override. When set, the coordinator records which
   * agents were cleared to run the loop through this instead of invoking the agent
   * DO's real `replyInGroup` - so a test asserts the floor decision without running
   * the (model-driven) loop. Production leaves it undefined (real agent-DO call).
   */
  testReplyInvoker?: (agentId: string, input: GroupReplyInput) => Promise<void>;

  /**
   * TEST-ONLY record override. Rarely set - the coordinator test lets the REAL
   * agent-DO `recordGroupMessage` run so it can assert each member's group session
   * actually received the message (§9.5) and that the whitelist expanded (§9.6).
   */
  testRecordInvoker?: (
    agentId: string,
    input: GroupRecordInput,
  ) => Promise<GroupRecordResult>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = ctx.storage.sql;
    // Idempotent (IF NOT EXISTS) DDL, gated before any request is served - the
    // same init guard AuditLog uses (src/audit/AuditLog.ts).
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA) this.store.exec(stmt);
    });
  }

  /**
   * Orchestrate one inbound group message end to end (see the class comment for the
   * six steps). Returns the {@link FloorDecision} - which agents were cleared to
   * reply and which won by @-mention. Idempotent per message: a redelivery of an
   * already-seen message is a no-op that returns an empty decision.
   */
  async onGroupMessage(input: GroupInbound): Promise<FloorDecision> {
    const msg = GroupInbound.parse(input);
    const now = Date.now();
    const messageId = this.deriveMessageId(msg);

    // Dedupe: a redelivered message must not re-run the floor.
    if (this.isSeen(messageId)) {
      return {
        threadId: msg.threadId,
        messageId,
        winners: [],
        forcedByMention: [],
      };
    }
    this.markSeen(messageId, now);

    // Persist the roster (members + numbers) for this thread (§9.4 thread_meta).
    this.metaSet("memberAgentIds", JSON.stringify(msg.memberAgentIds));
    this.metaSet("memberNumbers", JSON.stringify(msg.memberNumbers));

    // (1) Fan the message into EVERY member's group session (full multi-party
    // history, §9.5) and collect each member's roster context + transcript tail.
    const members: MemberContext[] = [];
    for (const agentId of msg.memberAgentIds) {
      const meta = await this.resolveAgentMeta(agentId);
      const fromSelf = meta.number !== null && meta.number === msg.from;
      const recorded = await this.record(agentId, {
        threadId: msg.threadId,
        from: msg.from,
        body: msg.body,
        channel: msg.channel,
        memberNumbers: msg.memberNumbers,
        ts: msg.ts,
        fromSelf,
      });
      members.push({ ...meta, tail: recorded.tail });
    }

    // Identify whether the sender is itself a member agent (§9.4 agent↔agent rule).
    const agentNumbers = members
      .map((m) => m.number)
      .filter((n): n is string => n !== null);
    const senderIsAgent = isFromAgent(
      msg.from,
      msg.memberNumbers,
      agentNumbers,
    );
    const senderAgentId =
      members.find((m) => m.number !== null && m.number === msg.from)
        ?.agentId ?? null;

    // (2) @-mentions → forced floor winners (a named agent always responds, §9.4).
    const mentioned = parseMentions(
      msg.body,
      members.map((m) => ({
        agentId: m.agentId,
        name: m.name,
        handle: m.handle,
      })),
    );

    // Floor state: a HUMAN message resets the agent-turn counter (§9.4); for an
    // agent sender we carry the stored count so a chain self-limits at the cap.
    const storedTurns = this.getTurns();
    const turns = senderIsAgent ? storedTurns : 0;

    // (3) Loop-prevention gate per member (never reply to oneself).
    const forcedWinners: string[] = [];
    const eligible: MemberContext[] = [];
    for (const m of members) {
      if (m.agentId === senderAgentId) continue;
      const isMentioned = mentioned.includes(m.agentId);
      const gate = gateAgentTurn(
        {
          agentTurnsSinceHuman: turns,
          lastSpokeTs: this.getLastSpoke(m.agentId),
          now,
        },
        { senderIsAgent, isMentioned },
      );
      if (!gate.allowed) continue;
      if (isMentioned) forcedWinners.push(m.agentId);
      else eligible.push(m);
    }

    // (4) Fan the cheap triage gate out to the remaining members concurrently -
    // the concurrent await IS the bounded collection window (TRIAGE_DEBOUNCE_MS).
    const bids = await Promise.all(
      eligible.map((m) =>
        this.triage({
          agentId: m.agentId,
          role: m.role,
          tail: m.tail,
          message: msg.body,
        }),
      ),
    );

    // (5) Floor decision: mentioned agents always win (can exceed the cap); then
    // fill remaining slots up to MAX_FLOOR_WINNERS by highest confidence (§9.4).
    const winners = [...forcedWinners];
    const ranked = bids
      .filter((b) => b.wantsToRespond)
      .sort((a, b) => b.confidence - a.confidence);
    for (const bid of ranked) {
      if (winners.length >= MAX_FLOOR_WINNERS) break;
      if (!winners.includes(bid.agentId)) winners.push(bid.agentId);
    }

    // (6) Invoke each winner's group loop + reply, then stamp floor state. The
    // agent keeps its own DO/memory/tools (§9.4) - we only hand off the floor.
    for (const agentId of winners) {
      const member = members.find((m) => m.agentId === agentId);
      await this.reply(agentId, {
        threadId: msg.threadId,
        // SMS has no native group fan-out (MNEMO-44 `capabilities.group=false`), so
        // a reply routes back to the message sender. A native group transport would
        // address the thread here instead.
        to: msg.from,
        fromNumber: member?.number ?? "",
        channel: msg.channel,
        tier: "group_member",
      });
      this.setLastSpoke(agentId, now);
    }

    // Advance the turn counter (§9.4): a human message reset it to 0 above; an
    // agent sender's turn increments it so an agent↔agent chain hits the cap.
    this.setTurns(senderIsAgent ? storedTurns + 1 : 0);

    return {
      threadId: msg.threadId,
      messageId,
      winners,
      forcedByMention: forcedWinners,
    };
  }

  // ─── Outward calls (injectable for tests) ────────────────────────────────

  /** Fan one message into a member's group session (real agent DO, or test stub). */
  private record(
    agentId: string,
    input: GroupRecordInput,
  ): Promise<GroupRecordResult> {
    if (this.testRecordInvoker) return this.testRecordInvoker(agentId, input);
    return getAgentStub(this.env, agentId).recordGroupMessage(input);
  }

  /** Score one member's interest via the cheap triage gate (real, or test stub). */
  private triage(input: TriageCall): Promise<TriageBid> | TriageBid {
    if (this.testTriageOverride) return this.testTriageOverride(input);
    return triageGate(this.env, {
      agentId: input.agentId,
      role: input.role,
      transcriptTail: input.tail,
      message: input.message,
    });
  }

  /** Clear a floor winner to run its loop + reply (real agent DO, or test stub). */
  private reply(agentId: string, input: GroupReplyInput): Promise<void> {
    if (this.testReplyInvoker) return this.testReplyInvoker(agentId, input);
    return getAgentStub(this.env, agentId).replyInGroup(input);
  }

  /**
   * Resolve a member agent's roster context from D1 (its registry name + system
   * prompt for the triage role, and its provisioned number). Degrades gracefully:
   * a missing row falls back to the agentId as the name and an empty number.
   */
  private async resolveAgentMeta(agentId: string): Promise<{
    agentId: string;
    name: string;
    number: string | null;
    role: string;
  }> {
    const [agent, numberRow] = await Promise.all([
      getAgent(this.env, agentId).catch(() => null),
      getAgentNumber(this.env, agentId).catch(() => null),
    ]);
    return {
      agentId,
      name: agent?.name ?? agentId,
      number: numberRow?.e164 ?? null,
      role: roleDescriptor(agent),
    };
  }

  // ─── Floor-control state (DO SQLite) ─────────────────────────────────────

  private metaGet(key: string): string | null {
    const rows = this.store
      .exec<{ value: string }>(
        "SELECT value FROM thread_meta WHERE key = ?",
        key,
      )
      .toArray();
    return rows.length ? rows[0].value : null;
  }

  private metaSet(key: string, valueJson: string): void {
    this.store.exec(
      `INSERT INTO thread_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      valueJson,
    );
  }

  private getTurns(): number {
    const raw = this.metaGet(TURNS_KEY);
    return raw ? (JSON.parse(raw) as number) : 0;
  }

  private setTurns(n: number): void {
    this.metaSet(TURNS_KEY, JSON.stringify(n));
  }

  private getLastSpoke(agentId: string): number | null {
    const rows = this.store
      .exec<{ last_spoke_ts: number }>(
        "SELECT last_spoke_ts FROM floor_state WHERE agent_id = ?",
        agentId,
      )
      .toArray();
    return rows.length ? rows[0].last_spoke_ts : null;
  }

  private setLastSpoke(agentId: string, ts: number): void {
    this.store.exec(
      `INSERT INTO floor_state (agent_id, last_spoke_ts) VALUES (?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET last_spoke_ts = excluded.last_spoke_ts`,
      agentId,
      ts,
    );
  }

  private isSeen(messageId: string): boolean {
    const rows = this.store
      .exec(
        "SELECT 1 FROM seen_messages WHERE message_id = ? LIMIT 1",
        messageId,
      )
      .toArray();
    return rows.length > 0;
  }

  private markSeen(messageId: string, ts: number): void {
    this.store.exec(
      "INSERT OR IGNORE INTO seen_messages (message_id, ts) VALUES (?, ?)",
      messageId,
      ts,
    );
  }

  /**
   * A deterministic dedupe id for one inbound message. SMS carries no native group
   * message id, so derive one from sender + timestamp + a stable hash of the body -
   * the same logical message redelivered yields the same id (idempotent floor).
   */
  private deriveMessageId(msg: GroupInbound): string {
    return `${msg.from}:${msg.ts}:${djb2(msg.body)}`;
  }
}

/**
 * A short role/specialty descriptor for the triage gate, from the agent's registry
 * row: its template lens (e.g. "vendor") plus a clipped system-prompt excerpt.
 * Empty when the agent is unknown - the gate then treats it as general-purpose.
 */
function roleDescriptor(agent: AgentRow | null): string {
  if (!agent) return "";
  const lens = agent.template ? `${agent.template} research agent` : "";
  const prompt = agent.system_prompt
    ? agent.system_prompt.replace(/\s+/g, " ").trim().slice(0, 280)
    : "";
  return [lens, prompt].filter(Boolean).join(" - ");
}

/** Tiny stable string hash (djb2) for the body component of a dedupe id. */
function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}
