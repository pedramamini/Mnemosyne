/**
 * Twilio webhook signature validation (MNEMO-44, PRD §9.6).
 *
 * Validate the `X-Twilio-Signature` header on every inbound webhook so only Twilio
 * can post to the gateway (MNEMO-45). The scheme (per Twilio's security docs):
 *
 *   1. Take the full request URL (scheme + host + path + query, exactly as Twilio
 *      reached it).
 *   2. Sort the POST params by key, then append each `key` immediately followed by
 *      its `value` (no separators) to the URL → the signing string.
 *   3. HMAC-SHA1 the signing string with the account auth token as the key.
 *   4. Base64-encode the MAC and constant-time-compare it to the header value.
 *
 * Dependency-light + Workers-native: HMAC runs over Web Crypto `crypto.subtle`
 * (there is no Node `crypto` in the Workers runtime), so this is async.
 */

/** Base64-encode raw bytes (no Buffer in the Workers runtime - mirrors secrets.ts). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Build Twilio's signing string: the full URL with the POST params sorted by key
 * and concatenated as `key+value`. Keys sort by Unicode code point (JS default
 * string sort), matching Twilio's case-sensitive ordering.
 */
function buildSigningString(
  fullUrl: string,
  formParams: Record<string, string>,
): string {
  let signing = fullUrl;
  for (const key of Object.keys(formParams).sort()) {
    signing += key + formParams[key];
  }
  return signing;
}

/**
 * Constant-time string compare - avoids leaking how many leading bytes matched via
 * timing. (The length check up front can reveal a length mismatch, which is fine for
 * fixed-width base64 signatures.)
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True iff `signature` is the valid `X-Twilio-Signature` for the given request
 * (URL + sorted POST params) under `authToken`. Pure: no I/O beyond Web Crypto.
 * Used by {@link import("./TwilioSmsChannel.ts").TwilioSmsChannel.verifyInboundSignature}
 * so the gateway in MNEMO-45 can trust inbound webhooks.
 */
export async function validateTwilioSignature(
  authToken: string,
  fullUrl: string,
  formParams: Record<string, string>,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(buildSigningString(fullUrl, formParams)),
  );
  const expected = toBase64(new Uint8Array(mac));
  return constantTimeEqual(expected, signature);
}
