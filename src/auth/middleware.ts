/**
 * `requireAuth` - gate a route on a valid session cookie.
 *
 * Reads the `mnemo_session` cookie, loads the session from KV, and on success
 * stashes the account id on the context for handlers to read via `getAccountId`.
 * Any failure (no cookie, unknown/expired session) is a 401 JSON response -
 * the handler never runs.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env.ts";
import type { Logger } from "../obs/logger.ts";
import { getSession, SESSION_COOKIE } from "./sessions.ts";

/**
 * Context Variables available to downstream handlers.
 * - `requestId`/`log` are bound FIRST by `requestContext` (MNEMO-50), mounted before
 *   auth, so every handler can read a request-scoped logger.
 * - `accountId` is set by `requireAuth` once a session is verified.
 */
export interface AuthVariables {
  accountId: string;
  /** Edge-minted correlation id (MNEMO-50); set by `requestContext`. */
  requestId: string;
  /** Request-scoped structured logger bound to `requestId` (MNEMO-50). */
  log: Logger;
}

/** Hono app/context shape for authenticated routes. */
export type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Middleware that 401s unless a valid session cookie is present. */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const session = await getSession(c.env, id);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("accountId", session.accountId);
    await next();
  };
}

/**
 * Read the authenticated account id inside a `requireAuth`-protected handler.
 * Throws if called on an unprotected route (programmer error, not user input).
 */
export function getAccountId(c: Context<AppEnv>): string {
  const accountId = c.get("accountId");
  if (!accountId) {
    throw new Error("getAccountId called without requireAuth on the route");
  }
  return accountId;
}
