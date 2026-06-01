/**
 * Shared Twilio REST helpers (MNEMO-47) - the Basic-auth + apiBase pattern lifted
 * from {@link TwilioSmsChannel} (MNEMO-44) so number provisioning
 * (src/messaging/provisioning.ts) and A2P 10DLC onboarding (src/messaging/a2p.ts)
 * reuse ONE auth/URL convention rather than re-deriving it. Twilio authenticates
 * REST calls with HTTP Basic auth (account SID : auth token); these are Wrangler
 * secrets, and `TWILIO_API_BASE` is a repointable plain var (defaults to the real
 * Twilio host, overridable to a mock in tests).
 */
import type { Env } from "../env.ts";

/** Default Twilio REST base when `env.TWILIO_API_BASE` is unset. */
const DEFAULT_TWILIO_API_BASE = "https://api.twilio.com";

/** The Twilio REST base, trailing slash trimmed (so joined paths never double up). */
export function twilioApiBase(env: Env): string {
  return (env.TWILIO_API_BASE || DEFAULT_TWILIO_API_BASE).replace(/\/+$/, "");
}

/**
 * The `Authorization: Basic …` header value for a Twilio REST call - base64 of
 * `accountSid:authToken`, exactly as {@link TwilioSmsChannel.send} builds it.
 */
export function twilioAuthHeader(env: Env): string {
  return `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
}

/**
 * A URL under the account's classic REST namespace
 * (`${apiBase}/2010-04-01/Accounts/${SID}/${suffix}`) - the namespace the number
 * search + purchase + release resources live under. The A2P Trust Hub / Messaging
 * endpoints (a2p.ts) use different bases, so they build their own URLs with
 * {@link twilioAuthHeader}.
 */
export function twilioAccountUrl(env: Env, suffix: string): string {
  return `${twilioApiBase(env)}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/${suffix}`;
}
