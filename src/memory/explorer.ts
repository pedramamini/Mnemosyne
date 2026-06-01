/**
 * Brain file-explorer service (PRD §6.9, MNEMO-11).
 *
 * The web UI's Brain Explorer (MNEMO-38) consumes this: the brain is browsable
 * and editable from the web - list/read/write/create/delete files ANYWHERE under
 * `/brain` (`notes/`, `tools/`, `reports/`, nested), not just notes. Three
 * invariants make that safe and consistent with agent writes:
 *
 *   1. Containment - every path is run through {@link assertInsideBrain}
 *      (src/memory/layout.ts) BEFORE any FS call, so a `..`/absolute/backslash
 *      input can never escape `/brain`. There is ONE guard, shared with the note
 *      write path; this module never re-implements it.
 *   2. Notes are first-class memory writes - when an edited/created/deleted path
 *      is a note (`*.md` under `/brain/notes`), the edit is funnelled through the
 *      MNEMO-10 write pipeline (writeNote/deleteNote), so the reindex→commit
 *      ordering is byte-for-byte identical to an agent write and the UI's edit
 *      shows up in the graph + history exactly like one. Non-note files
 *      (tools/reports/binaries) fall back to a raw write/remove + an
 *      `explorer:`-prefixed commit (they are not neurons, so no reindex).
 *   3. Bounded + binary-safe reads - reads are size-capped (a 50MB blob is
 *      rejected, never marshalled as a JSON string) and binary files come back
 *      base64-encoded, mirroring the persistence layer's text-only-wrapper
 *      discipline (src/sandbox/persistence.ts).
 *
 * All FS access goes through the MNEMO-06 {@link SandboxClient} wrapper; the
 * `sandbox` handle is injectable (default = the live handle) so the service is
 * unit-testable without a container, like the rest of `src/memory`.
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { explorerDeleteMsg, explorerEditMsg } from "./commit-messages.ts";
import { shQuote } from "./git.ts";
import {
  assertInsideBrain,
  BRAIN_ROOT,
  isNotePath,
  noteSlugFromPath,
} from "./layout.ts";
import { type BrainWriteHooks, deleteNote, writeNote } from "./write.ts";

/**
 * Hard cap on a single explorer read (MNEMO-11). Anything larger is rejected so a
 * huge asset never gets pulled into the Worker's memory or marshalled across RPC.
 * Generous enough for any hand-edited note/tool/report; assets beyond it belong in
 * the whole-brain archive (src/memory/archive.ts), not an inline read.
 */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/** A directory entry from {@link listTree}: absolute path + type + size + mtime. */
export interface BrainEntry {
  /** Absolute path under `/brain`. */
  path: string;
  type: "file" | "dir";
  /** Size in bytes (0 for directories). */
  size: number;
  /** Last-modified time, epoch ms (matches the graph index's `updated_at`). */
  modified: number;
}

/** A read file from {@link readBrainFile}: text inline, binary base64-encoded. */
export interface BrainFileContent {
  path: string;
  /** UTF-8 text, or base64 of the raw bytes when `encoding` is `"base64"`. */
  content: string;
  encoding: "utf8" | "base64";
  /** Size in bytes of the on-disk file. */
  size: number;
}

/** Input for a general explorer write/create (a note, tool, report, or binary). */
export interface BrainWriteInput {
  /** Path relative to `/brain` or absolute under it; validated before any FS op. */
  path: string;
  /** UTF-8 text, or base64 of the bytes when `encoding` is `"base64"`. */
  content: string;
  /** `"utf8"` (default) writes text; `"base64"` decodes to raw bytes in-sandbox. */
  encoding?: "utf8" | "base64";
}

/** What the write/create/delete paths return: the absolute path + commit sha (or null). */
export interface BrainWriteResult {
  path: string;
  commit: string | null;
}

/**
 * Thrown when an explorer read would exceed {@link MAX_READ_BYTES}. A typed error
 * (not a silent truncate) so the route can surface a clear "too large" 413/400
 * rather than streaming a partial, corrupt file.
 */
export class BrainFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(`brain file too large: ${path} is ${size} bytes (max ${limit})`);
    this.name = "BrainFileTooLargeError";
  }
}

