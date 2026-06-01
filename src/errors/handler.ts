/**
 * The single error + not-found handlers (MNEMO-50, PRD §3).
 *
 * Extracted from `src/index.ts` so the exact production handlers are exercised by
 * `test/errors.test.ts` (mounted on a throwaway app) - no drift between what runs
 * and what's tested.
 *
 * `errorHandler` is the one place an exception becomes a response: normalize via
 * `toAppError`, log the FULL detail (with `requestId`), count 5xx, and return a
 * SAFE body `{ error: { code, message, requestId } }` - `internalDetail` is logged,
 * never serialized. `notFoundHandler` returns the same typed shape for a 404.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../auth/middleware.ts";
import { log as rootLog } from "../obs/logger.ts";
import { counter, METRICS } from "../obs/metrics.ts";
import { toAppError } from "./AppError.ts";

/** Hono `onError` handler: typed error → safe JSON response. */
export function errorHandler(err: unknown, c: Context<AppEnv>): Response {
  const appErr = toAppError(err);
  const requestId = c.get("requestId");

  // Log the FULL detail server-side (code + internalDetail + requestId). The
  // request-scoped logger already carries requestId; fall back to the root logger
  // if the error fired before `requestContext` bound one.
  const logger = c.get("log");
  const detail = {
    code: appErr.code,
    status: appErr.httpStatus,
    internalDetail: appErr.internalDetail,
  };
  if (logger) logger.error("request_error", detail);
  else rootLog("error", "request_error", { requestId, ...detail });

  // A 5xx that escaped to the boundary is a server fault - count it (tagged by code).
  if (appErr.httpStatus >= 500)
    counter(METRICS.HTTP_5XX, 1, { code: appErr.code });

  if (appErr.retryAfter !== undefined) {
    c.header("Retry-After", String(appErr.retryAfter));
  }

  return c.json(
    { error: { code: appErr.code, message: appErr.publicMessage, requestId } },
    appErr.httpStatus as ContentfulStatusCode,
  );
}

/** Hono `notFound` handler: a typed 404 in the same envelope as `errorHandler`. */
export function notFoundHandler(c: Context<AppEnv>): Response {
  return c.json(
    {
      error: {
        code: "not_found",
        message: "Not found",
        requestId: c.get("requestId"),
      },
    },
    404,
  );
}
