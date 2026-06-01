/**
 * Thin DO-SQLite helper over `ctx.storage.sql` (available because
 * `MnemosyneAgent` is declared in a `new_sqlite_classes` migration). This is the
 * single schema-init path every later phase extends - MNEMO-08 adds the
 * memory/graph index tables here (via `initGraphSchema`), MNEMO-27 the schedule -
 * so DDL lives in one place rather than scattered across the codebase.
 *
 * Mirrors the one-statement-per-entry `SCHEMA: string[]` pattern from
 * `src/audit/store.ts`. No business logic - just schema + key/value accessors,
 * plus the {@link sqlDriver} adapter that lets `ctx.storage.sql` satisfy the
 * shared {@link SqlDriver} surface (so the memory index - `GraphIndex` - runs in
 * the DO over the same interface it's tested on with node:sqlite).
 */
import type { SqlDriver } from "../audit/store.ts";
import { initGraphSchema } from "../memory/graph-schema.ts";

/** One statement per entry so each runs individually (see src/audit/store.ts). */
const SCHEMA: string[] = [
  // Key/value store for the DO's own operating state (settings + schedule),
  // persisted as JSON so it rehydrates after hibernation. Later phases add
  // sibling tables alongside this one.
  `CREATE TABLE IF NOT EXISTS agent_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // Messaging transcript (MNEMO-46, PRD §9.5): SMS turns persist to the SAME
  // DO-SQLite the web UI reads, so text threads render as first-class
  // conversations with a channel badge. A `msg_session` is keyed by counterparty
  // (E.164 for a 1:1, thread id for a group); a 1:1 is bucketed to ONE session
  // per calendar day via the `day` column, enforced by the UNIQUE index below.
  `CREATE TABLE IF NOT EXISTS msg_session (
     id           TEXT PRIMARY KEY,
     counterparty TEXT NOT NULL,
     thread_id    TEXT,
     channel      TEXT NOT NULL,
     kind         TEXT NOT NULL,
     day          TEXT,
     created_at   INTEGER NOT NULL
   )`,
  // A calendar day maps to exactly one 1:1 session (counterparty + kind + day).
  // For a group session `day` is null; SQLite treats nulls as distinct in a
  // UNIQUE index, which is fine - group sessions key off `(counterparty, kind)`
  // and are found-or-created explicitly (MNEMO-48).
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_session_bucket
     ON msg_session (counterparty, kind, day)`,
  // Each turn carries its `from` identity and `channel` tag (the §9.5
  // requirement) plus a monotonic `seq` for stable ordering across a session.
  `CREATE TABLE IF NOT EXISTS msg_message (
     seq        INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     from_id    TEXT NOT NULL,
     direction  TEXT NOT NULL,
     channel    TEXT NOT NULL,
     body       TEXT NOT NULL,
     ts         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_message_session
     ON msg_message (session_id)`,
  // Web chat conversations (MNEMO-35/36, PRD §6.5): threaded web chat persisted to
  // the SAME per-agent DO-SQLite the rest of the agent lives in, so the chat loop
  // keeps direct access to the brain/persona/tools. One row per thread; `preview`
  // caches the latest message snippet for the conversation-list rail, `updated_at`
  // drives newest-first ordering. (The SDK's own flat `cf_ai_chat_agent_messages`
  // log is single-thread and unused by the web UI - these tables carry threads.)
  `CREATE TABLE IF NOT EXISTS web_conversation (
     id          TEXT PRIMARY KEY,
     title       TEXT NOT NULL,
     preview     TEXT,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_web_conversation_updated
     ON web_conversation (updated_at DESC)`,
  // One persisted UI message per row. `parts_json` is the serialized Vercel AI SDK
  // `UIMessage.parts` array (text + any tool/reasoning parts), so a reload
  // reconstructs the full transcript; `msg_id` is the SDK message id (used to
  // dedupe a re-sent client history against what's already stored). `seq` orders
  // turns within a conversation.
  `CREATE TABLE IF NOT EXISTS web_conversation_message (
     seq             INTEGER PRIMARY KEY AUTOINCREMENT,
     conversation_id TEXT NOT NULL,
     msg_id          TEXT NOT NULL,
     role            TEXT NOT NULL,
     parts_json      TEXT NOT NULL,
     created_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_web_conversation_message_conv
     ON web_conversation_message (conversation_id, seq)`,
];

// ─── Messaging persistence helpers (MNEMO-46) ────────────────────────────────
// Thin typed CRUD over the `msg_session`/`msg_message` tables - NO business
// logic (the daily-bucketing + counterparty-keying lives one layer up in
// `src/messaging/persistence.ts`, which calls these).

