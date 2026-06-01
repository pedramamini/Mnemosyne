import { describe, expect, it } from "vitest";
import { TwilioSmsChannel } from "../src/messaging/TwilioSmsChannel.ts";
import { validateTwilioSignature } from "../src/messaging/twilioSignature.ts";

// MNEMO-44: Twilio webhook signature validation runs in the Workers pool so
// `crypto.subtle` is the Workers HMAC-SHA1 impl (not Node's). The vector below is
// Twilio's canonical security-docs example (auth token + URL + POST params), whose
// expected X-Twilio-Signature is verified against a reference HMAC. Proving true for
// the correct signature and false for any tamper is what lets the MNEMO-45 gateway
// trust inbound webhooks (PRD §9.6).

const AUTH_TOKEN = "12345";
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS: Record<string, string> = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+14158675309",
  Digits: "1234",
  From: "+14158675309",
  To: "+18005551212",
};
const EXPECTED_SIGNATURE = "RSOYDt4T1cUTdK1PDd93/VVr8B8=";

describe("validateTwilioSignature - canonical vector", () => {
  it("returns true for the correct signature", async () => {
    await expect(
      validateTwilioSignature(AUTH_TOKEN, URL, PARAMS, EXPECTED_SIGNATURE),
    ).resolves.toBe(true);
  });

  it("returns false for a tampered URL", async () => {
    await expect(
      validateTwilioSignature(
        AUTH_TOKEN,
        "https://mycompany.com/myapp.php?foo=1&bar=3",
        PARAMS,
        EXPECTED_SIGNATURE,
      ),
    ).resolves.toBe(false);
  });

  it("returns false for a tampered param", async () => {
    await expect(
      validateTwilioSignature(
        AUTH_TOKEN,
        URL,
        { ...PARAMS, Digits: "9999" },
        EXPECTED_SIGNATURE,
      ),
    ).resolves.toBe(false);
  });

  it("returns false for a wrong signature", async () => {
    await expect(
      validateTwilioSignature(
        AUTH_TOKEN,
        URL,
        PARAMS,
        "ZZZZDt4T1cUTdK1PDd93/VVr8B8=",
      ),
    ).resolves.toBe(false);
  });
});

describe("TwilioSmsChannel.verifyInboundSignature - delegate", () => {
  const channel = new TwilioSmsChannel({
    accountSid: "ACfake",
    authToken: AUTH_TOKEN,
    apiBase: "https://api.twilio.com",
    fromNumber: "+15005550006",
  });

  it("verifies a correctly-signed inbound request (case-insensitive header)", async () => {
    await expect(
      channel.verifyInboundSignature({
        url: URL,
        headers: { "x-twilio-signature": EXPECTED_SIGNATURE },
        form: PARAMS,
      }),
    ).resolves.toBe(true);
  });

  it("rejects a request with no signature header", async () => {
    await expect(
      channel.verifyInboundSignature({ url: URL, headers: {}, form: PARAMS }),
    ).resolves.toBe(false);
  });
});
