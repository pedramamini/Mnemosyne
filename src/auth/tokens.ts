/**
 * Magic-link tokens - single-use, short-lived, never stored in the clear.
 *
 * The raw token is mailed to the user and never persisted: KV holds only
 * `SHA-256(token)` keyed as `magic:<hash>`, so a KV dump cannot be replayed
 * into a login. Tokens expire two ways - a 15-minute KV TTL reaps the key, and
 * `consumeMagicToken` re-checks the stored `exp` (defense in depth, and the
 * seam the expiry test drives). Consumption deletes the key first, making each
 * token usable exactly once.
 */
import type { Env } from "../env.ts";

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const TOKEN_BYTES = 32; // 256 bits of entropy → 64 hex chars

/** Stored value behind a `magic:<hash>` key. */
interface MagicEntry {
  email: string;
  exp: number; // epoch ms after which the token is invalid
}

/** Hex-encode bytes. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

const keyFor = (hash: string) => `magic:${hash}`;

/**
 * Generate a random magic token, store only its hash → `{ email, exp }` in KV
 * with a 15-minute TTL, and return the raw token to mail to the user.
 */
export async function issueMagicToken(
  env: Env,
  email: string,
): Promise<string> {
  const raw = toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const hash = await sha256Hex(raw);
  const entry: MagicEntry = {
    email,
    exp: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };
  await env.SESSIONS.put(keyFor(hash), JSON.stringify(entry), {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
  return raw;
}

/**
 * Look up a token's hash, delete it (single-use), and return the bound email if
 * still unexpired - otherwise `null`. A second consume of the same token, or a
 * token whose `exp` has passed, both return `null`.
 */
export async function consumeMagicToken(
  env: Env,
  token: string,
): Promise<string | null> {
  const hash = await sha256Hex(token);
  const key = keyFor(hash);
  const raw = await env.SESSIONS.get(key);
  if (raw === null) return null;
  // Delete first: even an expired token must not survive a consume attempt.
  await env.SESSIONS.delete(key);
  const entry = JSON.parse(raw) as MagicEntry;
  if (entry.exp < Date.now()) return null;
  return entry.email;
}
