/**
 * Brain git history, diffs, and restore (PRD §6.9, MNEMO-12).
 *
 * The web exposes the brain's revision history - commit log, per-file diffs, and
 * one-click restore to a prior revision. This doubles as the safety net the
 * consolidation pass requires (versioned + diffed before commit, MNEMO-10) and a
 * guard against a bad self-authored-tool write. Git-in-sandbox (MNEMO-07) gives
 * the clean per-file diff/restore here; R2 object versioning (MNEMO-06) is the
 * coarser backstop the tree-restore takes before it touches anything.
 *
 * Conventions:
 *   - EVERY git read goes through the MNEMO-06 {@link SandboxClient} wrapper (never
 *     the raw SDK), via the SAME `git -C /brain` prefix the write side uses
 *     ({@link GIT}) - one source of truth, no drift. The `sandbox` handle is
 *     injectable (default = the live handle) so the issued git sequence is
 *     testable without a container, like the rest of `src/memory`.
 *   - Machine-parseable git output only: `-z` / `%x1f` field+record delimiters so
 *     subjects and filenames containing spaces (or even tabs) parse unambiguously,
 *     and `--numstat` for per-file add/delete counts.
 *   - Restore is the ONE destructive op and is therefore conservative: it returns
 *     the tree/file to the chosen revision by creating a **new commit** (so the
 *     restore is itself reversible and shows up in history) - never a hard reset
 *     that discards intervening history (§6.9).
 *   - Every value interpolated into a command (sha, path) is shell-escaped via
 *     {@link shQuote}, and every revision is first validated by {@link assertSafeRev}
 *     so a `sha` like `--upload-pack=…` can't be smuggled in as a git option.
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { persistToR2 } from "../sandbox/persistence.ts";
import {
  type CommitCategory,
  parseCommitCategory,
  restoreFileCommitMsg,
  restoreTreeCommitMsg,
} from "./commit-messages.ts";
import { autoCommit, GIT, shQuote } from "./git.ts";
import { assertInsideBrain, BRAIN_ROOT, isNotePath } from "./layout.ts";

/** One commit as the history view sees it (sha/author/time/subject + category). */
export interface CommitEntry {
  /** Full 40-char commit sha. */
  sha: string;
  /** Commit author name (the stable `Mnemosyne Agent` identity, MNEMO-07). */
  author: string;
  /** Author timestamp, epoch ms (matches the graph index's `updated_at` unit). */
  ts: number;
  /** Commit subject line (the structured `<category>: …` message). */
  subject: string;
  /** Parsed category so the UI can label/filter without re-deriving intent. */
  category: CommitCategory;
}

/** A page of history: the entries plus an opaque cursor for the next page (or null). */
export interface HistoryPage {
  entries: CommitEntry[];
  /** Pass back as `opts.cursor` to fetch the next page; null when exhausted. */
  nextCursor: string | null;
}

