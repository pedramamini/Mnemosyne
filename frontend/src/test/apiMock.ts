import { vi } from "vitest";

/** Build a JSON Response-like stub for a mocked `fetch` (mirrors the api client's parser). */
export function jsonResponse(
  body: unknown,
  {
    status = 200,
    contentType = "application/json",
  }: { status?: number; contentType?: string } = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
    text: () => Promise.resolve(text),
  } as Response;
}

/** Build a text/* Response-like stub (e.g. the raw-markdown report body). */
export function textResponse(
  text: string,
  {
    status = 200,
    contentType = "text/markdown",
  }: { status?: number; contentType?: string } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: () => Promise.resolve(text),
  } as Response;
}

/** Install a `vi.fn()` over `globalThis.fetch`. Pair with `vi.unstubAllGlobals()`. */
export function installFetchMock(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The URL string passed to the Nth (default last) `fetch` call. */
export function fetchUrl(mock: ReturnType<typeof vi.fn>, n = -1): string {
  const calls = mock.mock.calls;
  const call = n < 0 ? calls[calls.length + n] : calls[n];
  return String(call[0]);
}

/** The `RequestInit` passed to the Nth (default last) `fetch` call. */
export function fetchInit(mock: ReturnType<typeof vi.fn>, n = -1): RequestInit {
  const calls = mock.mock.calls;
  const call = n < 0 ? calls[calls.length + n] : calls[n];
  return call[1] as RequestInit;
}
