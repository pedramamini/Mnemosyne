/**
 * AuditLog - the per-agent audit-log Durable Object (PRD §7.4/§8.6).
 *
 * One instance per agent via `env.AUDIT.idFromName(agentId)` (see
 * `getAuditStub` in `src/index.ts`) - a DEDICATED namespace, separate from the
 * `AGENT` DO of MNEMO-04, so the append-only audit index can be queried without
 * waking the agent loop. It is SQLite-backed (declared in a `new_sqlite_classes`
 * migration), so `ctx.storage.sql` + FTS5 are available.
 *
 * This file is intentionally THIN: it composes already-tested pieces. The
 * load-bearing append/filter/FTS5 SQL is the untouched `src/audit` spike
 * (`AuditStore` over a {@link DoSqlDriver}); fan-out is the {@link SseHub}. No
 * business logic lives here.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import { DoSqlDriver } from "./do-driver.ts";
import { type SseFilter, SseHub } from "./sse.ts";
import { AuditStore } from "./store.ts";
import type {
  AuditEvent,
  AuditInput,
  AuditLevel,
  AuditQuery,
  AuditType,
} from "./types.ts";

/**
 * The default altitude (PRD §6.7 progressive disclosure). When a stream/query
 * request omits `level`, the cockpit shows the calm `milestone` narration so it
 * is legible by default; an explicit `level=info` surfaces the "show the work"
 * detail and `level=error` isolates failures. The *altitude is a query concern* -
 * events are NOT stored differently per level; this is only the read-time default.
 * Shared with `src/audit/routes.ts` so the stream (parsed here) and the `/events`
 * query (defaulted in the route's schema) agree on one rubric.
 */
export const DEFAULT_AUDIT_LEVEL: AuditLevel = "milestone";

/**
 * How many missed events one reconnect can backfill (the store also caps this at
 * its own `MAX_LIMIT`). A brief drop replays in full; a very long outage is
 * bounded so a single reconnect can't replay an unbounded history.
 */
const STREAM_BACKFILL_LIMIT = 1000;

export class AuditLog extends DurableObject<Env> {
  /** The untouched spike store, over this DO's SQLite via {@link DoSqlDriver}. */
  private readonly store: AuditStore;
  /** Live SSE tail. Per-instance (a hibernated DO has no open sockets to keep). */
  private readonly hub = new SseHub();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // The agentId stamped onto every returned event is THIS DO's `idFromName`
    // key. We read it from `ctx.id.name` - it is populated for idFromName-created
    // IDs under our compatibility date (the `agents` SDK in this repo derives
    // `MnemosyneAgent.name` the same way), so there is no need to thread it
    // through every RPC call. (The MNEMO-20 spec assumed the name was not exposed
    // and prescribed accepting+persisting it on first call; it IS exposed, so we
    // take the simpler, signature-matching route.) A nameless id (direct
    // `idFromString`, not used here) degrades to "" rather than throwing.
    const agentId = ctx.id.name ?? "";
    this.store = new AuditStore(new DoSqlDriver(ctx.storage.sql), agentId);