/** Paging options for {@link listHistory} / {@link fileHistory}. */
export interface HistoryOpts {
  /** Page size, clamped to {@link HISTORY_CAPS}. */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor` (encodes a skip offset). */
  cursor?: string | null;
}

/** Per-file entry of a {@link commitDiff}: counts + the (possibly truncated) patch. */
export interface CommitFileDiff {
  /** Repo-relative path (the `b/`-side path for a rename). */
  path: string;
  /** Lines added (0 for a binary file). */
  additions: number;
  /** Lines deleted (0 for a binary file). */
  deletions: number;
  /** Unified patch for this file, truncated to {@link MAX_PATCH_BYTES}. */
  patch: string;
  /** True when `patch` was truncated past the size bound. */
  truncated?: boolean;
  /** True when git reported the file as binary (no textual diff). */
  binary?: boolean;
}

/** What a commit changed: the sha plus its per-file diffs. */
export interface CommitDiff {
  sha: string;
  files: CommitFileDiff[];
}

/** A single-file unified diff between two revisions (or a revision and the worktree). */
export interface FileDiff {
  /** Absolute brain path of the file. */
  path: string;
  fromSha: string;
  /** null means "compared against the working tree / HEAD". */
  toSha: string | null;
  /** Unified diff, truncated to {@link MAX_PATCH_BYTES}. */
  patch: string;
  truncated: boolean;
}

/** A file's content at a specific revision (for the side-by-side view). */
export interface FileAtRevision {
  path: string;
  sha: string;
  /** File content at `sha`, truncated to {@link MAX_FILE_AT_BYTES}. */
  content: string;
  truncated: boolean;
}

/** What a restore returns: the new commit sha (null if nothing changed) + path. */
export interface RestoreResult {
  /** Absolute brain path restored (omitted for a whole-tree restore). */
  path?: string;
  /** Sha of the NEW commit the restore landed as, or null if the tree was clean. */
  commit: string | null;
}

/**
 * The DO-side index-resync operations a restore composes (MNEMO-08). Injected so
 * the restore functions are unit-testable without a DO/container and so the DO
 * supplies `this`-bound methods rather than a self-RPC stub (which would deadlock
 * a single-threaded DO). A restore MUST re-sync the index or the DO graph and the
 * restored FS diverge - breaking search/brain-size (PRD §7.4).
 */
export interface RestoreHooks {
  /** Re-index ONE restored note from its on-disk content (single-file restore). */
  reindexNote(path: string): Promise<void>;
  /** Re-index every note (whole-tree restore can add/remove/relink many notes). */
  reindexAll(): Promise<unknown>;
}

/** Paging bounds - the same MAX_LIMIT discipline `graph-index.ts` uses. */
export const HISTORY_CAPS = {
  defaultLimit: 50,
  maxLimit: 200,
} as const;

/**
 * Per-file / per-diff patch byte cap. A giant blob's diff can't blow the response
 * - past this the patch is truncated and flagged. Generous for a hand-edited
 * note/tool; a binary asset's "diff" is just the numstat counts anyway.
 */
export const MAX_PATCH_BYTES = 256 * 1024;

/** Cap on a single `fileAtRevision` read - mirrors the explorer's `MAX_READ_BYTES`. */
export const MAX_FILE_AT_BYTES = 4 * 1024 * 1024;

// Field separator git emits for the literal `%x1f` specifier (ASCII Unit
// Separator); records are NUL-separated under `-z`. These are the bytes we PARSE;
// the format string below passes the literal `%x1f` text for git to interpret.
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\0";

/** The `--pretty` format: sha, author, author-time, subject - `%x1f`-delimited. */
const LOG_FORMAT = "--pretty=format:%H%x1f%an%x1f%at%x1f%s";

/**
 * Thrown when a revision argument isn't a safe git revision. `shQuote` stops shell
 * injection, but a value like `--upload-pack=…` would still be read by git as an
 * OPTION, not a sha - so revisions are whitelisted to a sha (hex) or a HEAD-relative
 * ref, both of which can never start with `-`.
 */
export class BadRevisionError extends Error {
  constructor(rev: string) {
    super(`unsafe git revision: ${rev}`);
    this.name = "BadRevisionError";
  }
}

// A full/abbrev hex sha, or HEAD, each optionally with `~n` / `^` ancestry suffixes.
const SAFE_REV = /^(HEAD|[0-9a-fA-F]{4,40})(?:[~^]\d*)*$/;

/** Validate a revision before it reaches git; throws {@link BadRevisionError}. */
export function assertSafeRev(rev: string): string {
  if (typeof rev !== "string" || !SAFE_REV.test(rev)) {
    throw new BadRevisionError(String(rev));
  }
  return rev;
}

/** Clamp `n` into `[lo, hi]` (enforces the {@link HISTORY_CAPS} rails). */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Short (7-char) sha for a commit message; non-hex revs (e.g. `HEAD`) pass through. */
function shortSha(rev: string): string {
  return /^[0-9a-fA-F]{8,40}$/.test(rev) ? rev.slice(0, 7) : rev;
}

/** Repo-relative path for a brain path - `git -C /brain` resolves pathspecs here. */
function relBrain(absPath: string): string {
  if (absPath === BRAIN_ROOT) return ".";
  return absPath.startsWith(`${BRAIN_ROOT}/`)
    ? absPath.slice(BRAIN_ROOT.length + 1)
    : absPath;
}

/** A cursor decodes to a skip offset; a missing/garbage cursor means "start". */
function cursorToSkip(cursor?: string | null): number {
  const n = cursor != null ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse `-z`/`%x1f` `git log` output into {@link CommitEntry}s. Commits are
 * NUL-separated; each commit's four fields are `\x1f`-separated, with the subject
 * last (so a subject is reassembled even in the impossible case it held a `\x1f`).
 */
function parseLog(stdout: string): CommitEntry[] {
  const entries: CommitEntry[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    if (record === "") continue;
    const [sha, author, at, ...rest] = record.split(FIELD_SEP);
    if (!sha) continue;
    entries.push({
      sha: sha.trim(),
      author: author ?? "",
      // `%at` is author date as Unix seconds → epoch ms.
      ts: (Number.parseInt(at ?? "", 10) || 0) * 1000,
      subject: rest.join(FIELD_SEP),
      category: parseCommitCategory(rest.join(FIELD_SEP)),
    });
  }
  return entries;
}

/**
 * Commit history, newest first, paged. Fetches `limit + 1` to detect whether a
 * further page exists, returning a `nextCursor` only when it does. `-z` + `%x1f`
 * delimiters keep subjects with spaces/quotes intact; the category is derived per
 * MNEMO-07's `parseCommitCategory`.
 */
export async function listHistory(
  env: Env,
  agentId: string,
  opts: HistoryOpts = {},
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<HistoryPage> {
  const limit = clamp(
    opts.limit ?? HISTORY_CAPS.defaultLimit,
    1,
    HISTORY_CAPS.maxLimit,
  );
  const skip = cursorToSkip(opts.cursor);
  // limit/skip are validated integers we control - safe to interpolate.
  const out = await sandbox.run(
    `${GIT} log -z ${LOG_FORMAT} --max-count=${limit + 1} --skip=${skip}`,
  );
  const all = parseLog(out.stdout);
  const hasMore = all.length > limit;
  return {
    entries: all.slice(0, limit),
    nextCursor: hasMore ? String(skip + limit) : null,
  };
}

/**
 * History of ONE file, following renames (`--follow`), newest first. The path is
 * contained by {@link assertInsideBrain} before any git touch; the same `-z`
 * parsing as {@link listHistory} keeps filenames with spaces intact.
 */
export async function fileHistory(
  env: Env,
  agentId: string,
  path: string,
  opts: HistoryOpts = {},
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<HistoryPage> {
  const rel = relBrain(assertInsideBrain(path));
  const limit = clamp(
    opts.limit ?? HISTORY_CAPS.defaultLimit,
    1,
    HISTORY_CAPS.maxLimit,
  );
  const skip = cursorToSkip(opts.cursor);
  const out = await sandbox.run(
    `${GIT} log --follow -z ${LOG_FORMAT} ` +
      `--max-count=${limit + 1} --skip=${skip} -- ${shQuote(rel)}`,
  );
  const all = parseLog(out.stdout);
  const hasMore = all.length > limit;
  return {
    entries: all.slice(0, limit),
    nextCursor: hasMore ? String(skip + limit) : null,
  };
}

/**
 * Parse `--numstat -z` into per-file `{ path, additions, deletions, binary }`.
 * Normal entries are `adds\tdels\tpath` (NUL-terminated); a rename emits
 * `adds\tdels\t` with the old+new paths as the next two NUL-separated chunks. A
 * binary file shows `-` for both counts.
 */
function parseNumstatZ(stdout: string): Array<{
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}> {
  const chunks = stdout.split(RECORD_SEP);
  const out: Array<{
    path: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === "") continue;
    const parts = chunk.split("\t");
    if (parts.length < 3) continue; // not a numstat record
    const binary = parts[0] === "-" || parts[1] === "-";
    const additions = binary ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(parts[1], 10) || 0;
    // Rename: `adds\tdels\t` with an empty path field → the new path is two
    // chunks ahead (old, then new); consume both.
    let path = parts.slice(2).join("\t");
    if (path === "") {
      i += 2; // skip the old path; use the new one
      path = chunks[i] ?? "";
    }
    if (path !== "") out.push({ path, additions, deletions, binary });
  }
  return out;
}

/**
 * Split a `git show` patch into a `path → patch` map, keyed on the `b/`-side path
 * of each `diff --git` header (the post-change path). Best-effort: numstat is the
 * authoritative file list + counts, so a file with no matched hunk just gets "".
 */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const seg of patch.split(/\n(?=diff --git )/)) {
    if (!seg.startsWith("diff --git ")) continue;
    const header = seg.match(/^diff --git a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (header) map.set(header[2], seg);
  }
  return map;
}

/** Truncate `s` to `cap` bytes (chars), reporting whether it was cut. */
function truncate(
  s: string,
  cap: number,
): { text: string; truncated: boolean } {
  return s.length > cap
    ? { text: s.slice(0, cap), truncated: true }
    : { text: s, truncated: false };
}

/**
 * Diff of one commit: per-file add/delete counts (`--numstat -z`) joined with the
 * per-file unified patch (`git show … -p`). Each file's patch is truncated to
 * {@link MAX_PATCH_BYTES} so a single giant blob can't blow the response. The sha
 * is validated + shell-escaped.
 */
export async function commitDiff(
  env: Env,
  agentId: string,
  sha: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<CommitDiff> {
  assertSafeRev(sha);
  const q = shQuote(sha);

  // `--format=` suppresses the commit header so the output is just the numstat /
  // patch; the leading empty record is dropped by the parsers.
  const statsOut = await sandbox.run(`${GIT} show ${q} --numstat -z --format=`);
  const patchOut = await sandbox.run(`${GIT} show ${q} --format= -p`);

  const patchByPath = splitPatchByFile(patchOut.stdout);
  const files: CommitFileDiff[] = parseNumstatZ(statsOut.stdout).map((s) => {
    const { text, truncated } = truncate(
      patchByPath.get(s.path) ?? "",
      MAX_PATCH_BYTES,
    );
    return {
      path: s.path,
      additions: s.additions,
      deletions: s.deletions,
      patch: text,
      ...(truncated ? { truncated: true } : {}),
      ...(s.binary ? { binary: true } : {}),
    };
  });
  return { sha, files };
}

/**
 * Unified diff of ONE file between two revisions, or between a revision and the
 * working tree when `toSha` is omitted. Path is contained; both revisions are
 * validated + escaped; the patch is truncated to {@link MAX_PATCH_BYTES}.
 */
export async function fileDiff(
  env: Env,
  agentId: string,
  path: string,
  fromSha: string,
  toSha?: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<FileDiff> {
  const abs = assertInsideBrain(path);
  const rel = relBrain(abs);
  assertSafeRev(fromSha);
  if (toSha !== undefined) assertSafeRev(toSha);

  // `'a'..'b'` concatenates to one `a..b` word; the single-arg range plus the
  // `--` pathspec separator means neither rev nor path is read as an option.
  const range =
    toSha !== undefined
      ? `${shQuote(fromSha)}..${shQuote(toSha)}`
      : shQuote(fromSha);
  const out = await sandbox.run(`${GIT} diff ${range} -- ${shQuote(rel)}`);
  const { text, truncated } = truncate(out.stdout, MAX_PATCH_BYTES);
  return { path: abs, fromSha, toSha: toSha ?? null, patch: text, truncated };
}

/**
 * A file's content at a specific revision (`git show <sha>:<path>`), for the
 * side-by-side view. `git show` wants a REPO-RELATIVE path after the colon, so we
 * pass `relBrain`; the whole `sha:path` is one shell-quoted word. A non-zero exit
 * (the file didn't exist at that revision) is surfaced as a clear error, not an
 * empty string. Content is truncated to {@link MAX_FILE_AT_BYTES}.
 */
export async function fileAtRevision(
  env: Env,
  agentId: string,
  path: string,
  sha: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<FileAtRevision> {
  const abs = assertInsideBrain(path);
  const rel = relBrain(abs);
  assertSafeRev(sha);

  const out = await sandbox.run(`${GIT} show ${shQuote(`${sha}:${rel}`)}`);
  if (out.exitCode !== 0) {
    throw new Error(`no such file at revision ${shortSha(sha)}: ${rel}`);
  }
  const { text, truncated } = truncate(out.stdout, MAX_FILE_AT_BYTES);
  return { path: abs, sha, content: text, truncated };
}

/**
 * Restore ONE file to a prior revision. `git checkout <sha> -- <path>` brings the
 * file back into the working tree (+ index); the change then funnels through the
 * MNEMO-07 {@link autoCommit} chokepoint so it lands as a **new** commit
 * (`restore: <path> to <short-sha>`) - never a hard reset, so it's reversible and
 * shows up in history (§6.9). A restored NOTE is re-indexed BEFORE the commit so
 * the DO graph and the committed tree agree (the write-pipeline ordering); a
 * non-note (tool/report) isn't a neuron, so there's nothing to reindex.
 */
export async function restoreFile(
  env: Env,
  agentId: string,
  path: string,
  sha: string,
  hooks: RestoreHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<RestoreResult> {
  const abs = assertInsideBrain(path);
  const rel = relBrain(abs);
  assertSafeRev(sha);

  await sandbox.run(`${GIT} checkout ${shQuote(sha)} -- ${shQuote(rel)}`);
  if (isNotePath(abs)) await hooks.reindexNote(abs);
  const commit = await autoCommit(
    env,
    agentId,
    restoreFileCommitMsg(rel, shortSha(sha)),
    undefined,
    sandbox,
  );
  return { path: abs, commit };
}

/**
 * Restore the WHOLE brain to a prior revision. Before the (destructive) restore we
 * take a recovery R2 snapshot (MNEMO-06 `snapshotKey(agentId, "pre-restore")`) as
 * the coarse backstop §6.9 calls for. `git read-tree --reset -u <sha>` makes the
 * working tree + index match `<sha>` exactly - including files added since, which
 * are removed - WITHOUT moving HEAD, so the restore lands as a **new** commit on
 * top (history preserved, restore reversible) rather than a destructive reset.
 * The entire index is then re-synced (a tree restore can add/remove/relink many
 * notes) before the single `restore: brain to <short-sha>` commit.
 */
export async function restoreTree(
  env: Env,
  agentId: string,
  sha: string,
  hooks: RestoreHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<RestoreResult> {
  assertSafeRev(sha);

  // Coarse backstop FIRST - before anything destructive touches the tree (§6.9).
  await persistToR2(env, agentId, sandbox, "pre-restore");

  await sandbox.run(`${GIT} read-tree --reset -u ${shQuote(sha)}`);

  // Required: a tree restore changes the note set wholesale, so the DO index must
  // be rebuilt or it diverges from the FS - breaking search/brain-size (§7.4).
  await hooks.reindexAll();

  const commit = await autoCommit(
    env,
    agentId,
    restoreTreeCommitMsg(shortSha(sha)),
    undefined,
    sandbox,
  );
  return { commit };
}
