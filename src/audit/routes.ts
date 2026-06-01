/**
 * Audit-log HTTP surface (MNEMO-22, PRD §6.7/§7.4/§8.6 - the "glass cockpit").
 * Mounted at `/agents/:agentId/audit`, every route behind `requireAuth` (MNEMO-03)
 * plus an {@link assertOwnsAgent} guard (the requesting account must own the
 * agent - reuses the MNEMO-05 registry lookup). Three reads:
 *
 *   GET /stream            - live SSE tail with `Last-Event-ID`/`?sinceSeq=`
 *                            reconnect backfill + `type`/`level`/`sessionId`
 *                            filters. Proxies straight to the DO `fetch` and
 *                            returns the streamed `Response` untouched, so SSE
 *                            passes through the worker.
 *   GET /events?…          - structured filter → the DO `query` RPC → JSON array.
 *   GET /search?q=&limit=  - FTS5 search → the DO `search` RPC → JSON array.
 *
 * Routes are thin: Zod-validate + clamp at the boundary, then forward to the DO.
 * Filtering itself is NOT re-implemented here - the params map straight onto the
 * spike's `AuditQuery` and the DO forwards them to the untouched store.
 */
import { Hono } from "hono";
import { z } from "zod";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";
import type { Env } from "../env.ts";
import { DEFAULT_AUDIT_LEVEL } from "./AuditLog.ts";
import { getAuditStub } from "./index.ts";
import type { AuditEvent, AuditLevel, AuditQuery, AuditType } from "./types.ts";

// ─── Caps (match the store's own bounds so the boundary and the store agree) ──
/** `/events` page size: default 100, hard cap 1000 = `AuditStore.MAX_LIMIT`. */
const EVENTS_LIMIT_DEFAULT = 100;
const EVENTS_LIMIT_MAX = 1000;
/** `/search` page size: default 50, hard cap 200 = the store's search cap. */
const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 200;
/** Upper bound on the raw search term. The store already quotes it as an FTS
 * phrase (injection-safe, spike-tested); we only bound its length here. */
const SEARCH_Q_MAX = 256;

// ─── Zod enums (keep in lockstep with the unions in types.ts) ─────────────────
// `satisfies` rejects an entry that is not a valid AuditLevel/AuditType; a new
// union member added in types.ts must also be listed here to be queryable.
const AUDIT_LEVELS = [
  "info",
  "milestone",
  "error",
] as const satisfies readonly AuditLevel[];
const AUDIT_TYPES = [
  "session.started",
  "session.completed",
  "source.read",
  "memory.wrote",
  "memory.linked",
  "memory.consolidated",
  "tool.authored",
  "tool.ran",
  "report.generated",
  "chart.rendered",
  "narration",
  "error",
] as const satisfies readonly AuditType[];

const AuditTypeEnum = z.enum(AUDIT_TYPES);

/**
 * The altitude `level` as accepted on the wire: the three real levels PLUS the
 * sentinel `"all"`, which means "no level filter" (every altitude). This is the
 * §6.7 "Show the work" mode - the calm `milestone` default is the subset shown
 * by default, and `all` reveals milestone + info + error together over a single
 * stream/query. Omitting `level` still defaults to {@link DEFAULT_AUDIT_LEVEL}
 * (the calm narration); `all` is the only way to opt OUT of the altitude filter.
 */
const STREAM_LEVEL_ALL = "all";
const AuditLevelQueryEnum = z.enum([
  ...AUDIT_LEVELS,
  STREAM_LEVEL_ALL,
] as const);

/**
 * `/events` query. Numeric params are coerced (they arrive as strings) and
 * `type`/`level` validated against the unions - an unknown value is a 400, never
 * silently dropped. `level` defaults to {@link DEFAULT_AUDIT_LEVEL} (§6.7 altitude
 * default); `limit` is clamped server-side (not via the schema) so an over-cap
 * value is bounded rather than rejected.
 */
