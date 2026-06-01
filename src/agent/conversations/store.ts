/**
 * Web conversation store (MNEMO-35/36, PRD §6.5) - the business layer over the
 * `web_conversation`/`web_conversation_message` DO-SQLite CRUD in
 * `src/agent/sql.ts`. It owns what the raw helpers deliberately don't: deriving a
 * thread title from the opening message, caching a list-rail preview, mapping the
 * stored epoch-ms timestamps to the ISO strings the web contract uses, and
 * (de)serializing the Vercel AI SDK `UIMessage` parts.
 *
 * Threads live INSIDE the per-agent DO (keyed by agentId), so the chat loop keeps
 * direct access to the brain/persona/tools - unlike the agents SDK's single flat
 * message log, these tables carry many threads per agent. The DO calls these from
 * its conversation RPC methods + the streaming chat turn; the route layer only
 * shapes HTTP around the returned values.
 */
import type { UIMessage } from "ai";
import {
  findWebConversation,
  insertWebConversation,
  insertWebConversationMessage,
  renameWebConversation as renameWebConversationRow,
  searchWebConversations as searchWebConversationRows,
  selectWebConversationMessages,
  selectWebConversations,
  touchWebConversation,
  type WebConversationMessageRow,
} from "../sql.ts";

/** Max characters for a derived title / cached preview snippet. */
const TITLE_MAX = 60;
const PREVIEW_MAX = 140;
/** Title shown for a thread started without an opening message. */
const DEFAULT_TITLE = "New conversation";

/** One conversation thread, as the web contract (`/conversations`) exposes it. */
export interface ConversationSummary {
  id: string;
  agentId: string;
  title: string;
  /** ISO-8601 (the frontend parses with `new Date(...)`). */
  created_at: string;
  updated_at: string;
  /** Snippet of the latest message, for the conversation-list rail. */
  lastMessagePreview?: string;
}

/**
 * A persisted UI message (the `UIMessage` subset the transcript stores). `parts`
 * is intentionally typed `unknown[]` rather than `UIMessage["parts"]`: that AI-SDK
 * union is deeply recursive and, when carried across the Durable Object RPC stub
 * (the `getConversation` return), trips TS's "excessively deep" instantiation
 * guard. The bytes on the wire are unchanged; the frontend casts to its own part
 * types. The DO casts back to `UIMessage` only for the (local) model turn.
 */
export interface StoredMessage {
  id: string;
  role: string;
  parts: unknown[];
}

/** A conversation plus its full persisted transcript (the `getConversation` result). */
export interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[];
}

/** Concatenate a UI message's text parts (drops tool/reasoning parts). */
function textOf(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
}

/** Clamp + single-line a string for a title/preview, appending an ellipsis when cut. */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Map a stored row to the API summary shape (epoch-ms → ISO, agentId injected). */
function toSummary(
  agentId: string,
  row: {
    id: string;
    title: string;
    preview: string | null;
    created_at: number;
    updated_at: number;
  },
): ConversationSummary {
  return {
    id: row.id,
    agentId,
    title: row.title,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    ...(row.preview ? { lastMessagePreview: row.preview } : {}),
  };
}

/** Map a stored message row back to the transcript shape (for the model + web UI). */
function toStoredMessage(row: WebConversationMessageRow): StoredMessage {
  return {
    id: row.msg_id,
    role: row.role,
    parts: JSON.parse(row.parts_json) as unknown[],
  };
}

/** Create a new thread; an opening `firstMessage` seeds the title only (not the transcript). */
export function createConversation(
  sql: SqlStorage,
  agentId: string,
  input: { firstMessage?: string; now: number },
): ConversationSummary {
  const id = crypto.randomUUID();
  const title = input.firstMessage?.trim()
    ? snippet(input.firstMessage, TITLE_MAX)
    : DEFAULT_TITLE;
  insertWebConversation(sql, {
    id,
    title,
    preview: null,
    created_at: input.now,
    updated_at: input.now,
  });
  return toSummary(agentId, {
    id,
    title,
    preview: null,
    created_at: input.now,
    updated_at: input.now,
  });
}

/**
 * Ensure a thread row exists (defensive upsert for the streaming chat turn - the
 * create-first UI flow normally makes it, but a direct/replayed POST shouldn't
 * 404). Returns the existing or freshly-created summary.
 */
export function ensureConversation(
  sql: SqlStorage,
  agentId: string,
  id: string,
  input: { titleSeed?: string; now: number },
): ConversationSummary {
  const existing = findWebConversation(sql, id);
  if (existing) return toSummary(agentId, existing);
  const title = input.titleSeed?.trim()
    ? snippet(input.titleSeed, TITLE_MAX)
    : DEFAULT_TITLE;
  insertWebConversation(sql, {
    id,
    title,
    preview: null,
    created_at: input.now,
    updated_at: input.now,
  });
  return toSummary(agentId, {
    id,
    title,
    preview: null,
    created_at: input.now,
    updated_at: input.now,
  });
}

/** List the agent's threads, newest-updated first. */
export function listConversations(
  sql: SqlStorage,
  agentId: string,
): ConversationSummary[] {
  return selectWebConversations(sql).map((row) => toSummary(agentId, row));
}

/** Title-search the agent's threads (case-insensitive substring), newest first. */
export function searchConversations(
  sql: SqlStorage,
  agentId: string,
  query: string,
): ConversationSummary[] {
  // Escape the LIKE metacharacters so a user's `%`/`_`/`\` is matched literally.
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return searchWebConversationRows(sql, `%${escaped}%`).map((row) =>
    toSummary(agentId, row),
  );
}

/** Fetch one thread's metadata + full transcript, or null if it doesn't exist. */
export function getConversationDetail(
  sql: SqlStorage,
  agentId: string,
  id: string,
): ConversationDetail | null {
  const row = findWebConversation(sql, id);
  if (!row) return null;
  return {
    ...toSummary(agentId, row),
    messages: selectWebConversationMessages(sql, id).map(toStoredMessage),
  };
}

/** Rename a thread; returns the updated summary, or null if it doesn't exist. */
export function renameConversation(
  sql: SqlStorage,
  agentId: string,
  id: string,
  title: string,
  now: number,
): ConversationSummary | null {
  const ok = renameWebConversationRow(sql, id, title, now);
  if (!ok) return null;
  const row = findWebConversation(sql, id);
  return row ? toSummary(agentId, row) : null;
}

/** Load a thread's transcript as `UIMessage[]` to seed the model turn. */
export function loadConversationMessages(
  sql: SqlStorage,
  id: string,
): UIMessage[] {
  return selectWebConversationMessages(sql, id).map(
    (row) => toStoredMessage(row) as unknown as UIMessage,
  );
}

/**
 * Persist one UI message to a thread and bump the thread's recency + preview. Used
 * for both the inbound user turn and the streamed assistant reply, so the list
 * rail and ordering stay current after every turn.
 */
export function appendMessage(
  sql: SqlStorage,
  id: string,
  message: StoredMessage,
  now: number,
): void {
  insertWebConversationMessage(sql, {
    conversation_id: id,
    msg_id: message.id,
    role: message.role,
    parts_json: JSON.stringify(message.parts),
    created_at: now,
  });
  touchWebConversation(
    sql,
    id,
    snippet(textOf(message.parts), PREVIEW_MAX),
    now,
  );
}

/** The set of message ids already persisted for a thread (client-history dedupe). */
export function persistedMessageIds(sql: SqlStorage, id: string): Set<string> {
  return new Set(
    selectWebConversationMessages(sql, id).map((row) => row.msg_id),
  );
}
