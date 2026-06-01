/**
 * Audit API adapter (MNEMO-37) - the SINGLE point of contact with the MNEMO-22
 * audit-log backend (the "glass cockpit"). The rest of the cockpit UI consumes
 * the stable, idealized shapes declared here; this file absorbs the fact that the
 * real backend wire shape differs (mirrors the `discovery.ts`/`conversations.ts`
 * adapter pattern). The SSE stream lives in its sibling `auditStream.ts` and
 * reuses {@link toAuditEvent} so REST and stream agree on one mapping.
 *
 * ── How the real MNEMO-22 contract differs (and how we adapt) ────────────────
 * MNEMO-22 mounts three reads under `/agents/:agentId/audit` (every route behind
 * the session + ownership guard):
 *
 *   our fetchAuditPage(id, opts)   →  GET /agents/:id/audit/events?<filters>
 *                                     ⇒ a bare `BackendAuditEvent[]` (ascending by
 *                                       seq). We map each row + derive `nextSeq`
 *                                       (the page has no envelope of its own).
 *   our searchAudit(id, q, opts)   →  GET /agents/:id/audit/search?q=&limit=
 *                                     ⇒ a bare `BackendAuditEvent[]` (newest-first,
 *                                       FTS5 over the human summary).
 *   (the live tail)                →  GET /agents/:id/audit/stream  (see auditStream.ts)
 *
 * The backend event is `{ seq, id, agentId, ts (epoch ms), type, level,
 * sessionId: string|null, text, payload }`. We expose the cockpit-facing
 * `AuditEvent` where the human `text` is `summary` (drives the calm view) and the
 * structured `payload` is `detail` (the raw bash/Python/reasoning for "show the
 * work"); `ts` becomes an ISO string and a null `sessionId` becomes `""`.
 *
 * Altitude: the backend `level` filter is EXACT-match and defaults to `milestone`
 * (§6.7 calm default). The "Show the work" altitude needs EVERY level over one
 * query/stream, so MNEMO-22 accepts the sentinel `level=all` ("no level filter").
 * We model that as {@link AuditAltitude} = `"milestone" | "all"` and pass it as the
 * `level` query param. If MNEMO-22's routes evolve, change them HERE only.
 */
import { get } from "./client";

/** Read-time altitude (§6.7 progressive disclosure). `milestone` = calm only;
 * `info`/`error` surface "show the work" detail. (Mirrors the backend union.) */
export type AuditLevel = "milestone" | "info" | "error";

/** Event categories (§6.7). Kept in lockstep with the backend `AuditType` union. */
export type AuditEventType =
  | "session.started"
  | "session.completed"
  | "source.read"
  | "memory.wrote"
  | "memory.linked"
  | "memory.consolidated"
  | "tool.authored"
  | "tool.ran"
  | "report.generated"
  | "chart.rendered"
  | "onboarding.phase"
  | "assessment.completed"
  | "self.revised"
  | "narration"
  | "error";

/**
 * The altitude the cockpit reads at: `milestone` (the calm narrated default) or
 * `all` (the §6.7 "Show the work" everything-mode - milestone + info + error).
 * Passed straight through as the `level` query param; `all` is the MNEMO-22
 * sentinel that opts out of the altitude filter.
 */
export type AuditAltitude = "milestone" | "all";

/** Structured "show the work" detail carried on an event (the raw work). */
export interface AuditEventDetail {
  /** A shell command the agent ran. */
  command?: string;
  /** Source code the agent authored/executed (e.g. a self-authored tool). */
  code?: string;
  /** The agent's plain-language reasoning. */
  reasoning?: string;
  /** Captured command/tool output (may be long - rows truncate-with-expand). */
  output?: string;
  [k: string]: unknown;
}

/**
 * One cockpit-facing audit event. `summary` (the human one-liner) drives the calm
 * milestone view; `detail` carries the raw command/code/reasoning/output revealed
 * by the "Show the work" altitude. Events carry a monotonic `seq` (ordering +
 * the streaming/reconnect cursor).
 */
export interface AuditEvent {
  seq: number;
  /** ISO-8601 timestamp (mapped from the backend's epoch-ms `ts`). */
  ts: string;
  type: AuditEventType;
  level: AuditLevel;
  /** Groups events from one research run; `""` when the backend `sessionId` is null. */
  sessionId: string;
  summary: string;
  detail?: AuditEventDetail;
}

