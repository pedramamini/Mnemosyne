/**
 * `safeFetch` - the single time/size/host-safe HTTP GET behind the web tools
 * (MNEMO-17). PRD §6.3: web fetch carries Crema's safety rails - a hard host
 * block, a 15s timeout, and a 200KB content cap.
 *
 * This is a PURE utility: no {@link ToolContext}, no audit emit, no sandbox.
 * It enforces three rails and returns a typed result the calling tool narrates:
 *   1. {@link isBlocked} - refused BEFORE any network call, and AGAIN on the
 *      final post-redirect URL (a redirect must not smuggle us onto a blocked
 *      people-finder host). Fail-closed.
 *   2. {@link WEB_TIMEOUT_MS} - a 15s wall-clock guard via an `AbortController`;
 *      the abort propagates (this function THROWS on timeout) so the caller can
 *      surface a typed timeout error.
 *   3. {@link WEB_MAX_BYTES} - a 200KB cap enforced by a STREAMED byte counter:
 *      we read the body chunk-by-chunk and stop (cancelling the stream) once the
 *      cap is hit, returning `truncated: true` with the bytes we kept. The cap is
 *      a normal partial result, NOT a throw.
 *
 * The body is decoded to text respecting the response charset where feasible
 * (falling back to UTF-8). Raw HTML is left intact here - turning markup into
 * readable text is `extractText.ts`, run by the tool layer before spilling.
 */
import { isBlocked } from "./blockedHosts.ts";

/** 15s wall-clock guard on a single fetch (PRD §6.3). */
export const WEB_TIMEOUT_MS = 15_000;

/** 200KB body cap - anything past this is dropped and `truncated` is set. */
export const WEB_MAX_BYTES = 200 * 1024;

/** A browser-ish UA + text-leaning accept so origins return readable pages. */
const FETCH_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 MnemosyneBot/0.1",
  accept: "text/html,application/xhtml+xml,text/plain,application/json",
};

/** Outcome of one {@link safeFetch}. Exactly the subset the tool layer needs. */
export interface SafeFetchResult {
  /** The response's `res.ok` (2xx). A non-2xx body is still returned. */
  ok: boolean;
  /** HTTP status (0 when blocked before any request). */
  status: number;
  /** Response `content-type` header (empty when blocked). */
  contentType: string;
  /** True UTF-8/decoded byte count of the body we kept (post-cap). */
  bytes: number;
  /** Decoded text body (raw - HTML is reduced to text by the tool layer). */
  body: string;
  /** True when the 200KB cap clipped the body. */
  truncated: boolean;
  /** Set when {@link isBlocked} refused the URL (initial or post-redirect). */
  blocked?: boolean;
}

/**
 * Time/size/host-safe GET. Returns `{ blocked: true }` without touching the
 * network for a {@link BLOCKED_HOSTS} URL (or a redirect onto one); returns a
 * `truncated` partial body at the {@link WEB_MAX_BYTES} cap; THROWS on the 15s
 * timeout / a passed `signal` abort / a transport failure (the caller turns that
 * into a typed error).
 */
export async function safeFetch(
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<SafeFetchResult> {
  // Rail 1 (pre-flight): refuse a blocked host before any network call.
  if (isBlocked(url)) {
    return blockedResult(0, "");
  }

  // Rail 2: a 15s timeout, chained to any caller-supplied signal so an upstream
  // cancel still tears this fetch down.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: FETCH_HEADERS,
    });

    // Rail 1 (post-redirect): re-check the FINAL URL - a 30x must not land us on
    // a blocked host. `res.url` is the resolved URL; fall back to the request URL
    // for hand-built test responses that don't set it.
    const finalUrl = res.url || url;
    if (isBlocked(finalUrl)) {
      await res.body?.cancel().catch(() => {});
      return blockedResult(res.status, res.headers.get("content-type") ?? "");
    }

    const contentType = res.headers.get("content-type") ?? "";

    // Rail 3: stream the body with a hard byte cap.
    const { buf, truncated } = await readCapped(res);
    const body = decodeBody(buf, contentType);

    return {
      ok: res.ok,
      status: res.status,
      contentType,
      bytes: buf.byteLength,
      body,
      truncated,
    };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

/** A uniform `blocked` result (no body, no bytes). */
function blockedResult(status: number, contentType: string): SafeFetchResult {
  return {
    ok: false,
    status,
    contentType,
    bytes: 0,
    body: "",
    truncated: true,
    blocked: true,
  };
}

/**
 * Read `res.body` as a stream, accumulating up to {@link WEB_MAX_BYTES}. Once the
 * cap is reached we keep only the bytes up to the cap, cancel the stream (so we
 * stop pulling from the network), and return `truncated: true`. A response with
 * no readable stream falls back to a capped `arrayBuffer()` read.
 */
async function readCapped(
  res: Response,
): Promise<{ buf: Uint8Array; truncated: boolean }> {
  const stream = res.body;
  if (!stream) {
    const full = new Uint8Array(await res.arrayBuffer());
    if (full.byteLength > WEB_MAX_BYTES) {
      return { buf: full.subarray(0, WEB_MAX_BYTES), truncated: true };
    }
    return { buf: full, truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = WEB_MAX_BYTES - total;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { buf: concat(chunks, total), truncated };
}

/** Concatenate `chunks` into one `Uint8Array` of exactly `total` bytes. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Decode `buf` to text, honoring a `charset=` in the content-type where the
 * platform's {@link TextDecoder} recognizes it; falls back to UTF-8 otherwise
 * (an unknown/garbage charset must not crash a fetch).
 */
function decodeBody(buf: Uint8Array, contentType: string): string {
  const charset = /charset=([^;]+)/i
    .exec(contentType)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (charset && charset.toLowerCase() !== "utf-8") {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // Unknown label - fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}
