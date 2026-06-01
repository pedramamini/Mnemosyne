/**
 * Outbound agent reply over SMS (MNEMO-46, PRD §9.2/§9.3).
 *
 * The agent loop's final text goes back to the counterparty through the
 * {@link MessagingChannel} seam - the DO never imports Twilio directly. This
 * module constructs the agent's {@link TwilioSmsChannel} (its provisioned
 * `fromNumber` from `agent_numbers`, creds from env) and sends.
 *
 * IMPORTANT: the reply only goes out AFTER the agent loop completes - it is the
 * **async** tail of `onInboundMessage` (the webhook was already acked by the
 * gateway, MNEMO-45), NEVER an inline reply on the webhook request (§9.3).
 *
 * Cost guard (§9.2): SMS bills per ~160-char segment, so a long reply fanning out
 * into many segments is expensive. If the body exceeds {@link REPLY_SEGMENT_LIMIT}
 * segments it is truncated and a short link to the full web thread is appended,
 * instead of paying to deliver a wall of text over SMS.
 */
import type { Env } from "../env.ts";
import { countSegments } from "./segmentation.ts";
import { TwilioSmsChannel } from "./TwilioSmsChannel.ts";
import type { Channel, SendResult } from "./types.ts";

/**
 * Max SMS segments an agent reply may fan out to before we truncate + link to the
 * web thread (§9.2 cost). Four segments (~600 GSM-7 chars) is a generous SMS reply
 * while still bounding the per-message cost.
 */
export const REPLY_SEGMENT_LIMIT = 4;

/** Default Twilio REST base when `env.TWILIO_API_BASE` is unset. */
const DEFAULT_TWILIO_API_BASE = "https://api.twilio.com";

export interface SendAgentReplyInput {
  /** The agent id - used to build the deep link to the full web thread. */
  agentId: string;
  /** The agent's provisioned E.164 (`agent_numbers`) - the SMS `From`. */
  fromNumber: string;
  /** The counterparty's E.164 - the SMS `To`. */
  to: string;
  /** The agent loop's final reply text (pre-truncation). */
  body: string;
  /** The delivery channel (`"sms"` this phase). */
  channel: Channel;
}

/**
 * Send the agent's reply over its messaging channel. Guards over-long bodies
 * (truncate + link, §9.2), constructs the {@link TwilioSmsChannel}, and returns
 * the typed {@link SendResult} (never throws on a non-2xx - the channel surfaces
 * `{ ok: false }` and the caller audit-logs it).
 */
export async function sendAgentReply(
  env: Env,
  input: SendAgentReplyInput,
): Promise<SendResult> {
  const body = guardBodyLength(input.body, threadLink(env, input.agentId));
  const channel = new TwilioSmsChannel({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    apiBase: env.TWILIO_API_BASE || DEFAULT_TWILIO_API_BASE,
    fromNumber: input.fromNumber,
  });
  return channel.send({ to: input.to, body, channel: input.channel });
}

/**
 * If `body` fits within {@link REPLY_SEGMENT_LIMIT} segments, send it as-is.
 * Otherwise truncate it so the body PLUS a "see the full thread" link fits the
 * limit - fanning out many costly segments is worse UX and cost than a terse
 * reply that points at the full web conversation (§9.2). Exported for unit tests.
 */
export function guardBodyLength(body: string, link: string): string {
  if (countSegments(body) <= REPLY_SEGMENT_LIMIT) return body;

  const suffix = link ? `… ${link}` : "…";
  // Shrink the body until body+suffix fits the segment budget. Multiplicative
  // shrink converges in a handful of iterations and always terminates (length
  // strictly decreases). If the suffix alone already exceeds the budget we still
  // return it - better a bare link than an unbounded fan-out.
  let truncated = body;
  while (
    truncated.length > 0 &&
    countSegments(`${truncated.trimEnd()}${suffix}`) > REPLY_SEGMENT_LIMIT
  ) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return `${truncated.trimEnd()}${suffix}`;
}

/**
 * Deep link to the agent's web messaging view (the full thread). Empty string
 * when `APP_BASE_URL` is unset (dev/test) - then {@link guardBodyLength} appends a
 * bare ellipsis instead of a broken link.
 */
function threadLink(env: Env, agentId: string): string {
  const base = env.APP_BASE_URL?.replace(/\/+$/, "");
  return base ? `${base}/agents/${agentId}/messages` : "";
}
