/**
 * Twilio inbound webhook → channel-agnostic {@link InboundMessage} (MNEMO-45,
 * PRD §9.3).
 *
 * Twilio POSTs its Messaging webhook as `application/x-www-form-urlencoded`. This
 * is the pure mapping from those form fields to the seam's {@link InboundMessage}
 * shape (MNEMO-44) - so the gateway and the agent loop never touch Twilio's field
 * names. No I/O: the gateway parses the body and validates the signature; this
 * just translates + validates the resulting shape.
 *
 * Field mapping (Twilio → InboundMessage):
 *   From          → from              (sender, E.164)
 *   To            → to                (the agent's provisioned number, E.164)
 *   Body          → body              (message text)
 *   MessageSid    → providerMessageId (Twilio's own id)
 *   NumMedia + MediaUrl0..N → mediaUrls (MMS attachments; [] for plain SMS)
 *
 * `channel` is `"sms"` (the only LIVE transport, §9.2) and `threadId` is `null`:
 * 1:1 SMS has no provider thread id, and app-modeled group threads (MNEMO-48) are
 * keyed differently.
 */
import { InboundMessage } from "./types.ts";

/**
 * Thrown when a Twilio form payload is missing the fields a message can't exist
 * without (`From`/`To`/`Body`). Surfaced as a typed error (not a silent default)
 * so the gateway can reject a malformed webhook loudly rather than handing a
 * half-formed message to the agent loop.
 */
export class MalformedInboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedInboundError";
  }
}

/**
 * Collect the `MediaUrl0..N` attachment URLs Twilio sends for an MMS, bounded by
 * the `NumMedia` count it reports. Non-numeric / absent `NumMedia` ⇒ no media. A
 * gap (a missing `MediaUrlK`) stops collection - Twilio numbers them densely from
 * 0, so a hole means the count over-reported.
 */
function collectMediaUrls(form: Record<string, string>): string[] {
  const count = Number.parseInt(form.NumMedia ?? "", 10);
  if (!Number.isFinite(count) || count <= 0) return [];
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const url = form[`MediaUrl${i}`];
    if (typeof url !== "string" || url === "") break;
    urls.push(url);
  }
  return urls;
}

/**
 * Map a Twilio Messaging webhook form payload to a validated
 * {@link InboundMessage}. Throws {@link MalformedInboundError} when `From`, `To`,
 * or `Body` is absent. Pure function - no I/O.
 */
export function normalizeTwilioInbound(
  form: Record<string, string>,
): InboundMessage {
  for (const field of ["From", "To", "Body"] as const) {
    if (typeof form[field] !== "string") {
      throw new MalformedInboundError(
        `Twilio inbound payload missing required field: ${field}`,
      );
    }
  }

  const candidate = {
    from: form.From,
    to: form.To,
    body: form.Body,
    channel: "sms",
    threadId: null,
    providerMessageId: form.MessageSid ?? null,
    mediaUrls: collectMediaUrls(form),
  };

  // Parse through the schema so any drift (e.g. a non-string MediaUrl) fails at
  // the boundary rather than leaking an untyped shape into the agent loop.
  const parsed = InboundMessage.safeParse(candidate);
  if (!parsed.success) {
    throw new MalformedInboundError(
      `Twilio inbound payload failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
