import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioSmsChannel } from "../src/messaging/TwilioSmsChannel.ts";

// MNEMO-44: TwilioSmsChannel.send wire format. The Twilio POST is stubbed at
// globalThis.fetch (mirroring the Resend stub in test/email-report-notify.test.ts)
// so no real SMS is sent. We assert the request shape (URL, Basic auth, form fields)
// and the typed SendResult, INCLUDING that a non-2xx returns `{ ok: false }` without
// throwing - the convention for the whole messaging seam.

const ACCOUNT_SID = "ACfakeaccountsid000000000000000000";
const AUTH_TOKEN = "faketoken123";
const API_BASE = "https://api.twilio.com";
const FROM = "+15005550006";

function makeChannel(): TwilioSmsChannel {
  return new TwilioSmsChannel({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    apiBase: API_BASE,
    fromNumber: FROM,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TwilioSmsChannel.send - happy path", () => {
  it("posts to the Messages endpoint with Basic auth + form fields and returns the sid", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ sid: "SM123" }), { status: 201 }),
      );

    const channel = makeChannel();
    const result = await channel.send({
      to: "+14155551212",
      body: "Hello from your agent.",
      channel: "sms",
    });

    // One POST to the account-scoped Messages endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(init.method).toBe("POST");

    // HTTP Basic auth built from the SID:token pair.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`,
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    // Form-encoded From/To/Body.
    const form = new URLSearchParams(init.body as string);
    expect(form.get("From")).toBe(FROM);
    expect(form.get("To")).toBe("+14155551212");
    expect(form.get("Body")).toBe("Hello from your agent.");

    // Typed success: the sid + the computed segment count (this body is one segment).
    expect(result).toEqual({
      ok: true,
      providerMessageIds: ["SM123"],
      segments: 1,
    });
  });
});

describe("TwilioSmsChannel.send - failure", () => {
  it("returns { ok: false, status } on a non-2xx without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }),
        { status: 400 },
      ),
    );

    const channel = makeChannel();
    const result = await channel.send({
      to: "not-a-number",
      body: "Hello",
      channel: "sms",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.status).toBe(400);
    expect(result.error).toContain("400");
  });
});