const EventsQuery = z.object({
  type: z.array(AuditTypeEnum).optional(),
  level: AuditLevelQueryEnum.default(DEFAULT_AUDIT_LEVEL),
  sessionId: z.string().trim().min(1).optional(),
  sinceSeq: z.coerce.number().int().nonnegative().optional(),
  fromTs: z.coerce.number().int().nonnegative().optional(),
  toTs: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * `/stream` filter params. Validated then forwarded verbatim to the DO `fetch`
 * (which applies the `level` altitude default + reads the `Last-Event-ID`/
 * `sinceSeq` cursor), so `level` is left optional here - no double-defaulting.
 */
const StreamQuery = z.object({
  type: z.array(AuditTypeEnum).optional(),
  level: AuditLevelQueryEnum.optional(),
  sessionId: z.string().trim().min(1).optional(),
  sinceSeq: z.coerce.number().int().nonnegative().optional(),
});

/** `/search` query - a required, length-bounded term plus an optional limit. */
const SearchQuery = z.object({
  q: z.string().trim().min(1, "q is required").max(SEARCH_Q_MAX),
  limit: z.coerce.number().int().positive().optional(),
});

/**
 * The DO read surface the routes drive. Declared structurally (NOT as
 * `DurableObjectStub<AuditLog>`) for the same reason as {@link AuditEmitTarget}:
 * the native RPC stub can't type `query`/`search` because the spike's
 * `AuditEvent.payload: Record<string, unknown>` is not RPC-type-serializable
 * (`unknown` → `never`). This is the one read-side bridge past that seam - the
 * cast lives here, not at the call sites.
 */
interface AuditReader {
  query(q: AuditQuery): Promise<AuditEvent[]>;
  search(text: string, limit?: number): Promise<AuditEvent[]>;
}

function auditReader(env: Env, agentId: string): AuditReader {
  return getAuditStub(env, agentId) as unknown as AuditReader;
}

export function auditRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the whole group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/audit/*", requireAuth());

  // GET /stream - live SSE tail. Validate the filter params, then proxy the RAW
  // request to the DO and return its streamed Response directly: the SSE body,
  // the `Last-Event-ID` header, and `?sinceSeq=`/filters all pass through
  // untouched (the DO does the backfill + filtering + altitude default).
  app.get("/agents/:agentId/audit/stream", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = StreamQuery.safeParse({
      type: c.req.queries("type"),
      level: c.req.query("level"),
      sessionId: c.req.query("sessionId"),
      sinceSeq: c.req.query("sinceSeq"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }

    return getAuditStub(c.env, agentId).fetch(c.req.raw);
  });

  // GET /events - structured filter → the DO `query` RPC → JSON array.
  app.get("/agents/:agentId/audit/events", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = EventsQuery.safeParse({
      type: c.req.queries("type"),
      level: c.req.query("level"),
      sessionId: c.req.query("sessionId"),
      sinceSeq: c.req.query("sinceSeq"),
      fromTs: c.req.query("fromTs"),
      toTs: c.req.query("toTs"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }

    const query: AuditQuery = {
      types: parsed.data.type,
      // `all` opts out of the altitude filter (every level); the store omits the
      // `level` clause when it is undefined, so map the sentinel back to undefined.
      level:
        parsed.data.level === STREAM_LEVEL_ALL ? undefined : parsed.data.level,
      sessionId: parsed.data.sessionId,
      sinceSeq: parsed.data.sinceSeq,
      fromTs: parsed.data.fromTs,
      toTs: parsed.data.toTs,
      limit: Math.min(
        parsed.data.limit ?? EVENTS_LIMIT_DEFAULT,
        EVENTS_LIMIT_MAX,
      ),
    };
    const events = await auditReader(c.env, agentId).query(query);
    return c.json(events);
  });

  // GET /search - FTS5 search → the DO `search` RPC → JSON array.
  app.get("/agents/:agentId/audit/search", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = SearchQuery.safeParse({
      q: c.req.query("q"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }

    const limit = Math.min(
      parsed.data.limit ?? SEARCH_LIMIT_DEFAULT,
      SEARCH_LIMIT_MAX,
    );
    const hits = await auditReader(c.env, agentId).search(parsed.data.q, limit);
    return c.json(hits);
  });

  return app;
}
