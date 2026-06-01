/**
 * R2-backed durability for the brain FS (PRD §8.4: the sandbox FS persists to
 * R2 across sleeps; billing is active-time only, so the container is released
 * once persisted). The sandbox is ephemeral; R2 is the durable home of the
 * brain between wakes.
 *
 * Archive envelope - why base64 text, not raw bytes: the {@link SandboxClient}
 * surface is deliberately text-only (`readFile` -> string, `writeFile(string)`),
 * so we never round-trip a binary tar through it (that would corrupt it). Inside
 * the container we `tar | gzip | base64` to a sidecar text file, `readFile` THAT
 * (lossless UTF-8), and store the base64 in R2. Restore is the mirror: write the
 * base64 back as a file, then `base64 -d | tar -xz` in the container. Keeping the
 * wrapper text-only is intentional; binary streaming is a later concern.
 *
 * R2 object versioning (enabled on the bucket, see wrangler.toml) is the coarse
 * restore backstop noted in PRD §6.9; fine-grained per-file diff/restore is git
 * (MNEMO-07 / MNEMO-12), not this layer.
 */
import type { Env } from "../env.ts";
// `/brain` now has one canonical owner: the brain layout module (MNEMO-07).
// Re-exported here so existing importers (sandbox/lifecycle.ts) keep their path,
// while there is a single source of truth for the root - no drift.
import { BRAIN_ROOT } from "../memory/layout.ts";
import type { SandboxClient } from "./client.ts";

export { BRAIN_ROOT };

/** Scratch paths for the archive envelope (sidecar base64 of the gzipped tar). */
const TMP_TAR = "/tmp/mnemosyne-brain.tgz";
const TMP_B64 = "/tmp/mnemosyne-brain.b64";

/**
 * R2 key for an agent's brain snapshot. The default (no label) is the rolling
 * "latest" snapshot the lifecycle persists on idle-down; a label produces a
 * distinct key so MNEMO-12 versioning and recovery snapshots coexist under the
 * same agent prefix without clobbering the rolling one.
 *
 *   snapshotKey("a")            -> "brains/a/snapshot.tar"
 *   snapshotKey("a", "v3")      -> "snapshots/a/v3.tar"
 */
export function snapshotKey(agentId: string, label?: string): string {
  return label
    ? `snapshots/${agentId}/${label}.tar`
    : `brains/${agentId}/snapshot.tar`;
}

/**
 * Archive the sandbox's brain tree and store it in R2. Returns `false` (no-op)
 * if the brain root doesn't exist yet - a fresh agent that has written nothing
 * has nothing to persist. With a `label`, writes to the versioned key instead
 * of the rolling "latest" key.
 *
 * Three subrequests (PRD §8.5): one `run` to build the archive, one `readFile`,
 * one R2 `put`.
 */
export async function persistToR2(
  env: Env,
  agentId: string,
  sandbox: SandboxClient,
  label?: string,
): Promise<boolean> {
  // Build the gzipped-tar -> base64 sidecar in one shell pass. `test -d` guards
  // a never-written brain so we don't archive (and store) an empty tree.
  const archive = await sandbox.run(
    `test -d ${BRAIN_ROOT} && ` +
      `tar -C ${BRAIN_ROOT} -czf ${TMP_TAR} . && ` +
      `base64 -w0 ${TMP_TAR} > ${TMP_B64}`,
  );
  if (archive.exitCode !== 0) return false;

  const base64 = await sandbox.readFile(TMP_B64);
  await env.BRAIN_BUCKET.put(snapshotKey(agentId, label), base64);
  return true;
}

/**
 * Fetch an agent's latest brain snapshot from R2 and unpack it into the sandbox.
 * Returns `false` if no snapshot exists (cold agent that never persisted) so the
 * caller can treat a first-ever wake as an empty brain. With a `label`, restores
 * that specific versioned snapshot (recovery path, MNEMO-12).
 */
export async function restoreFromR2(
  env: Env,
  agentId: string,
  sandbox: SandboxClient,
  label?: string,
): Promise<boolean> {
  const object = await env.BRAIN_BUCKET.get(snapshotKey(agentId, label));
  if (!object) return false;

  const base64 = await object.text();
  await sandbox.mkdir(BRAIN_ROOT);
  await sandbox.writeFile(TMP_B64, base64);
  await sandbox.run(
    `base64 -d ${TMP_B64} > ${TMP_TAR} && ` +
      `tar -C ${BRAIN_ROOT} -xzf ${TMP_TAR}`,
  );
  return true;
}
