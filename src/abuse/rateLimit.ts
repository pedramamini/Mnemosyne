/**
 * Declarative rate limiting (MNEMO-50, PRD §3 - public multi-tenant SaaS: abuse
 * controls + rate limiting in scope).
 *
 * A fixed-window counter over the `LIMITS` KV (the same namespace MNEMO-49 uses for
 * concurrency leases). Coarse per-IP limits guard UNAUTHENTICATED endpoints (auth,
 * the PSP webhook); per-account limits guard EXPENSIVE authenticated actions
 * (research, build, messaging). Config-first: add a bucket to {@link RATE_LIMITS}
 * and apply {@link rateLimitMiddleware} - no per-endpoint counter code.
 *
 * KV is eventually-consistent, so this is a SOFT bound (a determined attacker
 * racing the edge could overshoot a little) - exactly like the §8.4 concurrency
 * leases. That's acceptable for abuse control; it is not a security boundary. And
 * it **fails OPEN**: a KV fault logs + allows rather than bricking every request
 * (mirrors the MNEMO-49 admission gate).
 */
import type { Context, MiddlewareHandler } from "hono";
import { type AppEnv, getAccountId } from "../auth/middleware.ts";
import type { Env } from "../env.ts";
import { RateLimited } from "../errors/AppError.ts";

/** One bucket's policy: at most `limit` requests per `windowSec`-second fixed window. */
export interface RateLimitRule {
  limit: number;
  windowSec: number;
}

/**
 * The bucket catalog. Per-IP buckets guard unauthenticated endpoints; per-account
 * buckets guard expensive authenticated actions (the key function decides which -
 * see {@link byIp} / {@link byAccount}). Limits are deliberately generous: this
 * stops abuse/runaway loops, not normal use.
 */
export const RATE_LIMITS = {
  /** Magic-link requests - coarse per-IP (anti-enumeration / anti-spam). */
  auth_request: { limit: 5, windowSec: 15 * 60 },
  /** PSP webhook - per-IP; high because a busy account legitimately bursts. */
  billing_webhook: { limit: 60, windowSec: 60 },
  /** Research entry (Discovery start + a chat/research turn) - per account. */
  research_start: { limit: 30, windowSec: 60 },
  /** Agent build/provision - per account (provisioning is expensive). */
  build: { limit: 10, windowSec: 60 },
  /** Document upload/ingest - per account (conversion + brain seeding is costly). */
  documents_upload: { limit: 20, windowSec: 60 },
  /** Outbound messaging send - per account (Track H paid add-on). */
  messaging_send: { limit: 60, windowSec: 60 },
} satisfies Record<string, RateLimitRule>;

/** A configured bucket name. */
export type RateBucket = keyof typeof RATE_LIMITS;

/** Outcome of a {@link rateLimit} check. `retryAfter` is seconds (0 when allowed). */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Check (and on success, increment) the fixed-window counter for `bucket`/`key`.
 *
 * The KV key embeds the window start (`rl:<bucket>:<key>:<windowStart>`) so a new
 * window is a NEW key with a fresh count - no read-modify-delete needed - and the
 * key self-expires via `expirationTtl` just past the window. Fails OPEN on any KV
 * error.
 */
export async function rateLimit(
  env: Env,
  { bucket, key }: { bucket: RateBucket; key: string },
): Promise<RateLimitResult> {
  const rule = RATE_LIMITS[bucket];
  const now = Date.now();
  const windowMs = rule.windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const kvKey = `rl:${bucket}:${key}:${windowStart}`;

  try {
    const current =
      Number.parseInt((await env.LIMITS.get(kvKey)) ?? "0", 10) || 0;
    if (current >= rule.limit) {
      const retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(retryAfter, 1),
      };
    }
    const next = current + 1;
    // TTL just past the window so the key self-cleans; KV's floor is 60s.
    const ttl = Math.max(rule.windowSec + 1, 60);
    await env.LIMITS.put(kvKey, String(next), { expirationTtl: ttl });
    return { allowed: true, remaining: rule.limit - next, retryAfter: 0 };
  } catch (err) {
    // FAIL-OPEN: a rate-limit KV fault must never brick a legitimate request.
    console.warn(
      `rateLimit failed open for ${bucket}:${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { allowed: true, remaining: rule.limit, retryAfter: 0 };
  }
}

/** Key function: coarse per-IP (the client IP Cloudflare sets, falling back safely). */
export function byIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for") ??
    "unknown"
  );
}

/** Key function: per authenticated account. MUST sit AFTER `requireAuth`. */
export function byAccount(c: Context<AppEnv>): string {
  return getAccountId(c);
}

/**
 * Middleware factory: enforce `bucket` keyed by `keyFn`. Throws {@link RateLimited}
 * (→ the single error handler → 429 + `Retry-After`) when the window is exhausted;
 * otherwise sets an `X-RateLimit-Remaining` hint and continues.
 */
export function rateLimitMiddleware(
  bucket: RateBucket,
  keyFn: (c: Context<AppEnv>) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = await rateLimit(c.env, { bucket, key: keyFn(c) });
    if (!result.allowed) {
      throw new RateLimited(result.retryAfter);
    }
    c.header("X-RateLimit-Remaining", String(result.remaining));
    await next();
  };
}
