/**
 * The messaging seam (MNEMO-44, PRD §9.3).
 *
 * `MessagingChannel` is the provider-agnostic interface the agent loop (MNEMO-15)
 * speaks so it NEVER imports Twilio (or any provider) directly - swapping or adding
 * a transport is a new implementation of this interface, not a change to callers.
 * It abstracts the three things §9.3 calls out: outbound `send`, inbound webhook
 * authentication (`verifyInboundSignature`), and static `capabilities` flags.
 *
 * `TwilioSmsChannel` (SMS) is the ONLY implementation we ship now. The iMessage
 * transport (`ImessageProviderChannel`) is PARKED per §9.2 - do not implement it;
 * the `imessage`/`rcs` channel tags exist only to keep persisted rows + UI stable.
 */
import type {
  Channel,
  ChannelCapabilities,
  OutboundMessage,
  SendResult,
} from "./types.ts";

/**
 * The raw inbound request fields a channel needs to authenticate a provider
 * webhook: the full request `url` (as the provider saw it, including query), the
 * request `headers` (lower/any case - the implementation reads what it needs, e.g.
 * Twilio's `X-Twilio-Signature`), and the parsed POST `form` params. The gateway
 * (MNEMO-45) assembles this from the incoming `Request`.
 */
export interface InboundRequest {
  /** The full request URL exactly as the provider signed it. */
  url: string;
  /** Request headers (the implementation reads the ones it needs). */
  headers: Record<string, string>;
  /** Parsed `application/x-www-form-urlencoded` POST params. */
  form: Record<string, string>;
}

/**
 * A provider-agnostic messaging transport. Implementations are constructed per
 * agent (they hold that agent's provisioned number + credentials) and are the only
 * code that knows a specific provider's wire format.
 */
export interface MessagingChannel {
  /** Which channel this implementation delivers over (e.g. `"sms"`). */
  readonly channel: Channel;
  /** Static capability flags callers branch on (group/media/deliveryType). */
  readonly capabilities: ChannelCapabilities;
  /**
   * Send one outbound message. NEVER throws on a non-2xx provider response -
   * returns a typed {@link SendResult} the caller logs to the audit stream.
   */
  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * Authenticate an inbound provider webhook so only the real provider can post to
   * the gateway (MNEMO-45 calls this; PRD §9.6). Returns true iff the request's
   * signature verifies against the channel's credentials. Typed `boolean |
   * Promise<boolean>` rather than a bare `boolean` because signature schemes on the
   * Workers runtime are HMAC over the ASYNC Web Crypto `crypto.subtle` API (Twilio's
   * does); callers `await` the result.
   */
  verifyInboundSignature(req: InboundRequest): boolean | Promise<boolean>;
}
