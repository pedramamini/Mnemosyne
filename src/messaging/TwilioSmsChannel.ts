/**
 * `TwilioSmsChannel` - the only {@link MessagingChannel} implementation we ship now
 * (MNEMO-44, PRD §9.3). Sends outbound SMS via the Twilio Programmable Messaging
 * REST API and validates inbound webhook signatures. iMessage/RCS stay parked (§9.2).
 *
 * The channel never throws on a non-2xx Twilio response - it returns a typed
 * {@link SendResult} the caller logs to the audit stream (the convention for the
 * whole messaging seam).
 */
import type { InboundRequest, MessagingChannel } from "./MessagingChannel.ts";
import { countSegments } from "./segmentation.ts";
import { validateTwilioSignature } from "./twilioSignature.ts";
import type {
  Channel,
  ChannelCapabilities,
  OutboundMessage,
  SendResult,
} from "./types.ts";

/** Construction config: the agent's Twilio creds + provisioned number. */
export interface TwilioSmsChannelConfig {
  /** Twilio account SID (HTTP Basic auth username + URL path segment). */
  accountSid: string;
  /** Twilio auth token (HTTP Basic auth password + inbound-signature HMAC key). */
  authToken: string;
  /** Twilio REST API base, e.g. `https://api.twilio.com` (env.TWILIO_API_BASE). */
  apiBase: string;
  /** The agent's provisioned E.164 number - the `From` on every outbound SMS. */
  fromNumber: string;
}

/** Twilio's outbound-message response carries the message `sid` (the id we surface). */
interface TwilioMessageResponse {
  sid?: string;
  message?: string;
  code?: number;
}

export class TwilioSmsChannel implements MessagingChannel {
  readonly channel: Channel = "sms";
  /**
   * SMS has no NATIVE group thread - `group: false`; multi-party threads are
   * modeled app-side in MNEMO-48. It can carry media (MMS), hence `media: true`.
   */
  readonly capabilities: ChannelCapabilities = {
    group: false,
    media: true,
    deliveryType: "sms",
  };

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly apiBase: string;
  private readonly fromNumber: string;

  constructor(config: TwilioSmsChannelConfig) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    // Trim a trailing slash so the joined path never doubles up.
    this.apiBase = config.apiBase.replace(/\/+$/, "");
    this.fromNumber = config.fromNumber;
  }

  /**
   * POST `application/x-www-form-urlencoded` to the account's Messages endpoint
   * using HTTP Basic auth. On 2xx, surface the Twilio `sid` and the computed
   * segment count; on non-2xx (or transport failure) return `{ ok: false }` WITHOUT
   * throwing, so the caller can audit-log it.
   */
  async send(message: OutboundMessage): Promise<SendResult> {
    const url = `${this.apiBase}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = btoa(`${this.accountSid}:${this.authToken}`);
    const form = new URLSearchParams({
      From: this.fromNumber,
      To: message.to,
      Body: message.body,
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          ok: false,
          error: `twilio ${res.status}: ${detail}`.trim(),
          status: res.status,
        };
      }

      const body = (await res
        .json()
        .catch(() => ({}))) as TwilioMessageResponse;
      if (!body.sid) {
        return {
          ok: false,
          error: "twilio 2xx without a message sid",
          status: res.status,
        };
      }
      return {
        ok: true,
        providerMessageIds: [body.sid],
        segments: countSegments(message.body),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Validate the inbound `X-Twilio-Signature` (PRD §9.6). A thin delegate to
   * {@link validateTwilioSignature}. MNEMO-45 wires this into the gateway: it
   * builds the {@link InboundRequest} from the incoming webhook and rejects any
   * request whose signature does not verify.
   */
  verifyInboundSignature(req: InboundRequest): Promise<boolean> {
    const signature = findHeader(req.headers, "X-Twilio-Signature");
    if (!signature) return Promise.resolve(false);
    return validateTwilioSignature(
      this.authToken,
      req.url,
      req.form,
      signature,
    );
  }
}

/** Case-insensitive header lookup (HTTP header names are case-insensitive). */
function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}
