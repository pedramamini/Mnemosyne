/**
 * Content hashing for incremental re-index (the llm-wiki-compiler change-detection
 * pattern, adapted to Mnemosyne's brain).
 *
 * Every neuron carries a `content_hash` so a brain-wide re-index sweep can skip
 * notes whose bytes have not changed since they were last indexed - turning the
 * O(N) "read + re-parse every note" sweep that runs after every research phase
 * (src/agent/MnemosyneAgent.ts `reindexAllNotes`) into an O(changed) one.
 *
 * SHA-256 over the note's UTF-8 bytes, hex-encoded, via Web Crypto so the SAME
 * function runs in the Worker/DO and in Node tests (both expose `crypto.subtle`).
 * The hex digest is byte-for-byte comparable with the container's `sha256sum`
 * output, so the batched FS-side hash (used by the bulk sweep) and this in-process
 * hash (used by the single-note write path) agree on what "unchanged" means.
 */

/** SHA-256 hex digest of `content`'s UTF-8 bytes. Identical in the DO and in Node. */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
