/**
 * Magic-link auth routes, mounted on the main Hono app.
 *
 *   POST /auth/request   - { email } → upsert account, issue token, mail link.
 *                          Always 200 (no email enumeration).
 *   GET  /auth/callback  - ?token=… → consume token, open session, set cookie,
 *                          redirect into the app (/agents).
 *   POST /auth/logout    - revoke session, clear cookie.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { byIp, rateLimitMiddleware } from "../abuse/rateLimit.ts";
import { ensureFreeSubscription } from "../billing/subscriptions.ts";
import { findOrCreateAccount } from "../db/index.ts";
import { sendMagicLink } from "../email/resend.ts";
import type { AppEnv } from "./middleware.ts";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  SESSION_COOKIE,
  setSessionCookie,
} from "./sessions.ts";
import { consumeMagicToken, issueMagicToken } from "./tokens.ts";

const RequestBody = z.object({ email: z.email() });

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // MNEMO-50: coarse per-IP limit on the unauthenticated magic-link endpoint
  // (anti-enumeration / anti-spam). Throws RateLimited → 429 + Retry-After.
  app.use("/auth/request", rateLimitMiddleware("auth_request", byIp));

  app.post("/auth/request", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RequestBody.safeParse(body);
    // A malformed body is a 400 (bad input), not an enumeration signal - every
    // syntactically valid email gets the same 200 regardless of registration.
    if (!parsed.success) return c.json({ error: "invalid email" }, 400);

    const email = parsed.data.email.trim().toLowerCase();
    await findOrCreateAccount(c.env, email);
    const token = await issueMagicToken(c.env, email);
    const url = `${c.env.APP_BASE_URL}/auth/callback?token=${encodeURIComponent(token)}`;

    const sent = await sendMagicLink(c.env, email, url);
    if (!sent.ok) {
      // Don't leak the failure to the client; log for operators and still 200.
      console.error(`magic-link send failed for ${email}: ${sent.error}`);
    }

    // Staging-only convenience: real magic-link delivery needs a verified Resend
    // sender domain, which non-prod environments don't have. When ENVIRONMENT is
    // anything other than "production", return the link in the response so we can
    // click through without email. HARD-GATED on ENVIRONMENT - production NEVER
    // includes the token (`[env.production.vars]` sets ENVIRONMENT = "production").
    if (c.env.ENVIRONMENT !== "production") {
      return c.json({ ok: true, devMagicLink: url }, 200);
    }
    return c.json({ ok: true }, 200);
  });

  app.get("/auth/callback", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "missing token" }, 400);

    const email = await consumeMagicToken(c.env, token);
    if (!email) return c.json({ error: "invalid or expired token" }, 400);

    const account = await findOrCreateAccount(c.env, email);
    // MNEMO-49: seed the free-tier subscription on account creation (idempotent -
    // a returning user already has a row, so this no-ops).
    await ensureFreeSubscription(c.env, account.id);
    const sessionId = await createSession(c.env, account.id);
    setSessionCookie(c, sessionId);
    // Land in the app, not the public marketing page at "/". The SPA's own
    // CallbackPage sends successful sign-ins to /agents too; keep them in step
    // so a magic-link click drops the user straight onto their dashboard.
    return c.redirect("/agents", 302);
  });

  app.post("/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await destroySession(c.env, id);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}
