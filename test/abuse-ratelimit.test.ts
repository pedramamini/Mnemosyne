/**
 * MNEMO-50 - declarative rate limiting over the LIMITS KV.
 *
 * `rateLimit` allows up to the bucket limit then denies with a positive
 * `retryAfter`; a new fixed window resets the count (mocked clock); a
 * `rateLimitMiddleware`-protected route returns 429 + `Retry-After` past its limit;
 * and two keys have independent budgets.
 */
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  byIp,
  RATE_LIMITS,
  rateLimit,
  rateLimitMiddleware,
} from "../src/abuse/rateLimit.ts";
import type { AppEnv } from "../src/auth/middleware.ts";
import { errorHandler } from "../src/errors/handler.ts";
import { requestContext } from "../src/obs/requestContext.ts";

/** Unique key per test so the shared LIMITS namespace doesn't bleed across cases. */
function freshKey(): string {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rateLimit", () => {
  it("allows up to the bucket limit, then denies with a positive retryAfter", async () => {
    const key = freshKey();
    const limit = RATE_LIMITS.auth_request.limit;
    for (let i = 0; i < limit; i++) {
      const r = await rateLimit(env, { bucket: "auth_request", key });
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(limit - (i + 1));
    }
    const denied = await rateLimit(env, { bucket: "auth_request", key });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfter).toBeGreaterThan(0);
  });

  it("resets the count in a new fixed window (mocked clock)", async () => {
    const key = freshKey();
    const limit = RATE_LIMITS.auth_request.limit;
    const windowMs = RATE_LIMITS.auth_request.windowSec * 1000;
    const base = 1_000_000_000_000; // a fixed window start

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    for (let i = 0; i < limit; i++) {
      expect(
        (await rateLimit(env, { bucket: "auth_request", key })).allowed,
      ).toBe(true);
    }
    expect(
      (await rateLimit(env, { bucket: "auth_request", key })).allowed,
    ).toBe(false);

    // Advance past the window → a new key/window → a fresh budget.
    nowSpy.mockReturnValue(base + windowMs + 1);
    expect(
      (await rateLimit(env, { bucket: "auth_request", key })).allowed,
    ).toBe(true);
  });

  it("gives two different keys independent budgets", async () => {
    const a = freshKey();
    const b = freshKey();
    const limit = RATE_LIMITS.auth_request.limit;
    for (let i = 0; i < limit; i++) {
      await rateLimit(env, { bucket: "auth_request", key: a });
    }
    // a is exhausted…
    expect(
      (await rateLimit(env, { bucket: "auth_request", key: a })).allowed,
    ).toBe(false);
    // …but b is untouched.
    expect(
      (await rateLimit(env, { bucket: "auth_request", key: b })).allowed,
    ).toBe(true);
  });
});

describe("rateLimitMiddleware", () => {
  function guardedApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("*", requestContext());
    app.onError(errorHandler);
    app.use("/guarded", rateLimitMiddleware("auth_request", byIp));
    app.get("/guarded", (c) => c.text("ok"));
    return app;
  }

  it("returns 429 + Retry-After once the per-IP limit is exceeded", async () => {
    const app = guardedApp();
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const init = { headers: { "cf-connecting-ip": ip } };
    const limit = RATE_LIMITS.auth_request.limit;

    for (let i = 0; i < limit; i++) {
      const ok = await app.request("/guarded", init, env);
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request("/guarded", init, env);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });
});
