/**
 * Conversation API adapter (MNEMO-35/36) - the SINGLE point of contact with the
 * agent-chat backend. The rest of the conversation UI consumes the stable shapes
 * declared here; this file owns the exact route paths (mirrors `discovery.ts`).
 *
 * ── The backend contract (PRD §6.5 threaded conversations) ───────────────────
 * Threads live INSIDE the per-agent `MnemosyneAgent` Durable Object (keyed by
 * agentId) - many threads per agent, each its own transcript - so the chat loop
 * keeps direct brain/persona/tool access. Every route is therefore AGENT-SCOPED
 * (there is no bare `/conversations/:id`: an id alone can't resolve its DO):
 *
 *   listConversations(agentId)               →  GET   /agents/:agentId/conversations
 *   createConversation(agentId, msg?)         →  POST  /agents/:agentId/conversations { firstMessage? }
 *   getConversation(agentId, conversationId)  →  GET   /agents/:agentId/conversations/:conversationId
 *   renameConversation(agentId, cid, title)   →  PATCH /agents/:agentId/conversations/:conversationId { title }
 *   searchConversations(agentId, q)           →  GET   /agents/:agentId/conversations?q=<query>
 *   chatEndpoint(agentId, conversationId)     →  POST  /agents/:agentId/conversations/:conversationId/chat
 *                                                (the streaming DefaultChatTransport `api` target)
 *
 * The streaming turn POSTs the AI-SDK transport body (`{ messages }`) and reads
 * the `toUIMessageStreamResponse` UI-message SSE the DO emits, persisting the turn
 * into the named thread. If the paths ever change, change them HERE only - the
 * hook, components, and pages stay put.
 */
import { apiUrl, get, patch, post } from "./client";

/** A conversation is one thread within one agent (PRD §6.5). */
export interface Conversation {
  id: string;
  agentId: string;
  /** Human-editable thread title (rename via `renameConversation`). */
  title: string;
  created_at: string;
  updated_at: string;
  /** Short preview of the most recent message, for the list rail. */
  lastMessagePreview?: string;
}

export type MessageRole = "user" | "assistant";

/** A rendered text segment of a message (the only part type surfaced in v1). */
export interface TextPart {
  type: "text";
  text: string;
}

/** The payload of a `data-artifact` part - a reference to a rendered HTML view. */
export interface ArtifactData {
  artifactId: string;
  title: string;
  /** The artifact kind; only "html" exists today (rendered in a sandboxed iframe). */
  kind: string;
}

/**
 * An inline artifact reference (the renderHtml tool). An AI SDK v6 custom data
 * part: it streams live AND persists in `parts_json` with the SAME shape, and
 * `convertToModelMessages` ignores `data-*` parts so it never disturbs a later
 * model turn. The body itself is NOT inlined here - it's fetched into a sandboxed
 * iframe from the artifact raw URL by id (see `api/artifacts.ts`).
 */
export interface ArtifactPart {
  type: "data-artifact";
  /** Stream-reconciliation id (present on the streamed part; harmless if absent). */
  id?: string;
  data: ArtifactData;
}

/** The payload of a `data-tool` part - one tool the agent used during the turn. */
export interface ToolUseData {
  /** The tool's internal name (e.g. "webSearch", "runPython", "brain__…"). */
  tool: string;
  /** Plain-English one-liner for the chip (e.g. "Searching the web: …"). */
  summary: string;
}

/**
 * One tool the agent invoked this turn (MNEMO-37). Like `data-artifact`, it's an AI
 * SDK v6 custom data part: it streams live AND persists in `parts_json` with the
 * SAME shape, and `convertToModelMessages` ignores `data-*` parts so a tool chip in
 * history never disturbs a later model turn. Surfaces what the agent DID, not just
 * what it said.
 */
export interface ToolUsePart {
  type: "data-tool";
  /** Stream-reconciliation id (present on the streamed part; harmless if absent). */
  id?: string;
  data: ToolUseData;
}

