/**
 * Opaque sessions - a random id in KV (`sess:<id>` → `{ accountId }`) with a
 * 30-day TTL, surfaced to the browser as an HttpOnly cookie. The cookie carries
 * no account data: it is just the lookup key, so revocation is a KV delete.
 */
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Env } from "../env.ts";

export const SESSION_COOKIE = "mnemo_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Stored value behind a `sess:<id>` key. */
export interface Session {
  accountId: string;
}

const keyFor = (id: string) => `sess:${id}`;

/** Mint a new session for an account and persist it with a 30-day TTL. */
export async function createSession(
  env: Env,
  accountId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const session: Session = { accountId };
  await env.SESSIONS.put(keyFor(id), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return id;
}

/** Read a session by id, or `null` if absent/expired. */
export async function getSession(
  env: Env,
  id: string,
): Promise<Session | null> {
  const raw = await env.SESSIONS.get(keyFor(id));
  return raw === null ? null : (JSON.parse(raw) as Session);
}

/** Revoke a session (logout). Idempotent. */
export async function destroySession(env: Env, id: string): Promise<void> {
  await env.SESSIONS.delete(keyFor(id));
}

/** Set the session cookie: HttpOnly, Secure, SameSite=Lax, root path. */
export function setSessionCookie(c: Context, id: string): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
