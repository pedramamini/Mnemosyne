import { afterEach, describe, expect, it, vi } from "vitest";
import {
  safeFetch,
  WEB_MAX_BYTES,
  WEB_TIMEOUT_MS,
} from "../src/tools/web/safeFetch.ts";

// MNEMO-17: safeFetch carries Crema's three web-fetch rails - a hard host block,
// a 15s timeout, and a 200KB cap. `fetch` is stubbed so each rail is asserted
// deterministically without touching the network.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("safeFetch - web-fetch safety rails", () => {
  it("pins the rail constants (15s / 200KB)", () => {
    expect(WEB_TIMEOUT_MS).toBe(15_000);
    expect(WEB_MAX_BYTES).toBe(200 * 1024);
  });

  it("refuses a BLOCKED_HOSTS url WITHOUT calling fetch (fail-closed host block)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await safeFetch("https://www.spokeo.com/john-doe");

    expect(result.blocked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(0);
    // The whole point: we never hit the network for a blocked host.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the body at WEB_MAX_BYTES and marks it truncated", async () => {
    const big = "a".repeat(WEB_MAX_BYTES + 5_000);
    const fetchMock = vi.fn(async () => new Response(big));
    vi.stubGlobal("fetch", fetchMock);

    const result = await safeFetch("https://example.com/huge");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
    // Body is ASCII, so byte length == char length - capped exactly at the cap.
    expect(result.body.length).toBe(WEB_MAX_BYTES);
    expect(result.bytes).toBe(WEB_MAX_BYTES);
  });

  it("returns the full body untruncated when under the cap", async () => {
    const fetchMock = vi.fn(async () => new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await safeFetch("https://example.com/small");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.truncated).toBe(false);
    expect(result.body).toBe("hello");
    expect(result.blocked).toBeUndefined();
  });

  it("throws when its signal aborts (the 15s timeout path)", async () => {
    // The 15s timer and a caller signal both funnel through the same
    // controller.abort() → fetch-rejects → throw path. An already-aborted signal
    // exercises it deterministically (no fake timers needed).
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) {
        return Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      }
      return Promise.resolve(new Response("never"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const ac = new AbortController();
    ac.abort();

    await expect(
      safeFetch("https://example.com/slow", { signal: ac.signal }),
    ).rejects.toThrow();
  });

  it("catches a redirect onto a blocked host (re-check on the FINAL url)", async () => {
    // The request url is allowed; the resolved (post-redirect) url is a blocked
    // people-finder host. safeFetch must refuse on the final url.
    const fetchMock = vi.fn(async () => {
      const res = new Response("dossier", { status: 200 });
      Object.defineProperty(res, "url", {
        value: "https://spokeo.com/john-doe",
      });
      return res;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await safeFetch("https://redirector.example.com/go");

    // We did make the request (a redirect can only be detected after fetching)...
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...but the final url is blocked, so nothing is returned as content.
    expect(result.blocked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBe(0);
    expect(result.body).toBe("");
  });
});
