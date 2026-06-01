/**
 * Messaging transcript store, keyed by counterparty (MNEMO-46, PRD §9.5).
 *
 * Layered over the DO-SQLite CRUD helpers in `src/agent/sql.ts` - this module
 * owns the BUSINESS rules §9.5 calls out: a per-agent transcript keyed by
 * counterparty, 1:1 conversations bucketed **one session per calendar day**, and
 * every stored message tagged with its `from` identity + `channel`. The web UI
 * reads the SAME store (via the MNEMO-46 read API), so an SMS thread renders as a
 * first-class conversation with a channel badge.
 *
 * Group sessions (`kind: "group"`, keyed by `threadId`) are written by MNEMO-48
 * through {@link getOrCreateGroupSession} here - this phase handles 1:1 SMS only.
 */
import {
  findMsgSession,
  insertMsgMessage,
  insertMsgSession,
  type MsgMessageRow,
  selectMsgMessages,
  selectMsgSessions,
} from "../agent/sql.ts";
import type { Channel } from "./types.ts";

/** The two session kinds. A 1:1 is daily-bucketed; a group is keyed by thread. */
export type SessionKind = "1to1" | "group";

/** The direction a stored message travelled relative to the agent. */
export type MessageDirection = "in" | "out";

/**
 * A session as the web-rendering API exposes it (PRD §9.5). Carries `channel`
 * (per session) + `kind`/`day` so the UI can render a channel badge and group
 * 1:1 days. `messageCount` drives the conversation-list preview.
 */
export interface MessagingSession {
  id: string;
  counterparty: string;
  threadId: string | null;
  channel: Channel;
  kind: SessionKind;
  day: string | null;
  createdAt: number;
  messageCount: number;
}

/**
 * A stored message as the web-rendering API exposes it. `from` is the §9.5 sender
 * identity (E.164 or `"agent"`) and `channel` is the per-message badge tag.
 */
export interface MessagingMessage {
  seq: number;
  sessionId: string;
  from: string;
  direction: MessageDirection;
  channel: Channel;
  body: string;
  ts: number;
}

/**
 * The UTC calendar day (`YYYY-MM-DD`) a timestamp falls in. "One session per
 * calendar day" (§9.5) follows the web conversation model (§6.5): a counterparty
 * gets one bucket per UTC day so a long-running text thread stays browsable as
 * discrete daily conversations rather than one unbounded blob.
 */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Resolve the 1:1 session for `counterparty` on the calendar day of `ts`, or
 * create it - the daily bucketing (§9.5). Two messages from the same counterparty
 * on the same UTC day share one session; the next day opens a new one.
 */
export function getOrCreate1to1Session(
  sql: SqlStorage,
  input: { counterparty: string; channel: Channel; ts: number },
): { id: string } {
  const day = dayKey(input.ts);
  const existing = findMsgSession(sql, input.counterparty, "1to1", day);
  if (existing) return { id: existing.id };

  const id = crypto.randomUUID();
  insertMsgSession(sql, {
    id,
    counterparty: input.counterparty,
    thread_id: null,
    channel: input.channel,
    kind: "1to1",
    day,
    created_at: input.ts,
  });
  return { id };
}

/**
 * Resolve (or create) the group session for `threadId` - the app-modeled
 * multi-agent thread (MNEMO-48 calls this). A group is NOT daily-bucketed: it has
 * a stable thread identity, so `day` is null and the thread id is both the
 * `counterparty` key and `thread_id`.
 */
export function getOrCreateGroupSession(
  sql: SqlStorage,
  input: { threadId: string; channel: Channel; ts: number },
): { id: string } {
  const existing = findMsgSession(sql, input.threadId, "group", null);
  if (existing) return { id: existing.id };

  const id = crypto.randomUUID();
  insertMsgSession(sql, {
    id,
    counterparty: input.threadId,
    thread_id: input.threadId,
    channel: input.channel,
    kind: "group",
    day: null,
    created_at: input.ts,
  });
  return { id };
}

/**
 * Append one message to a session, tagged with its `from` identity, `direction`,
 * and `channel` (the §9.5 per-message requirement). Returns the assigned `seq`.
 */
export function appendMessage(
  sql: SqlStorage,
  input: {
    sessionId: string;
    fromId: string;
    direction: MessageDirection;
    channel: Channel;
    body: string;
    ts: number;
  },
): { seq: number } {
  const row = insertMsgMessage(sql, {
    session_id: input.sessionId,
    from_id: input.fromId,
    direction: input.direction,
    channel: input.channel,
    body: input.body,
    ts: input.ts,
  });
  return { seq: row.seq };
}

/** List every session for the web conversation list (newest first, with counts). */
export function listSessions(sql: SqlStorage): MessagingSession[] {
  return selectMsgSessions(sql).map((row) => ({
    id: row.id,
    counterparty: row.counterparty,
    threadId: row.thread_id,
    channel: row.channel as Channel,
    kind: row.kind as SessionKind,
    day: row.day,
    createdAt: row.created_at,
    messageCount: row.message_count,
  }));
}

/** List one session's messages in chronological (`seq`) order. */
export function listMessages(
  sql: SqlStorage,
  sessionId: string,
): MessagingMessage[] {
  return selectMsgMessages(sql, sessionId).map(toMessagingMessage);
}

/** Map a raw `msg_message` row to the API shape (`from_id` → `from`). */
function toMessagingMessage(row: MsgMessageRow): MessagingMessage {
  return {
    seq: row.seq,
    sessionId: row.session_id,
    from: row.from_id,
    direction: row.direction as MessageDirection,
    channel: row.channel as Channel,
    body: row.body,
    ts: row.ts,
  };
}
