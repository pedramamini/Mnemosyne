/**
 * Request-context middleware (MNEMO-50, PRD §3).
 *
 * Mounted FIRST in `src/index.ts` (before auth, before every route). For each
 * request it:
 *   1. mints (or honors an inbound) `requestId`,
 *   2. binds a request-scoped {@link Logger} carrying that id and stashes both on
 *      the Hono context (`c.set("requestId" | "log", …)`) for handlers to read,
 *   3. sets the `x-request-id` response header so the caller can quote it in a
 *      bug report, and
 *   4. emits one `http_request` access log on completion (method/path/status/ms).
 *
 * The same `requestId` is forwarded into DO calls (the chat passthrough copies it
 * onto the forwarded request alongside `x-mnemo-account`) so DO + audit logs
 * correlate with the edge access log on a single grep.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { newRequestId, withContext } from "./logger.ts";

/** Response header carrying the request id back to the caller. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Inbound headers we honor if already set by the edge/CDN (so a trace id minted
 * upstream of the Worker is preserved end to end). `cf-request-id` is Cloudflare's
 * own; `x-request-id` lets a proxy/test inject one.
 */
const INBOUND_ID_HEADERS = ["cf-request-id", REQUEST_ID_HEADER];

export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const inbound = INBOUND_ID_HEADERS.map((h) => c.req.header(h)).find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const requestId = inbound ?? newRequestId();
    const log = withContext({ requestId });

    c.set("requestId", requestId);
    c.set("log", log);
    c.header(REQUEST_ID_HEADER, requestId);

    const started = Date.now();
    await next();

    // Access log on completion. `c.res.status` reflects the final response (incl.
    // one shaped by the error handler). Fires when the handler returns its
    // Response - for a streamed/SSE body that is the moment the stream opens, not
    // when it closes, so this never holds the request open.
    log.info("http_request", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  };
}
