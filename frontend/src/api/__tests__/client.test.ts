import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, get, isUnauthorized, post } from "../client";

/** Build a Response-like stub for the mocked fetch. */
function jsonResponse(
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

describe("api client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always sends credentials: 'include'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await get("/api/thing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.credentials).toBe("include");
  });

  it("serializes a JSON body and sets Content-Type for POST", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "1" }, { status: 201 }));
    await post("/api/thing", { name: "Ada" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Ada" }));
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("parses a JSON body on a 200 response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: 42 }));
    const result = await apiFetch<{ value: number }>("/api/thing");
    expect(result).toEqual({ value: 42 });
  });

  it("throws a typed ApiError on a 500 response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "boom" }, { status: 500 }),
    );
    const err = await apiFetch("/api/thing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(500);
    expect(apiErr.message).toBe("boom");
    expect(apiErr.body).toEqual({ error: "boom" });
  });

  it("isUnauthorized() recognizes a 401 ApiError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "nope" }, { status: 401 }),
    );
    const err = await apiFetch("/api/secure").catch((e) => e);
    expect(isUnauthorized(err)).toBe(true);
    expect(isUnauthorized(new ApiError(500, "x", null))).toBe(false);
    expect(isUnauthorized(new Error("plain"))).toBe(false);
  });
});
