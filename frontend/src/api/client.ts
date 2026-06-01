/**
 * API client base - transport only.
 *
 * `apiFetch` is a thin wrapper over the platform `fetch` that:
 *   - prefixes a configurable base URL (`VITE_API_BASE`, default same-origin),
 *   - sends `credentials: "include"` so the cookie session from MNEMO-03 rides along,
 *   - sets `Content-Type: application/json` and serializes plain-object/array bodies,
 *   - parses JSON responses (tolerating empty / non-JSON bodies),
 *   - throws a typed `ApiError` on any non-2xx status.
 *
 * It deliberately contains NO endpoint-specific knowledge - feature code and
 * resource modules build on top of `get`/`post`/`patch`/`del`.
 */

/** Configurable API origin. Empty string => same-origin (the Vite dev proxy / prod). */
const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

/** Thrown for any non-2xx response. Carries the status, a message, and the parsed body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Type guard: true when `err` is an `ApiError` for a 401 (unauthenticated). */
export function isUnauthorized(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Global 401 notification (MNEMO-33). Any authenticated call that comes back
 * 401 - e.g. a session that expired mid-session - fires the registered
 * handlers BEFORE the `ApiError` is thrown, so the session layer can flip to
 * "anonymous" and bounce the user to `/login` cleanly without each call site
 * having to handle it. The `SessionProvider` subscribes once on mount; the
 * mechanism is intentionally a tiny synchronous pub/sub (no extra deps).
 */
type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/** Register a handler invoked on ANY 401 from `apiFetch`. Returns an unsubscribe. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

/** Init for `apiFetch`: standard `RequestInit` minus `body`, plus a JSON-able `json` shortcut. */
export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  /** A value to JSON-serialize as the request body (sets Content-Type automatically). */
  json?: unknown;
  /** A raw body, passed straight through (e.g. FormData, string). Mutually exclusive with `json`. */
  body?: BodyInit | null;
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/**
 * Resolve an API path to an absolute URL against `API_BASE`, applying the same
 * base-joining rules as `apiFetch`. Exposed so non-`fetch` consumers that need a
 * raw URL string - e.g. the streaming chat transport (MNEMO-35), which takes an
 * `api` URL rather than going through `apiFetch` - share one source of truth for
 * the API origin instead of re-deriving `VITE_API_BASE`.
 */
export function apiUrl(path: string): string {
  return joinUrl(API_BASE, path);
}

async function parseBody(res: Response): Promise<unknown> {
  // 204/205 and empty bodies have nothing to parse.
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      // Malformed JSON despite the header - surface the raw text rather than throwing here.
      return text;
    }
  }
  return text;
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const candidate = record.error ?? record.message;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return fallback;
}

/** Core request wrapper. Resolves with the parsed body on 2xx; throws `ApiError` otherwise. */
export async function apiFetch<T = unknown>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const { json, body, headers, ...rest } = init;

  const finalHeaders = new Headers(headers);
  let finalBody: BodyInit | null | undefined = body;

  if (json !== undefined) {
    if (!finalHeaders.has("Content-Type")) {
      finalHeaders.set("Content-Type", "application/json");
    }
    finalBody = JSON.stringify(json);
  }

  const res = await fetch(joinUrl(API_BASE, path), {
    credentials: "include",
    ...rest,
    headers: finalHeaders,
    body: finalBody,
  });

  const parsed = await parseBody(res);

  if (!res.ok) {
    // Notify the session layer of a 401 before throwing, so a mid-session
    // expiry flips the app to "anonymous" regardless of which call hit it.
    if (res.status === 401) {
      for (const handler of unauthorizedHandlers) handler();
    }
    throw new ApiError(
      res.status,
      messageFromBody(parsed, `Request failed with status ${res.status}`),
      parsed,
    );
  }

  return parsed as T;
}

/** GET helper. */
export function get<T = unknown>(
  path: string,
  init?: ApiFetchInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "GET" });
}

/** POST helper. Pass the request payload as `json`. */
export function post<T = unknown>(
  path: string,
  json?: unknown,
  init?: ApiFetchInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "POST", json });
}

/** PATCH helper. Pass the request payload as `json`. */
export function patch<T = unknown>(
  path: string,
  json?: unknown,
  init?: ApiFetchInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "PATCH", json });
}

/** PUT helper (full create/replace). Pass the request payload as `json`. */
export function put<T = unknown>(
  path: string,
  json?: unknown,
  init?: ApiFetchInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "PUT", json });
}

/** DELETE helper (`del` - `delete` is a reserved word). */
export function del<T = unknown>(
  path: string,
  init?: ApiFetchInit,
): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "DELETE" });
}
