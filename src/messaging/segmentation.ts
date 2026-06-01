/**
 * SMS length / segmentation math (MNEMO-44). PURE - no I/O, no provider.
 *
 * Two jobs: (a) report the billed `segments` count in {@link
 * import("./types.ts").SendResult} for cost/audit, and (b) let later phases warn the
 * agent when a reply will fan out into many costly segments (PRD §9.2 cost - SMS
 * segments at ~160 GSM-7 chars, so replies should stay terse and link to the full
 * web thread). An SMS is encoded as GSM-7 when every character is in the GSM-7
 * alphabet, else UCS-2 (UTF-16); each encoding has a different single- vs
 * multi-part payload size, which is what these constants capture.
 */

/** GSM-7 single-segment payload (septets). */
export const GSM7_SINGLE = 160;
/** GSM-7 per-segment payload once a message is multi-part (a 7-septet UDH header is reserved). */
export const GSM7_CONCAT = 153;
/** UCS-2 single-segment payload (UTF-16 code units). */
export const UCS2_SINGLE = 70;
/** UCS-2 per-segment payload once a message is multi-part. */
export const UCS2_CONCAT = 67;

/**
 * GSM 03.38 BASIC alphabet (the 1-septet characters), minus the CR/LF controls
 * which are appended below. Space sits between `É` and `!`. Deliberately the
 * conservative standard set - anything outside it (and the extension set) forces
 * UCS-2.
 */
const GSM7_BASIC =
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/**
 * GSM 03.38 EXTENSION characters - still GSM-7, but each costs TWO septets (it is
 * sent as the ESC prefix + the char). Form feed plus `^{}\[~]|€`.
 */
const GSM7_EXTENSION = "\f^{}\\[~]|€";

const BASIC_SET = new Set([...GSM7_BASIC, "\n", "\r"]);
const EXTENSION_SET = new Set([...GSM7_EXTENSION]);

/**
 * True iff every character of `body` can be encoded in GSM-7 (basic OR extension
 * set). A single emoji, CJK ideograph, or other out-of-set character makes the
 * whole message UCS-2 - there is no per-character mixing on the wire.
 */
export function isGsm7(body: string): boolean {
  for (const ch of body) {
    if (!BASIC_SET.has(ch) && !EXTENSION_SET.has(ch)) return false;
  }
  return true;
}

/** Septet count of a GSM-7 body: 1 per basic char, 2 per extension char. */
function gsm7Length(body: string): number {
  let septets = 0;
  for (const ch of body) septets += EXTENSION_SET.has(ch) ? 2 : 1;
  return septets;
}

/**
 * The number of SMS segments `body` will be billed as. Uses the SINGLE-segment
 * limit while the message fits one segment, else the per-segment CONCAT limit
 * (multi-part SMS reserve part of each segment for the concatenation header). GSM-7
 * counts septets (extension chars cost 2); UCS-2 counts UTF-16 code units (an
 * astral emoji is 2). An empty body is one (trivial) segment.
 */
export function countSegments(body: string): number {
  if (isGsm7(body)) {
    const len = gsm7Length(body);
    return len <= GSM7_SINGLE ? 1 : Math.ceil(len / GSM7_CONCAT);
  }
  // UCS-2 length is UTF-16 code units, matching how carriers count the 70/67 limit.
  const len = body.length;
  return len <= UCS2_SINGLE ? 1 : Math.ceil(len / UCS2_CONCAT);
}