/**
 * List entries under `/brain` (or `subpath`), recursively, as typed
 * {@link BrainEntry}s. Uses one `find` with a `-printf` format (type, size,
 * mtime, path - tab-separated) so the whole subtree comes back parseable in a
 * single subrequest. The `.git` directory is excluded - it is internal plumbing,
 * not brain content the user browses (the archive export includes it; the
 * explorer view does not). `subpath` is contained before the FS touch.
 */
export async function listTree(
  env: Env,
  agentId: string,
  subpath?: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainEntry[]> {
  const root = subpath ? assertInsideBrain(subpath) : BRAIN_ROOT;
  // %y type (f/d/l), %s size, %T@ mtime (epoch.frac), %p path - tab-separated.
  // `-mindepth 1` drops the root itself; the `.git` prunes keep internals out.
  const found = await sandbox.run(
    `find ${shQuote(root)} -mindepth 1 ` +
      `-name .git -prune -o -path '*/.git/*' -prune -o ` +
      `-printf '%y\\t%s\\t%T@\\t%p\\n'`,
  );

  const entries: BrainEntry[] = [];
  for (const line of found.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [kind, size, mtime, ...rest] = line.split("\t");
    const path = rest.join("\t"); // a path may (rarely) contain a tab
    if (path === undefined || path === "") continue;
    entries.push({
      path,
      type: kind === "d" ? "dir" : "file",
      size: Number.parseInt(size, 10) || 0,
      // %T@ is `seconds.fraction`; normalize to epoch ms.
      modified: Math.round((Number.parseFloat(mtime) || 0) * 1000),
    });
  }
  return entries;
}

/**
 * Read one brain file, size-capped and binary-aware. A single probe returns the
 * file's kind (missing/dir/file), size, and text/binary classification; we then
 * reject an over-cap file, read text via the client's UTF-8 `readFile`, and
 * base64-encode binary bytes in-sandbox (`base64 -w0`) so the bytes survive the
 * text-only client surface losslessly (same envelope as the persistence layer).
 */
export async function readBrainFile(
  env: Env,
  agentId: string,
  path: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainFileContent> {
  const abs = assertInsideBrain(path);
  const q = shQuote(abs);

  // One subrequest classifies the path. A text file prints `file\n<size>\ntext`;
  // a binary one `file\n<size>\nbinary`; a directory `dir`; nothing `missing`.
  // The text test: `grep -qI .` matches a printable char (and skips binary); an
  // empty file (`! -s`) counts as text so a 0-byte note reads as "".
  const probe = await sandbox.run(
    `if [ ! -e ${q} ]; then echo missing; ` +
      `elif [ -d ${q} ]; then echo dir; ` +
      `else printf 'file\\n%s\\n' "$(stat -c %s ${q})"; ` +
      `if LC_ALL=C grep -qI . ${q} 2>/dev/null || [ ! -s ${q} ]; ` +
      `then echo text; else echo binary; fi; fi`,
  );
  const lines = probe.stdout.split("\n").map((l) => l.trim());

  if (lines[0] === "missing") {
    throw new Error(`no such brain file: ${abs}`);
  }
  if (lines[0] === "dir") {
    throw new Error(`not a file (is a directory): ${abs}`);
  }
  const size = Number.parseInt(lines[1] ?? "", 10) || 0;
  if (size > MAX_READ_BYTES) {
    throw new BrainFileTooLargeError(abs, size, MAX_READ_BYTES);
  }

  if (lines[2] === "binary") {
    const b64 = await sandbox.run(`base64 -w0 ${q}`);
    return { path: abs, content: b64.stdout, encoding: "base64", size };
  }
  const content = await sandbox.readFile(abs);
  return { path: abs, content, encoding: "utf8", size };
}

/**
 * Write (overwrite) a brain file. A note path is funnelled through the MNEMO-10
 * {@link writeNote} pipeline (writeFile → reindex → commit) so it lands in the
 * graph + history identically to an agent write; a non-note path does a raw
 * write of its parent-created file, then ONE `explorer: edit <path>` commit (no
 * reindex - it is not a neuron). Binary content is base64 and decoded in-sandbox.
 */
export async function writeBrainFile(
  env: Env,
  agentId: string,
  input: BrainWriteInput,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainWriteResult> {
  const abs = assertInsideBrain(input.path);

  // Notes are first-class memory writes - same pipeline, same commit prefix.
  if (isNotePath(abs)) {
    const content =
      input.encoding === "base64"
        ? decodeBase64Utf8(input.content)
        : input.content;
    const result = await writeNote(
      env,
      agentId,
      { slug: noteSlugFromPath(abs), content },
      hooks,
      sandbox,
    );
    return { path: result.path, commit: result.commit };
  }

  await rawWrite(sandbox, abs, input.content, input.encoding);
  const commit = await hooks.commitBrain(explorerEditMsg(abs));
  return { path: abs, commit };
}

/**
 * Create a brain file, failing if the path already exists (the explorer's
 * "new file" - distinct from {@link writeBrainFile}'s overwrite). After the
 * existence check it shares the write path, so a new note still reindexes +
 * commits through the MNEMO-10 pipeline.
 */
export async function createBrainFile(
  env: Env,
  agentId: string,
  input: BrainWriteInput,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainWriteResult> {
  const abs = assertInsideBrain(input.path);
  const exists = await sandbox.run(
    `test -e ${shQuote(abs)} && echo y || echo n`,
  );
  if (exists.stdout.trim() === "y") {
    throw new Error(`brain path already exists: ${abs}`);
  }
  return writeBrainFile(env, agentId, input, hooks, sandbox);
}

/**
 * Create a directory under `/brain` (`mkdir -p`). Git does not track empty
 * directories, so there is nothing to commit until a file lands inside - this
 * just makes the folder the explorer can then write into. Returns the path.
 */
export async function createBrainDir(
  env: Env,
  agentId: string,
  path: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<{ path: string }> {
  const abs = assertInsideBrain(path);
  await sandbox.mkdir(abs);
  return { path: abs };
}

/**
 * Delete a brain path. A note goes through the MNEMO-10 {@link deleteNote}
 * pipeline (rm → removeNeuron → `memory: delete` commit) so its incoming links
 * go dangling in the graph exactly as an agent delete would; any other path
 * (file OR directory) is `rm -rf`'d and committed as `explorer: delete <path>`.
 */
export async function deleteBrainPath(
  env: Env,
  agentId: string,
  path: string,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<BrainWriteResult> {
  const abs = assertInsideBrain(path);

  if (isNotePath(abs)) {
    const result = await deleteNote(
      env,
      agentId,
      noteSlugFromPath(abs),
      hooks,
      sandbox,
    );
    return { path: result.path, commit: result.commit };
  }

  // `-rf` so deleting a directory (or an already-absent path) is not an error.
  await sandbox.run(`rm -rf ${shQuote(abs)}`);
  const commit = await hooks.commitBrain(explorerDeleteMsg(abs));
  return { path: abs, commit };
}

/**
 * Raw write of a non-note file: create the parent dir, then write text directly
 * or - for `base64` - stage the base64 to a sidecar and `base64 -d` it into place
 * (the client surface is text-only, so binary never round-trips through it). The
 * sidecar is removed after decode so it never lingers in the tree.
 */
async function rawWrite(
  sandbox: SandboxClient,
  abs: string,
  content: string,
  encoding: "utf8" | "base64" | undefined,
): Promise<void> {
  const parent = abs.slice(0, abs.lastIndexOf("/"));
  if (parent && parent !== abs) await sandbox.mkdir(parent);

  if (encoding === "base64") {
    const sidecar = `/tmp/mnemosyne-explorer-${crypto.randomUUID()}.b64`;
    await sandbox.writeFile(sidecar, content);
    await sandbox.run(
      `base64 -d ${shQuote(sidecar)} > ${shQuote(abs)} && rm -f ${shQuote(sidecar)}`,
    );
    return;
  }
  await sandbox.writeFile(abs, content);
}

/** Decode base64 → UTF-8 text (for a note path supplied as base64). */
function decodeBase64Utf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