/**
 * A row of `msg_session` (raw column shape; INTEGER columns marshal as numbers).
 * A `type` alias (not an `interface`) so it carries the implicit index signature
 * `sql.exec<T>` requires (`T extends Record<string, SqlStorageValue>`).
 */
export type MsgSessionRow = {
  id: string;
  counterparty: string;
  thread_id: string | null;
  channel: string;
  kind: string;
  day: string | null;
  created_at: number;
};

/** A row of `msg_message` (`seq` is the AUTOINCREMENT primary key). */
export type MsgMessageRow = {
  seq: number;
  session_id: string;
  from_id: string;
  direction: string;
  channel: string;
  body: string;
  ts: number;
};

/** Insert one `msg_session` row verbatim (the caller mints `id`). */
export function insertMsgSession(sql: SqlStorage, row: MsgSessionRow): void {
  sql.exec(
    `INSERT INTO msg_session
       (id, counterparty, thread_id, channel, kind, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.counterparty,
    row.thread_id,
    row.channel,
    row.kind,
    row.day,
    row.created_at,
  );
}

/**
 * Find the single session for `(counterparty, kind, day)`, or null. Uses `IS`
 * (not `=`) so a null `day` matches the NULL `day` of a group session - `= NULL`
 * is never true in SQL.
 */
export function findMsgSession(
  sql: SqlStorage,
  counterparty: string,
  kind: string,
  day: string | null,
): MsgSessionRow | null {
  const rows = sql
    .exec<MsgSessionRow>(
      `SELECT id, counterparty, thread_id, channel, kind, day, created_at
         FROM msg_session
        WHERE counterparty = ? AND kind = ? AND day IS ?`,
      counterparty,
      kind,
      day,
    )
    .toArray();
  return rows.length ? rows[0] : null;
}

/** Insert one `msg_message` row; returns it with its assigned `seq`. */
export function insertMsgMessage(
  sql: SqlStorage,
  row: Omit<MsgMessageRow, "seq">,
): MsgMessageRow {
  const inserted = sql
    .exec<MsgMessageRow>(
      `INSERT INTO msg_message
         (session_id, from_id, direction, channel, body, ts)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING seq, session_id, from_id, direction, channel, body, ts`,
      row.session_id,
      row.from_id,
      row.direction,
      row.channel,
      row.body,
      row.ts,
    )
    .one();
  return inserted as MsgMessageRow;
}

/** A `msg_session` row joined with its message count (for the session list). */
export type MsgSessionWithCount = MsgSessionRow & { message_count: number };

/** List every session, newest first, each with its message count. */
export function selectMsgSessions(sql: SqlStorage): MsgSessionWithCount[] {
  return sql
    .exec<MsgSessionWithCount>(
      `SELECT s.id, s.counterparty, s.thread_id, s.channel, s.kind, s.day,
              s.created_at, COUNT(m.seq) AS message_count
         FROM msg_session s
         LEFT JOIN msg_message m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC, s.id`,
    )
    .toArray();
}

/** List a session's messages in `seq` (chronological) order. */
export function selectMsgMessages(
  sql: SqlStorage,
  sessionId: string,
): MsgMessageRow[] {
  return sql
    .exec<MsgMessageRow>(
      `SELECT seq, session_id, from_id, direction, channel, body, ts
         FROM msg_message
        WHERE session_id = ?
        ORDER BY seq ASC`,
      sessionId,
    )
    .toArray();
}

// ─── Web conversation persistence helpers (MNEMO-35/36) ──────────────────────
// Thin typed CRUD over the `web_conversation`/`web_conversation_message` tables -
// NO business logic (title derivation, preview snippets, epoch→ISO mapping, and
// client-history dedupe live one layer up in `src/agent/conversations/store.ts`,
// which calls these).

/** A row of `web_conversation` (INTEGER timestamps marshal as numbers). */
export type WebConversationRow = {
  id: string;
  title: string;
  preview: string | null;
  created_at: number;
  updated_at: number;
};

/** A row of `web_conversation_message` (`seq` is the AUTOINCREMENT primary key). */
export type WebConversationMessageRow = {
  seq: number;
  conversation_id: string;
  msg_id: string;
  role: string;
  parts_json: string;
  created_at: number;
};

/** Insert one `web_conversation` row verbatim (the caller mints `id`). */
export function insertWebConversation(
  sql: SqlStorage,
  row: WebConversationRow,
): void {
  sql.exec(
    `INSERT INTO web_conversation (id, title, preview, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    row.id,
    row.title,
    row.preview,
    row.created_at,
    row.updated_at,
  );
}

/** Fetch one conversation by id, or null. */
export function findWebConversation(
  sql: SqlStorage,
  id: string,
): WebConversationRow | null {
  const rows = sql
    .exec<WebConversationRow>(
      `SELECT id, title, preview, created_at, updated_at
         FROM web_conversation WHERE id = ?`,
      id,
    )
    .toArray();
  return rows.length ? rows[0] : null;
}

/** List every conversation, most-recently-updated first. */
export function selectWebConversations(sql: SqlStorage): WebConversationRow[] {
  return sql
    .exec<WebConversationRow>(
      `SELECT id, title, preview, created_at, updated_at
         FROM web_conversation
        ORDER BY updated_at DESC, id`,
    )
    .toArray();
}

/**
 * Title-search conversations (case-insensitive substring), newest first. The
 * caller passes the already-wrapped `%term%` LIKE pattern (with `\` as the escape
 * char) so wildcard policy lives at the call site.
 */
export function searchWebConversations(
  sql: SqlStorage,
  like: string,
): WebConversationRow[] {
  return sql
    .exec<WebConversationRow>(
      `SELECT id, title, preview, created_at, updated_at
         FROM web_conversation
        WHERE title LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC, id`,
      like,
    )
    .toArray();
}

/** Rename one conversation; returns true if a row was updated. */
export function renameWebConversation(
  sql: SqlStorage,
  id: string,
  title: string,
  updatedAt: number,
): boolean {
  sql.exec(
    `UPDATE web_conversation SET title = ?, updated_at = ? WHERE id = ?`,
    title,
    updatedAt,
    id,
  );
  return sql.exec<{ n: number }>(`SELECT changes() AS n`).one().n === 1;
}

/** Bump a conversation's `updated_at` and cache its latest-message `preview`. */
export function touchWebConversation(
  sql: SqlStorage,
  id: string,
  preview: string,
  updatedAt: number,
): void {
  sql.exec(
    `UPDATE web_conversation SET preview = ?, updated_at = ? WHERE id = ?`,
    preview,
    updatedAt,
    id,
  );
}

/** Append one UI message to a conversation; returns its assigned `seq`. */
export function insertWebConversationMessage(
  sql: SqlStorage,
  row: Omit<WebConversationMessageRow, "seq">,
): WebConversationMessageRow {
  return sql
    .exec<WebConversationMessageRow>(
      `INSERT INTO web_conversation_message
         (conversation_id, msg_id, role, parts_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING seq, conversation_id, msg_id, role, parts_json, created_at`,
      row.conversation_id,
      row.msg_id,
      row.role,
      row.parts_json,
      row.created_at,
    )
    .one() as WebConversationMessageRow;
}

/** List one conversation's messages in `seq` (chronological) order. */
export function selectWebConversationMessages(
  sql: SqlStorage,
  conversationId: string,
): WebConversationMessageRow[] {
  return sql
    .exec<WebConversationMessageRow>(
      `SELECT seq, conversation_id, msg_id, role, parts_json, created_at
         FROM web_conversation_message
        WHERE conversation_id = ?
        ORDER BY seq ASC`,
      conversationId,
    )
    .toArray();
}

/**
 * Adapt the DO's `SqlStorage` to the shared {@link SqlDriver} surface
 * (`ddl`/`all`) that `src/audit/store.ts` and `GraphIndex` consume. The bound
 * `run` executes for both reads and writes; `toArray()` materializes rows (empty
 * for INSERT/UPDATE/DELETE without `RETURNING`), exactly as the node:sqlite
 * adapter does in tests - so one code path covers the DO and bare Node.
 */
export function sqlDriver(sql: SqlStorage): SqlDriver {
  const run = sql.exec.bind(sql);
  return {
    ddl(stmt: string): void {
      run(stmt);
    },
    all<T = Record<string, unknown>>(stmt: string, params: unknown[]): T[] {
      return run(stmt, ...params).toArray() as T[];
    },
  };
}

/**
 * Create the DO-SQLite schema if absent. Idempotent - safe on every wake. Owns
 * the agent's own meta table and delegates the memory graph tables to
 * `initGraphSchema` - keeping all DDL behind this single entry point.
 */
export function initAgentSchema(sql: SqlStorage): void {
  for (const stmt of SCHEMA) sql.exec(stmt);
  initGraphSchema(sqlDriver(sql));
}

/** Read one `agent_meta` value (raw JSON string), or null if the key is unset. */
export function getMeta(sql: SqlStorage, key: string): string | null {
  const rows = sql
    .exec<{ value: string }>("SELECT value FROM agent_meta WHERE key = ?", key)
    .toArray();
  return rows.length ? rows[0].value : null;
}

/** Upsert one `agent_meta` value. `valueJson` is stored verbatim. */
export function setMeta(sql: SqlStorage, key: string, valueJson: string): void {
  sql.exec(
    `INSERT INTO agent_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    valueJson,
  );
}
