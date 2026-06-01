import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppEnv,
  getAccountId,
  requireAuth,
} from "../src/auth/middleware.ts";
import {
  createSession,
  destroySession,
  getSession,
  SESSION_COOKIE,
  type Session,
} from "../src/auth/sessions.ts";
import { consumeMagicToken, issueMagicToken } from "../src/auth/tokens.ts";
import { sendMagicLink } from "../src/email/resend.ts";
import worker from "../src/index.ts";

// Mirrors the internal `magic:<sha256hex(token)>` key scheme so a test can plant
// an entry with a chosen `exp` and drive the expiry branch of consumeMagicToken.
async function magicKeyFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `magic:${hex}`;
}

// Reads the session id out of a Set-Cookie header.
function sessionFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("magic tokens", () => {
  it("issues a single-use token: first consume returns the email, second returns null", async () => {
    const email = `tok-${crypto.randomUUID()}@example.com`;
    const token = await issueMagicToken(env, email);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex

    expect(await consumeMagicToken(env, token)).toBe(email);
    // Single-use: the key was deleted on the first consume.
    expect(await consumeMagicToken(env, token)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await consumeMagicToken(env, "not-a-real-token")).toBeNull();
  });

  it("returns null for an expired token (and deletes it)", async () => {
    const email = `exp-${crypto.randomUUID()}@example.com`;
    const token = crypto.randomUUID();
    const key = await magicKeyFor(token);
    // Plant an entry whose exp is already in the past.
    await env.SESSIONS.put(
      key,
      JSON.stringify({ email, exp: Date.now() - 1000 }),
    );

    expect(await consumeMagicToken(env, token)).toBeNull();
    // Expired tokens must not survive a consume attempt.
    expect(await env.SESSIONS.get(key)).toBeNull();
  });
});

describe("sessions", () => {
  it("creates, reads, and destroys a session", async () => {
    const accountId = crypto.randomUUID();
    const id = await createSession(env, accountId);
    expect(id).toBeTruthy();

    const session = await getSession(env, id);
    expect(session).toEqual<Session>({ accountId });

    await destroySession(env, id);
    expect(await getSession(env, id)).toBeNull();
  });

  it("returns null for an unknown session id", async () => {
    expect(await getSession(env, crypto.randomUUID())).toBeNull();
  });
});

describe("sendMagicLink", () => {
  it("returns ok on a 2xx Resend response and posts to the API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_1" })));

    const result = await sendMagicLink(
      env,
      "user@example.com",
      "https://mnemosyne.test/auth/callback?token=abc",
    );

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.resend.com/emails");
  });

  it("returns an error (without throwing) on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad", { status: 422 }),
    );

    const result = await sendMagicLink(env, "user@example.com", "https://x/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("422");
  });
});

// A minimal app standing in for any future protected route.
const protectedApp = new Hono<AppEnv>();
protectedApp.use("/me", requireAuth());
protectedApp.get("/me", (c) => c.json({ accountId: getAccountId(c) }));

describe("auth routes + requireAuth", () => {
  it("POST /auth/request always returns 200 and sends one email", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_1" })));

    const req = new Request("https://mnemosyne.test/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Login@Example.com" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; devMagicLink?: string };
    expect(body.ok).toBe(true);
    // Non-production env (the test `ENVIRONMENT` is not "production"): the route
    // also returns the click-through link so a tester can sign in without email.
    // Production omits it entirely - hard-gated in src/auth/routes.ts.
    expect(body.devMagicLink).toMatch(/\/auth\/callback\?token=/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("POST /auth/request rejects a malformed body with 400", async () => {
    const req = new Request("https://mnemosyne.test/auth/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("GET /auth/callback consumes a token, opens a session, and sets the cookie", async () => {
    const email = `cb-${crypto.randomUUID()}@example.com`;
    const token = await issueMagicToken(env, email);

    const req = new Request(
      `https://mnemosyne.test/auth/callback?token=${token}`,
    );
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/agents");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");

    // The cookie unlocks a requireAuth-protected route.
    const sessionId = sessionFromSetCookie(setCookie);
    expect(sessionId).toBeTruthy();
    const meReq = new Request("https://mnemosyne.test/me", {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionId}` },
    });
    const meRes = await protectedApp.fetch(meReq, env);
    expect(meRes.status).toBe(200);
    expect((await meRes.json()) as { accountId: string }).toHaveProperty(
      "accountId",
    );
  });

  it("GET /auth/callback rejects an invalid token with 400", async () => {
    const req = new Request("https://mnemosyne.test/auth/callback?token=bogus");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it("requireAuth returns 401 for an unauthenticated request", async () => {
    const res = await protectedApp.fetch(
      new Request("https://mnemosyne.test/me"),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("requireAuth returns 401 when the cookie names an unknown session", async () => {
    const res = await protectedApp.fetch(
      new Request("https://mnemosyne.test/me", {
        headers: { Cookie: `${SESSION_COOKIE}=${crypto.randomUUID()}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
