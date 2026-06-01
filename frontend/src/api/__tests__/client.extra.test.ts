import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInit, installFetchMock, jsonResponse } from "../../test/apiMock";
import {
  ApiError,
  apiFetch,
  apiUrl,
  del,
  onUnauthorized,
  patch,
  put,
} from "../client";

describe("api client - method helpers", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("patch / put serialize JSON and set the method", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await patch("/x", { a: 1 });
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(fetchInit(fetchMock).body).toBe(JSON.stringify({ a: 1 }));

    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await put("/x", { b: 2 });
    expect(fetchInit(fetchMock).method).toBe("PUT");
    expect(fetchInit(fetchMock).body).toBe(JSON.stringify({ b: 2 }));
  });

  it("del issues a DELETE with no body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await del("/x");
    expect(fetchInit(fetchMock).method).toBe("DELETE");
    expect(fetchInit(fetchMock).body).toBeUndefined();
  });

  it("passes a raw body through untouched (no forced Content-Type)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiFetch("/x", { method: "POST", body: "raw-bytes" });
    const init = fetchInit(fetchMock);
    expect(init.body).toBe("raw-bytes");
    expect((init.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("apiUrl returns a same-origin path when no API base is configured", () => {
    expect(apiUrl("/agents/x")).toBe("/agents/x");
  });
});

describe("api client - parseBody branches", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns undefined on 204 / 205 and on an empty body", async () => {
    fetchMock.mockResolvedValue(jsonResponse("", { status: 204 }));
    expect(await apiFetch("/x")).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse("", { status: 205 }));
    expect(await apiFetch("/x")).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse("", { status: 200 }));
    expect(await apiFetch("/x")).toBeUndefined();
  });

  it("returns raw text for a non-JSON content-type", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("plain words", { contentType: "text/plain" }),
    );
    expect(await apiFetch("/x")).toBe("plain words");
  });

  it("returns the raw text when a JSON content-type carries malformed JSON", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse("{not json", { contentType: "application/json" }),
    );
    expect(await apiFetch("/x")).toBe("{not json");
  });
});

describe("api client - error message derivation", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("prefers body.message, then a string body, then a status fallback", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "explicit" }, { status: 500 }),
    );
    await expect(apiFetch("/x")).rejects.toMatchObject({ message: "explicit" });

    fetchMock.mockResolvedValue(
      jsonResponse("just a string", { status: 502, contentType: "text/plain" }),
    );
    await expect(apiFetch("/x")).rejects.toMatchObject({
      message: "just a string",
    });

    fetchMock.mockResolvedValue(jsonResponse("", { status: 503 }));
    await expect(apiFetch("/x")).rejects.toMatchObject({
      message: "Request failed with status 503",
    });
  });
});

describe("api client - onUnauthorized pub/sub", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fires registered handlers on a 401 and stops after unsubscribe", async () => {
    const handler = vi.fn();
    const unsubscribe = onUnauthorized(handler);

    fetchMock.mockResolvedValue(
      jsonResponse({ error: "nope" }, { status: 401 }),
    );
    await expect(apiFetch("/secure")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "nope" }, { status: 401 }),
    );
    await expect(apiFetch("/secure")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });
});
