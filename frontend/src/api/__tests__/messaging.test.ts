import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import {
  addWhitelistContact,
  disableMessaging,
  enableMessaging,
  getMessagingAccess,
  getMessagingStatus,
  listMessagingSessions,
  listSessionMessages,
  removeWhitelistContact,
  updateMessagingAccess,
} from "../messaging";

describe("messaging API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("getMessagingStatus GETs /messaging/status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        enabled: true,
        e164: "+1",
        a2p: { brand: null, campaign: null },
      }),
    );
    const out = await getMessagingStatus("a1");
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/messaging/status");
    expect(out.enabled).toBe(true);
  });

  it("enableMessaging POSTs an areaCode body when given, else an empty object", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ e164: "+1555" }));
    await enableMessaging("a1", "512");
    expect(fetchInit(fetchMock).body).toBe(JSON.stringify({ areaCode: "512" }));

    fetchMock.mockResolvedValue(jsonResponse({ e164: "+1555" }));
    await enableMessaging("a1");
    expect(fetchInit(fetchMock).body).toBe(JSON.stringify({}));
  });

  it("disableMessaging POSTs to /disable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await disableMessaging("a1");
    expect(fetchUrl(fetchMock)).toContain("/messaging/disable");
    expect(fetchInit(fetchMock).method).toBe("POST");
  });

  it("listMessagingSessions GETs /sessions", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listMessagingSessions("a1");
    expect(fetchUrl(fetchMock)).toContain("/messaging/sessions");
  });

  it("listSessionMessages encodes the session id", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listSessionMessages("a1", "2026-01-01/+1");
    expect(fetchUrl(fetchMock)).toContain(
      "/messaging/sessions/2026-01-01%2F%2B1/messages",
    );
  });

  it("getMessagingAccess GETs /access", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ openToWorld: false, ownerNumber: null, whitelist: [] }),
    );
    await getMessagingAccess("a1");
    expect(fetchUrl(fetchMock)).toContain("/messaging/access");
  });

  it("updateMessagingAccess PUTs the patch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ openToWorld: true, ownerNumber: "+1" }),
    );
    await updateMessagingAccess("a1", { openToWorld: true });
    expect(fetchInit(fetchMock).method).toBe("PUT");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ openToWorld: true }),
    );
  });

  it("addWhitelistContact POSTs the contact", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, contactE164: "+1" }));
    await addWhitelistContact("a1", "+1");
    expect(fetchUrl(fetchMock)).toContain("/messaging/whitelist");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ contactE164: "+1" }),
    );
  });

  it("removeWhitelistContact DELETEs the encoded contact", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await removeWhitelistContact("a1", "+15551234567");
    expect(fetchInit(fetchMock).method).toBe("DELETE");
    expect(fetchUrl(fetchMock)).toContain(
      "/messaging/whitelist/%2B15551234567",
    );
  });
});
