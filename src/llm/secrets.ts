/**
 * BYOK secret custody (MNEMO-14, PRD §6.1).
 *
 * AES-GCM authenticated encryption over WebCrypto for the raw provider keys a
 * user submits. The 256-bit content key is DERIVED from `env.KEY_ENCRYPTION_SECRET`
 * (the Wrangler master secret) via SHA-256, so the same secret always derives the
 * same key without persisting any key material.
 *
 * These are PURE functions over WebCrypto - no storage, no I/O. The ciphertext
 * (what gets stored in `llm_profiles.key_ref`) is the random 12-byte IV
 * prepended to the GCM output, base64-encoded; each `encryptKey` therefore yields
 * a different blob for the same plaintext.
 *
 * Custody invariant: a key is decrypted ONLY in-process, immediately before
 * constructing the provider client (see `getModel.ts`). It is never logged, never
 * written back to D1 in the clear, and never returned to a client.
 */
import type { Env } from "../env.ts";

/** AES-GCM standard IV length (96 bits) - random per encryption. */
const IV_BYTES = 12;

/** Derive the stable 256-bit AES-GCM key from the master secret (SHA-256). */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Base64-encode raw bytes (no Buffer in the Workers runtime). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a base64 string back to raw bytes. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encrypt a raw provider key for storage. Returns base64 of `iv || ciphertext`.
 * The random IV makes two encryptions of the same plaintext differ.
 */
export async function encryptKey(env: Env, plaintext: string): Promise<string> {
  const key = await deriveKey(env.KEY_ENCRYPTION_SECRET);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return toBase64(packed);
}

/**
 * Reverse {@link encryptKey}: split the IV from the ciphertext and decrypt.
 * Throws if `stored` is not a valid blob produced by this module under the same
 * `KEY_ENCRYPTION_SECRET` (GCM auth-tag mismatch / malformed input) - callers
 * treat that as "no usable key" and degrade rather than leak.
 */
export async function decryptKey(env: Env, stored: string): Promise<string> {
  const key = await deriveKey(env.KEY_ENCRYPTION_SECRET);
  const packed = fromBase64(stored);
  const iv = packed.subarray(0, IV_BYTES);
  const ciphertext = packed.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