    // Run the schema/FTS5/trigger DDL exactly once before any request is served.
    // `blockConcurrencyWhile` is the init guard: it gates all incoming work until
    // the (idempotent, IF NOT EXISTS) DDL has run on this wake.
    ctx.blockConcurrencyWhile(async () => {
      this.store.init();
    });
  }

  /** Append one event, fan it out to live subscribers, and return it (seq/id/ts assigned). */
  emit(input: AuditInput): AuditEvent {
    const event = this.store.append(input);
    this.hub.publish(event);
    return event;
  }

  /** Structured filter over the audit stream (chronological). */
  query(q: AuditQuery = {}): AuditEvent[] {
    return this.store.query(q);
  }

  /** Full-text search over event `text` via FTS5 (newest first). */
  search(text: string, limit = 50): AuditEvent[] {
    return this.store.search(text, limit);
  }

  /**
   * DO entrypoint. `GET .../stream` opens the live SSE tail with **reconnect
   * backfill** + server-side **filtering** + the **altitude default** (MNEMO-22):
   *
   *   - Reconnect cursor: the standard SSE `Last-Event-ID` header (what a browser
   *     `EventSource` resends), falling back to an explicit `?sinceSeq=`. The store
   *     uses `seq` as the SSE `id:` (MNEMO-20), so the cursor maps straight onto
   *     `sinceSeq` (exclusive). When present we `query` the missed events and the
   *     hub writes them into the new stream BEFORE registering it for the live tail
   *     - the client gets the gap, then resumes live, with no dupes and no gap (the
   *     DO is single-threaded and nothing is emitted between query and register).
   *   - Filters (`type` repeated, `level`, `sessionId`) apply to BOTH the backfill
   *     query AND a per-subscriber live predicate, so live frames are filtered too.
   *   - `level` defaults to {@link DEFAULT_AUDIT_LEVEL} when omitted (§6.7).
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/stream")) {
      return this.openStream(request, url);
    }
    return new Response("not found", { status: 404 });
  }

  /** Build the backfill + live filter for a `/stream` request and subscribe. */
  private openStream(request: Request, url: URL): Response {
    const { query, filter } = parseStreamFilters(url.searchParams);

    const cursor = readReconnectCursor(request, url);
    const backfill =
      cursor != null
        ? this.store.query({
            ...query,
            sinceSeq: cursor,
            limit: STREAM_BACKFILL_LIMIT,
          })
        : undefined;

    return this.hub.subscribe({ backfill, filter });
  }
}

/**
 * Parse `?type=&level=&sessionId=` into an {@link AuditQuery} (for the backfill)
 * and a matching live {@link SseFilter} - the two are derived together so the
 * backfilled gap and the live tail are filtered identically. `type` may repeat
 * (`?type=a&type=b`); `level` defaults to {@link DEFAULT_AUDIT_LEVEL} (§6.7), and
 * the sentinel `level=all` opts OUT of the altitude filter entirely (the "Show
 * the work" mode: milestone + info + error together over one stream).
 */
function parseStreamFilters(params: URLSearchParams): {
  query: Pick<AuditQuery, "types" | "level" | "sessionId">;
  filter: SseFilter;
} {
  const types = params.getAll("type") as AuditType[];
  const rawLevel = params.get("level");
  // `all` → no level filter; omitted → the calm milestone default; else the
  // explicit altitude. Keep `undefined` meaning "every level" so the store omits
  // the `level` clause and the live predicate skips the level check.
  const level: AuditLevel | undefined =
    rawLevel === "all"
      ? undefined
      : ((rawLevel as AuditLevel | null) ?? DEFAULT_AUDIT_LEVEL);
  const sessionId = params.get("sessionId") ?? undefined;

  const query: Pick<AuditQuery, "types" | "level" | "sessionId"> = {};
  if (level !== undefined) query.level = level;
  if (types.length) query.types = types;
  if (sessionId !== undefined) query.sessionId = sessionId;

  const filter: SseFilter = (event) =>
    (level === undefined || event.level === level) &&
    (types.length === 0 || types.includes(event.type)) &&
    (sessionId === undefined || event.sessionId === sessionId);

  return { query, filter };
}

/**
 * Resolve the reconnect cursor: the `Last-Event-ID` header (preferred - what an
 * `EventSource` resends), else an explicit `?sinceSeq=`. Returns `undefined` for
 * a missing/malformed value (a fresh stream with no backfill).
 */
function readReconnectCursor(request: Request, url: URL): number | undefined {
  const raw =
    request.headers.get("Last-Event-ID") ?? url.searchParams.get("sinceSeq");
  if (raw == null) return undefined;
  const seq = Number.parseInt(raw, 10);
  return Number.isFinite(seq) && seq >= 0 ? seq : undefined;
}
