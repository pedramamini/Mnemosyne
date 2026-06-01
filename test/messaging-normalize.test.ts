import { describe, expect, it } from "vitest";
import {
  MalformedInboundError,
  normalizeTwilioInbound,
} from "../src/messaging/normalize.ts";

// MNEMO-45: normalizeTwilioInbound is the pure mapping from Twilio's
// application/x-www-form-urlencoded Messaging webhook fields to the
// channel-agnostic InboundMessage (MNEMO-44). These assert the field mapping, the
// MMS media collection, and the typed failure on a structurally broken payload -
// the seam the gateway hands the agent loop never sees Twilio's field names.

describe("normalizeTwilioInbound - plain SMS", () => {
  it("maps a representative SMS form to the InboundMessage shape", () => {
    const form: Record<string, string> = {
      From: "+14155551212",
      To: "+15005550006",
      Body: "hey agent, what's new?",
      MessageSid: "SM0123456789abcdef0123456789abcdef",
      NumMedia: "0",
      // Twilio sends many more fields (AccountSid, MessagingServiceSid, …); the
      // normalizer ignores everything it doesn't map.
      AccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };

    expect(normalizeTwilioInbound(form)).toEqual({
      from: "+14155551212",
      to: "+15005550006",
      body: "hey agent, what's new?",
      channel: "sms",
      threadId: null,
      providerMessageId: "SM0123456789abcdef0123456789abcdef",
      mediaUrls: [],
    });
  });

  it("defaults providerMessageId to null when MessageSid is absent", () => {
    const msg = normalizeTwilioInbound({
      From: "+14155551212",
      To: "+15005550006",
      Body: "no sid here",
    });
    expect(msg.providerMessageId).toBeNull();
    expect(msg.mediaUrls).toEqual([]);
  });
});

describe("normalizeTwilioInbound - MMS media", () => {
  it("collects every MediaUrl0..N up to NumMedia", () => {
    const form: Record<string, string> = {
      From: "+14155551212",
      To: "+15005550006",
      Body: "look at these",
      MessageSid: "MM0123456789abcdef0123456789abcdef",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/media/ME000",
      MediaUrl1: "https://api.twilio.com/media/ME111",
    };

    const msg = normalizeTwilioInbound(form);
    expect(msg.mediaUrls).toEqual([
      "https://api.twilio.com/media/ME000",
      "https://api.twilio.com/media/ME111",
    ]);
    expect(msg.channel).toBe("sms");
    expect(msg.threadId).toBeNull();
  });
});

describe("normalizeTwilioInbound - malformed", () => {
  it("throws MalformedInboundError when Body is missing", () => {
    expect(() =>
      normalizeTwilioInbound({
        From: "+14155551212",
        To: "+15005550006",
        // no Body
      }),
    ).toThrow(MalformedInboundError);
  });

  it("throws MalformedInboundError when From is missing", () => {
    expect(() =>
      normalizeTwilioInbound({
        To: "+15005550006",
        Body: "orphaned",
      }),
    ).toThrow(MalformedInboundError);
  });
});
