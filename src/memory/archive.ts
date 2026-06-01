/**
 * Whole-brain archive export (PRD §6.9, MNEMO-11).
 *
 * §6.9: the user can "download the entire brain as an archive (zip/tarball)".
 * This builds that archive INSIDE the sandbox (`tar -czf` for tar.gz, `zip -r`
 * for zip) over `/brain`, then reads the bytes back through the MNEMO-06 client.
 *
 * Binary over a text-only client: {@link SandboxClient} is deliberately text-only
 * (`readFile` → string), so we never read the raw archive through it (that would
 * corrupt it). Instead we `base64 -w0` the archive to a sidecar, `readFile` THAT
 * (lossless UTF-8), and decode the base64 back to bytes in the Worker - the same
 * envelope the R2 persistence layer uses (src/sandbox/persistence.ts).
 *
 * `.git` is INCLUDED so a downloaded archive carries full history (the brain's
 * git repo travels with it); transient scratch/cache files are excluded so the
 * download is just the brain, not build noise.
 *
 * OPTIMIZATION (noted, not implemented): for a very large brain this should
 * stream the already-persisted snapshot from R2 (src/sandbox/persistence.ts -
 * the rolling `brains/<id>/snapshot.tar`) rather than re-tarring the live
 * container and buffering the whole thing in memory. The live-tar path here is
 * correct and simplest for the brain sizes this phase targets; swapping in an R2
 * stream (and a `Content-Length` from the R2 object) is a drop-in later.
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { BRAIN_ROOT } from "./layout.ts";

/** Archive container formats the export supports. */
export type ArchiveFormat = "tar" | "zip";

/** Result of {@link archiveBrain}: the bytes plus download metadata. */
export interface BrainArchive {
  /** The archive bytes (decoded from the in-sandbox base64 envelope). */
  bytes: Uint8Array;
  /** Suggested download filename, e.g. `<agentId>-brain-2026-05-24.tar.gz`. */
  filename: string;
  /** MIME type for the `Content-Type` header. */
  contentType: string;
}

/**
 * Transient paths NEVER worth shipping in a brain download - the R2 persistence
 * scratch, the warm marker, and common cache/temp noise. `.git` is intentionally
 * NOT here: history travels with the archive (§6.9).
 */
const ARCHIVE_EXCLUDES: readonly string[] = [
  "*.tmp",
  "*.tgz",
  "*.tar",
  "*.b64",
  ".cache",
  "__pycache__",
  ".mnemosyne-warm",
];

/**
 * Build a whole-brain archive and return its bytes + a suggested filename.
 * Rejects an unknown `format` (typed, before any FS work). `tar` produces a
 * gzipped tarball; `zip` a zip - both rooted at `/brain` so the archive unpacks
 * to the brain's own layout. The build + base64 happen in one shell pass; the
 * sidecar is read back and decoded to bytes here.
 */
export async function archiveBrain(
  env: Env,
  agentId: string,
  format: ArchiveFormat,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainArchive> {
  if (format !== "tar" && format !== "zip") {
    throw new Error(`unsupported archive format: ${String(format)}`);
  }

  // Scratch lives in /tmp (OUTSIDE /brain) so the archive never contains itself.
  const id = crypto.randomUUID();
  const archivePath =
    format === "tar"
      ? `/tmp/mnemosyne-archive-${id}.tar.gz`
      : `/tmp/mnemosyne-archive-${id}.zip`;
  const sidecar = `/tmp/mnemosyne-archive-${id}.b64`;

  const build =
    format === "tar"
      ? // tar from one level above so paths are `brain/...`; gzip; keep .git.
        `tar ${tarExcludes()} -C / -czf ${archivePath} brain`
      : // zip recursively from inside /brain; keep .git; exclude transient noise.
        `cd ${BRAIN_ROOT} && zip -r -q ${archivePath} . ${zipExcludes()}`;

  const built = await sandbox.run(
    `${build} && base64 -w0 ${archivePath} > ${sidecar}`,
  );
  if (built.exitCode !== 0) {
    throw new Error(
      `brain archive (${format}) failed: ${built.stderr || `exit ${built.exitCode}`}`,
    );
  }

  const base64 = await sandbox.readFile(sidecar);
  // Clean up scratch; failure here is non-fatal (idle-down reclaims /tmp anyway).
  await sandbox.run(`rm -f ${archivePath} ${sidecar}`);

  return {
    bytes: decodeBase64(base64),
    filename: suggestedFilename(agentId, format),
    contentType: format === "tar" ? "application/gzip" : "application/zip",
  };
}

/** `<agentId>-brain-<YYYY-MM-DD>.{tar.gz,zip}` - a stable, dated download name. */
export function suggestedFilename(
  agentId: string,
  format: ArchiveFormat,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const ext = format === "tar" ? "tar.gz" : "zip";
  return `${agentId}-brain-${date}.${ext}`;
}

/** `--exclude=PATTERN` flags for tar (transient noise; `.git` kept). */
function tarExcludes(): string {
  return ARCHIVE_EXCLUDES.map((p) => `--exclude='${p}'`).join(" ");
}

/** `-x PATTERN` trailer for zip (transient noise; `.git` kept). */
function zipExcludes(): string {
  // zip matches against the entries' relative paths, so cover nested dirs too.
  const patterns = ARCHIVE_EXCLUDES.flatMap((p) => [`'${p}'`, `'${p}/*'`]);
  return `-x ${patterns.join(" ")}`;
}

/** Decode base64 text → raw bytes (mirror of the persistence-layer envelope). */
function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.trim()), (ch) => ch.charCodeAt(0));
}
