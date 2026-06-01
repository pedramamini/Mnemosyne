/**
 * Error taxonomy (MNEMO-50, PRD §3).
 *
 * One `AppError` base + typed subclasses. The contract that makes it safe:
 *   - `publicMessage` is ALWAYS safe to return to a caller.
 *   - `internalDetail` is logged, NEVER returned (the single error handler enforces
 *     this - see `src/errors/handler.ts`).
 *
 * Handlers `throw` a typed error; the Hono `onError` maps it to a safe JSON
 * response with the right status. Anything thrown that ISN'T an `AppError` is
 * normalized by {@link toAppError} (Zod → 400, everything else → 500 with the raw
 * message tucked into `internalDetail`), so no stack trace or driver string ever
 * leaks past the boundary.
 */
import { z } from "zod";
import type { AdmissionResult } from "../billing/limits.ts";

/** Optional construction details for an {@link AppError}. */
export interface AppErrorInit {
  /** Operator-facing detail - logged, never returned. */
  internalDetail?: string;
  /** Underlying error, threaded through `Error.cause` for stack chaining. */
  cause?: unknown;
  /** Seconds the caller should wait before retrying (sets `Retry-After`). */
  retryAfter?: number;
}

/**
 * Base application error. `httpStatus` + `code` + `publicMessage` are the safe,
 * caller-visible triple; `internalDetail` is logged only. Use the subclasses (or
 * the {@link toAppError} normalizer) rather than constructing this directly.
 */
export class AppError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly publicMessage: string;
  readonly internalDetail?: string;
  readonly retryAfter?: number;

  constructor(
    httpStatus: number,
    code: string,
    publicMessage: string,
    init?: AppErrorInit,
  ) {
    // The `Error.message` carries the INTERNAL detail (for stack traces / logs);
    // the caller-safe text is `publicMessage`.
    super(
      init?.internalDetail ?? publicMessage,
      init?.cause !== undefined ? { cause: init.cause } : undefined,
    );
    this.name = "AppError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.publicMessage = publicMessage;
    this.internalDetail = init?.internalDetail;
    this.retryAfter = init?.retryAfter;
  }
}

/** 401 - no/!valid session. */
export class Unauthorized extends AppError {
  constructor(publicMessage = "Unauthorized", init?: AppErrorInit) {
    super(401, "unauthorized", publicMessage, init);
    this.name = "Unauthorized";
  }
}

/** 403 - authenticated but not permitted (incl. a tier feature you don't pay for). */
export class Forbidden extends AppError {
  constructor(publicMessage = "Forbidden", init?: AppErrorInit) {
    super(403, "forbidden", publicMessage, init);
    this.name = "Forbidden";
  }
}

/** 404 - not found (also the no-existence-leak response for a non-owned resource). */
export class NotFound extends AppError {
  constructor(publicMessage = "Not found", init?: AppErrorInit) {
    super(404, "not_found", publicMessage, init);
    this.name = "NotFound";
  }
}

/** 400 - request failed validation. {@link ValidationError.fromZod} wraps a `ZodError`. */
export class ValidationError extends AppError {
  constructor(publicMessage = "Invalid request", init?: AppErrorInit) {
    super(400, "validation_error", publicMessage, init);
    this.name = "ValidationError";
  }

  /** Wrap a Zod failure - the issues go to `internalDetail`, never to the caller. */
  static fromZod(err: z.ZodError): ValidationError {
    return new ValidationError("Invalid request", {
      internalDetail: JSON.stringify(err.issues),
      cause: err,
    });
  }
}

/** 429 - too many requests. Carries `retryAfter` (seconds) for the `Retry-After` header. */
export class RateLimited extends AppError {
  constructor(
    retryAfter: number,
    publicMessage = "Too many requests",
    init?: AppErrorInit,
  ) {
    super(429, "rate_limited", publicMessage, { ...init, retryAfter });
    this.name = "RateLimited";
  }
}

/** 402 - the account hit its monthly cost cap (MNEMO-49 `cost_cap`). Payment unblocks it. */
export class CostCapReached extends AppError {
  constructor(publicMessage = "Monthly cost cap reached", init?: AppErrorInit) {
    super(402, "cost_cap", publicMessage, init);
    this.name = "CostCapReached";
  }
}

/** 429 - at the account's concurrent-sandbox ceiling (MNEMO-49 `concurrency`). Retryable. */
export class ConcurrencyLimited extends AppError {
  constructor(
    publicMessage = "Concurrency limit reached",
    init?: AppErrorInit,
  ) {
    super(429, "concurrency", publicMessage, init);
    this.name = "ConcurrencyLimited";
  }
}

/** 502 - an upstream dependency (LLM / sandbox / PSP) failed. */
export class UpstreamError extends AppError {
  constructor(publicMessage = "Upstream service error", init?: AppErrorInit) {
    super(502, "upstream_error", publicMessage, init);
    this.name = "UpstreamError";
  }
}

/** 500 - an unexpected internal fault. The default for anything un-typed. */
export class InternalError extends AppError {
  constructor(publicMessage = "Internal server error", init?: AppErrorInit) {
    super(500, "internal_error", publicMessage, init);
    this.name = "InternalError";
  }
}

/**
 * Map a DENIED MNEMO-49 {@link AdmissionResult} to the matching `AppError`:
 *   - `cost_cap`     → {@link CostCapReached} (402)
 *   - `concurrency`  → {@link ConcurrencyLimited} (429)
 *   - `tier_feature` → {@link Forbidden} (403)
 *
 * The admission `detail` is operator-facing → it rides in `internalDetail`, never
 * the caller-visible `publicMessage`. Callers should guard on `!result.allowed`.
 */
export function admissionToAppError(result: AdmissionResult): AppError {
  const internalDetail = result.detail;
  switch (result.reason) {
    case "cost_cap":
      return new CostCapReached(undefined, { internalDetail });
    case "concurrency":
      return new ConcurrencyLimited(undefined, { internalDetail });
    default:
      // `tier_feature` (or an unexpected reason) - a feature the tier doesn't include.
      return new Forbidden("This feature is not available on your plan", {
        internalDetail,
      });
  }
}

/**
 * Normalize anything thrown into an {@link AppError}:
 *   - an `AppError` passes through unchanged,
 *   - a `ZodError` becomes a 400 {@link ValidationError},
 *   - everything else becomes a 500 {@link InternalError} with the raw message in
 *     `internalDetail` (logged, never returned).
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof z.ZodError) return ValidationError.fromZod(err);
  if (err instanceof Error) {
    return new InternalError("Internal server error", {
      internalDetail: err.message,
      cause: err,
    });
  }
  return new InternalError("Internal server error", {
    internalDetail: String(err),
  });
}
