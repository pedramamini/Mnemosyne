/**
 * Channel-agnostic message contract for the messaging seam (MNEMO-44, Track H).
 *
 * Per `docs/PRD.md` §9.3 the {@link import("./MessagingChannel.ts").MessagingChannel}
 * interface abstracts three things - outbound `send`, inbound normalization, and
 * capability flags - so the agent loop (MNEMO-15) never imports a provider SDK and
 * a new transport (iMessage/RCS) can return later without touching callers. These
 * are the shared shapes both sides of that seam speak; all of them are Zod-typed so
 * the gateway (MNEMO-45) and persistence/UI tags (§9.5) validate at the boundary.
 *
 * Phone numbers are E.164 strings throughout.
 */
import { z } from "zod";

/**
 * The delivery channel a message rode on. Only `sms` is LIVE this phase
 * (`TwilioSmsChannel`); `imessage`/`rcs` are RESERVED so persisted rows and UI
 * tags stay stable when those transports return (§9.5) - `ImessageProviderChannel`
 * is parked per §9.2 and is NOT implemented now.
 */
export const Channel = z.enum(["sms", "imessage", "rcs"]);
/** The inferred union: `"sms" | "imessage" | "rcs"`. */
export type Channel = z.infer<typeof Channel>;

/**
 * A normalized inbound message - what a provider webhook collapses to before the
 * gateway (MNEMO-45) hands it to the agent loop. `threadId` is set for group
 * threads (modeled app-side in MNEMO-48) and `null` for a 1:1 conversation;
 * `providerMessageId` is the provider's own id when it sent one. `from`/`to` are
 * E.164 (`to` being the agent's provisioned number).
 */
export const InboundMessage = z.object({
  from: z.string().describe("Sender phone number, E.164."),
  to: z.string().describe("The agent's provisioned number, E.164."),
  body: z.string().describe("Message text."),
  channel: Channel,
  threadId: z
    .string()
    .nullable()
    .describe("Group-thread id (MNEMO-48), or null for a 1:1 conversation."),
  providerMessageId: z
    .string()
    .nullable()
    .describe("The provider's own message id, when supplied."),
  mediaUrls: z
    .array(z.string())
    .describe("URLs of any attached media (MMS); empty for plain SMS."),
});
/** The inferred TypeScript shape of {@link InboundMessage}. */
export type InboundMessage = z.infer<typeof InboundMessage>;

/**
 * An outbound message handed to {@link import("./MessagingChannel.ts").MessagingChannel.send}.
 * The agent loop (MNEMO-15) produces `body`; the channel owns the `from` number
 * (its constructor's `fromNumber`), so it is NOT part of this contract.
 */
export const OutboundMessage = z.object({
  to: z.string().describe("Recipient phone number, E.164."),
  body: z.string().describe("Message text to send."),
  channel: Channel,
});
/** The inferred TypeScript shape of {@link OutboundMessage}. */
export type OutboundMessage = z.infer<typeof OutboundMessage>;

/**
 * Static capability flags a channel advertises so callers can branch without
 * special-casing a provider: whether it has native group threads, whether it can
 * carry media, and its concrete delivery type (§9.3). SMS, for example, has no
 * native group thread - `group: false` - so groups are modeled app-side (MNEMO-48).
 */
export const ChannelCapabilities = z.object({
  group: z.boolean().describe("Native multi-party threads supported?"),
  media: z.boolean().describe("Can carry media (MMS / attachments)?"),
  deliveryType: z
    .enum(["sms", "imessage", "rcs"])
    .describe("The concrete transport this channel delivers over."),
});
/** The inferred TypeScript shape of {@link ChannelCapabilities}. */
export type ChannelCapabilities = z.infer<typeof ChannelCapabilities>;

/**
 * The result of an outbound {@link import("./MessagingChannel.ts").MessagingChannel.send}.
 * A discriminated union on `ok`: success carries the provider message id(s) and the
 * computed `segments` count (for cost/audit, §9.2); failure carries an error string
 * and the HTTP `status` when the provider answered. The channel NEVER throws on a
 * non-2xx provider response - it returns `{ ok: false }` so the caller can log it to
 * the audit stream.
 */
export const SendResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    providerMessageIds: z
      .array(z.string())
      .describe("Provider message id(s) for the sent SMS (e.g. Twilio sid)."),
    segments: z
      .number()
      .int()
      .describe("Number of SMS segments the body was billed as (§9.2 cost)."),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().describe("Human-readable failure reason."),
    status: z
      .number()
      .int()
      .optional()
      .describe("Provider HTTP status, when the provider answered non-2xx."),
  }),
]);
/** The inferred TypeScript shape of {@link SendResult}. */
export type SendResult = z.infer<typeof SendResult>;