/** Type/session/time filters (the altitude `level` is owned separately). */
export interface AuditFilters {
  /** Restrict to these event types (omit/empty = all types). */
  type?: AuditEventType[];
  /** Restrict to one research run (omit = all sessions). */
  sessionId?: string;
  /** Lower time bound, epoch ms inclusive (maps to the backend `fromTs`). */
  from?: number;
  /** Upper time bound, epoch ms inclusive (maps to the backend `toTs`). */
  to?: number;
}

/** A page of events plus the cursor to resume from (max seq seen, for the stream). */
export interface AuditPage {
  events: AuditEvent[];
  /** The highest `seq` in this page - pass as `sinceSeq` to fetch/stream onward. */
  nextSeq: number;
}

/** Options for {@link fetchAuditPage} (filters + the altitude + paging cursor). */
export interface FetchAuditPageOptions extends AuditFilters {
  /** Exclusive cursor - return only events with `seq > sinceSeq` (forward paging). */
  sinceSeq?: number;
  /** Altitude (`level` query param); omit for the backend's calm milestone default. */
  level?: AuditAltitude;
  /** Page size (backend default 100, hard cap 1000). */
  limit?: number;
}

// ── Backend wire shape (MNEMO-22), kept local to this adapter ─────────────────

/** The raw row MNEMO-22 returns. `ts` is epoch ms; `text`/`payload` map to summary/detail. */
export interface BackendAuditEvent {
  seq: number;
  id: string;
  agentId: string;
  ts: number;
  type: AuditEventType;
  level: AuditLevel;
  sessionId: string | null;
  text: string;
  payload: Record<string, unknown>;
}

/**
 * Map one backend row onto the cockpit-facing {@link AuditEvent}. Exported so the
 * SSE stream client (`auditStream.ts`) decodes `data:` frames identically - one
 * source of truth for the wire→UI mapping. An empty `payload` becomes `undefined`
 * `detail` so rows stay clean (no empty disclosure to expand).
 */
export function toAuditEvent(row: BackendAuditEvent): AuditEvent {
  const hasDetail = row.payload != null && Object.keys(row.payload).length > 0;
  return {
    seq: row.seq,
    ts: new Date(row.ts).toISOString(),
    type: row.type,
    level: row.level,
    sessionId: row.sessionId ?? "",
    summary: row.text,
    detail: hasDetail ? (row.payload as AuditEventDetail) : undefined,
  };
}

function auditPath(agentId: string, sub: string): string {
  return `/agents/${encodeURIComponent(agentId)}/audit/${sub}`;
}

/** Build the `/events` query string from filters + altitude + cursor. */
function eventsQuery(opts: FetchAuditPageOptions): string {
  const params = new URLSearchParams();
  if (opts.sinceSeq != null) params.set("sinceSeq", String(opts.sinceSeq));
  for (const t of opts.type ?? []) params.append("type", t);
  if (opts.level) params.set("level", opts.level);
  if (opts.sessionId) params.set("sessionId", opts.sessionId);
  if (opts.from != null) params.set("fromTs", String(opts.from));
  if (opts.to != null) params.set("toTs", String(opts.to));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch one filtered page of audit events (the MNEMO-22 `/events` query). Returns
 * the mapped events (ascending by seq) plus `nextSeq` (the highest seq seen, or
 * the requested `sinceSeq` when the page is empty) so the caller can stream/page
 * onward without re-reading what it already has.
 */
export async function fetchAuditPage(
  agentId: string,
  opts: FetchAuditPageOptions = {},
): Promise<AuditPage> {
  const rows = await get<BackendAuditEvent[]>(
    `${auditPath(agentId, "events")}${eventsQuery(opts)}`,
  );
  const events = rows.map(toAuditEvent);
  const nextSeq = events.length
    ? events[events.length - 1].seq
    : (opts.sinceSeq ?? 0);
  return { events, nextSeq };
}

/** Optional bounds for {@link searchAudit}. */
export interface AuditSearchOptions {
  /** Max results (backend default 50, hard cap 200). */
  limit?: number;
}

/**
 * Full-text search over the human `summary` (the MNEMO-22 `/search` FTS5 query,
 * newest-first). NB: the backend search is NOT level-filtered - the active
 * altitude governs only whether each result's `detail` is revealed (handled by
 * the row component), so search spans every altitude regardless.
 */
export async function searchAudit(
  agentId: string,
  query: string,
  opts: AuditSearchOptions = {},
): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const rows = await get<BackendAuditEvent[]>(
    `${auditPath(agentId, "search")}?${params.toString()}`,
  );
  return rows.map(toAuditEvent);
}
