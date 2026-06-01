import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import { getMe, logout, requestMagicLink, updateProfile } from "../auth";

describe("auth API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requestMagicLink POSTs the email and surfaces a dev link when present", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, devMagicLink: "https://x/cb?t=1" }),
    );
    const out = await requestMagicLink("a@b.com");
    expect(fetchUrl(fetchMock)).toContain("/auth/request");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ email: "a@b.com" }),
    );
    expect(out.devMagicLink).toBe("https://x/cb?t=1");
  });

  it("requestMagicLink yields no dev link in production-style responses", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    expect((await requestMagicLink("a@b.com")).devMagicLink).toBeUndefined();
  });

  it("getMe GETs /api/me", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "u1", email: "a@b.com", profile: {} }),
    );
    expect((await getMe()).id).toBe("u1");
    expect(fetchUrl(fetchMock)).toContain("/api/me");
  });

  it("logout POSTs /auth/logout", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await logout();
    expect(fetchUrl(fetchMock)).toContain("/auth/logout");
    expect(fetchInit(fetchMock).method).toBe("POST");
  });

  it("updateProfile PUTs the patch and returns the echoed profile", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { timezone: "America/Chicago", name: "P", notes: null },
      }),
    );
    const out = await updateProfile({ timezone: "America/Chicago" });
    expect(fetchInit(fetchMock).method).toBe("PUT");
    expect(fetchUrl(fetchMock)).toContain("/api/me/profile");
    expect(out.timezone).toBe("America/Chicago");
  });
});
