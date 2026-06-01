/**
 * MNEMO-50 - error taxonomy + the single error handler.
 *
 * `toAppError` normalizes anything thrown; the `onError` handler (exercised here on
 * a throwaway app mounting the REAL `errorHandler`) returns a safe envelope that
 * never leaks `internalDetail`, with the mapped status + `Retry-After` for 429s.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppEnv } from "../src/auth/middleware.ts";
import {
  AppError,
  InternalError,
  RateLimited,
  toAppError,
  Unauthorized,
  ValidationError,
} from "../src/errors/AppError.ts";
import { errorHandler, notFoundHandler } from "../src/errors/handler.ts";
import { requestContext } from "../src/obs/requestContext.ts";

/** The secret an InternalError must NEVER surface to the caller. */
const SECRET_DETAIL = "db connection string postgres://user:hunter2@host";

function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext());
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.get("/throw/unauthorized", () => {
    throw new Unauthorized();
  });
  app.get("/throw/ratelimited", () => {
    throw new RateLimited(42);
  });
  app.get("/throw/internal", () => {
    throw new Error(SECRET_DETAIL);
  });
  app.get("/throw/zod", (c) => {
    // A real Zod parse failure → ZodError, normalized to a 400 ValidationError.
    z.object({ name: z.string() }).parse({});
    return c.text("unreachable");
  });
  return app;
}

describe("toAppError", () => {
  it("passes an AppError through unchanged", () => {
    const err = new Unauthorized("nope");
    expect(toAppError(err)).toBe(err);
  });

  it("wraps a ZodError as a 400 ValidationError (issues internal, not public)", () => {
    let zodErr: unknown;
    try {
      z.object({ name: z.string() }).parse({});
    } catch (e) {
      zodErr = e;
    }
    const appErr = toAppError(zodErr);
    expect(appErr).toBeInstanceOf(ValidationError);
    expect(appErr.httpStatus).toBe(400);
    expect(appErr.code).toBe("validation_error");
    expect(appErr.publicMessage).toBe("Invalid request");
    // The Zod issues live in internalDetail, never the public message.
    expect(appErr.internalDetail).toContain("name");
    expect(appErr.publicMessage).not.toContain("name");
  });

  it("wraps a plain Error as a 500 InternalError (message in internalDetail only)", () => {
    const appErr = toAppError(new Error(SECRET_DETAIL));
    expect(appErr).toBeInstanceOf(InternalError);
    expect(appErr.httpStatus).toBe(500);
    expect(appErr.internalDetail).toBe(SECRET_DETAIL);
    expect(appErr.publicMessage).toBe("Internal server error");
  });

  it("wraps a thrown string as a 500 InternalError", () => {
    const appErr = toAppError("just a string");
    expect(appErr).toBeInstanceOf(InternalError);
    expect(appErr.httpStatus).toBe(500);
    expect(appErr.internalDetail).toBe("just a string");
  });
});

describe("onError handler", () => {
  it("maps a typed error to its status + safe { error: { code, message, requestId } }", async () => {
    const res = await makeApp().request("/throw/unauthorized");
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Unauthorized");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it("returns 400 for a ZodError routed through onError", async () => {
    const res = await makeApp().request("/throw/zod");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("sets Retry-After for a RateLimited error", async () => {
    const res = await makeApp().request("/throw/ratelimited");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("NEVER leaks internalDetail on a 500", async () => {
    const res = await makeApp().request("/throw/internal");
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET_DETAIL);
    const body = JSON.parse(raw) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Internal server error");
  });
});

describe("notFound handler", () => {
  it("returns a typed 404 envelope for an unmatched route", async () => {
    const res = await makeApp().request("/no/such/route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("AppError contract", () => {
  it("RateLimited carries httpStatus 429 + retryAfter", () => {
    const err = new RateLimited(10);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfter).toBe(10);
  });
});