/**
 * One part of a UI message, matching the MNEMO-15 persisted shape (Vercel AI SDK
 * `UIMessage` parts). Renders `text` + `data-artifact` + `data-tool` parts;
 * `reasoning`/native `tool` parts flow through untouched so a later ticket can
 * surface them without changing this contract.
 */
export type MessagePart =
  | TextPart
  | ArtifactPart
  | ToolUsePart
  | ({ type: string } & Record<string, unknown>);

/** Type guard: a part carries renderable assistant/user text. */
export function isTextPart(part: MessagePart): part is TextPart {
  return part.type === "text" && typeof (part as TextPart).text === "string";
}

/** Type guard: a part references a rendered HTML artifact to embed in an iframe. */
export function isArtifactPart(part: MessagePart): part is ArtifactPart {
  if (part.type !== "data-artifact") return false;
  const data = (part as ArtifactPart).data;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.artifactId === "string"
  );
}

/** Type guard: a part records a tool the agent used this turn (a `data-tool` chip). */
export function isToolPart(part: MessagePart): part is ToolUsePart {
  if (part.type !== "data-tool") return false;
  const data = (part as ToolUsePart).data;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.tool === "string" &&
    typeof data.summary === "string"
  );
}

/** Concatenate the text parts of a message (drops tool/reasoning parts). */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}

/** The HTML artifacts a message references, in order (drops everything else). */
export function messageArtifacts(message: ChatMessage): ArtifactData[] {
  return message.parts.filter(isArtifactPart).map((part) => part.data);
}

/**
 * The tools a message's turn invoked, in call order (drops everything else). Each
 * carries a stable `key` (the backend-minted part id) for React list rendering, so
 * the view never has to fall back to an array index.
 */
export function messageToolUses(
  message: ChatMessage,
): Array<ToolUseData & { key: string }> {
  return message.parts
    .filter(isToolPart)
    .map((part, i) => ({ ...part.data, key: part.id ?? `tool-${i}` }));
}

/** One persisted/streamed chat message (mirrors the MNEMO-15 `UIMessage`). */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  parts: MessagePart[];
}

/** A conversation plus its persisted message history (the `getConversation` result). */
export interface ConversationDetail extends Conversation {
  messages: ChatMessage[];
}

// ── Route builders (the single adapter point - adjust here if routes differ) ──

function agentConversationsPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/conversations`;
}

function conversationPath(agentId: string, conversationId: string): string {
  return `${agentConversationsPath(agentId)}/${encodeURIComponent(conversationId)}`;
}

/**
 * Absolute URL for the streaming chat transport (`DefaultChatTransport.api`): the
 * per-thread `POST /agents/:agentId/conversations/:conversationId/chat`. Never
 * called with the `"new"` sentinel - the page creates the thread first, then
 * streams into its real id (see {@link createConversation}).
 */
export function chatEndpoint(agentId: string, conversationId: string): string {
  return apiUrl(`${conversationPath(agentId, conversationId)}/chat`);
}

/** List an agent's conversations (caller sorts/filters; newest-first in the UI). */
export function listConversations(agentId: string): Promise<Conversation[]> {
  return get<Conversation[]>(agentConversationsPath(agentId));
}

/**
 * Create a new conversation for an agent. An optional `firstMessage` seeds the
 * thread (the backend persists it and runs the opening turn). Returns the new
 * conversation so the caller can navigate to its real id.
 */
export function createConversation(
  agentId: string,
  firstMessage?: string,
): Promise<Conversation> {
  return post<Conversation>(agentConversationsPath(agentId), { firstMessage });
}

/** Fetch one conversation's metadata + persisted message history. */
export function getConversation(
  agentId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  return get<ConversationDetail>(conversationPath(agentId, conversationId));
}

/** Rename a conversation (PATCH the title). */
export function renameConversation(
  agentId: string,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  return patch<Conversation>(conversationPath(agentId, conversationId), {
    title,
  });
}

/** Keyword-search an agent's conversations (PRD §6.5 filter-by-keyword). */
export function searchConversations(
  agentId: string,
  query: string,
): Promise<Conversation[]> {
  const path = `${agentConversationsPath(agentId)}?q=${encodeURIComponent(query)}`;
  return get<Conversation[]>(path);
}
