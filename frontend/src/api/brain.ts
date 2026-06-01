/**
 * Brain explorer API (MNEMO-38) - a typed client over the MNEMO-32 `apiFetch`
 * transport for the MNEMO-11 brain-explorer routes. Pure functions, no React;
 * the session cookie rides along via `credentials: "include"` (see `client.ts`).
 *
 * shapes mirror MNEMO-11 (src/memory/explorer.ts + the routes in src/index.ts):
 *
 *   listBrainFiles(agentId)            → GET    /agents/:id/brain/files            → BrainEntry[]
 *   readBrainFile(agentId, path)       → GET    /agents/:id/brain/file?path=…      → BrainFileContent
 *   writeBrainFile(agentId, path, …)   → PUT    /agents/:id/brain/file             → BrainWriteResult
 *   deleteBrainFile(agentId, path)     → DELETE /agents/:id/brain/file?path=…      → (BrainWriteResult, discarded)
 *   brainArchiveUrl(agentId)           → GET    /agents/:id/brain/archive?format=  (browser-driven download)
 *
 * NB: the backend `PUT` (used for BOTH create and edit) and `DELETE` return a
 * `BrainWriteResult` (`{ path, commit }`), NOT a `BrainEntry` - the response
 * shapes here are the exact MNEMO-11 ones rather than the placeholder return
 * types sketched in the MNEMO-38 spec. Paths come back ABSOLUTE under `/brain`,
 * but the route's `BrainPath` guard also accepts the brain-relative form, which
 * is what the tree emits back to these calls.
 */
import { apiUrl, del, get, post, put } from "./client";

/** A directory-tree entry - absolute path under `/brain`, type, size + mtime. */
export interface BrainEntry {
  /** Absolute path under `/brain` (e.g. `/brain/notes/idea.md`). */
  path: string;
  type: "file" | "dir";
  /** Size in bytes (0 for directories). */
  size: number;
  /** Last-modified time, epoch ms. */
  modified: number;
}

/** A read file - UTF-8 text inline, or base64 of the raw bytes for binaries. */
export interface BrainFileContent {
  path: string;
  /** UTF-8 text, or base64 of the raw bytes when `encoding` is `"base64"`. */
  content: string;
  encoding: "utf8" | "base64";
  /** Size in bytes of the on-disk file. */
  size: number;
}

/** What a write/create/delete returns: the absolute path + commit sha (or null). */
export interface BrainWriteResult {
  path: string;
  commit: string | null;
}

/** Per-agent base path for every brain route. */
function brainBase(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/brain`;
}

/** List the agent's whole brain tree (flat list of entries with absolute paths). */
export function listBrainFiles(agentId: string): Promise<BrainEntry[]> {
  return get<BrainEntry[]>(`${brainBase(agentId)}/files`);
}

/** Read one brain file (size-capped; binary content arrives base64-encoded). */
export function readBrainFile(
  agentId: string,
  path: string,
): Promise<BrainFileContent> {
  return get<BrainFileContent>(
    `${brainBase(agentId)}/file?path=${encodeURIComponent(path)}`,
  );
}

/** Write or create a brain file (the PUT route handles both). */
export function writeBrainFile(
  agentId: string,
  path: string,
  content: string,
): Promise<BrainWriteResult> {
  return put<BrainWriteResult>(`${brainBase(agentId)}/file`, { path, content });
}

/** Delete a brain path. Resolves on success; the commit result is discarded. */
export async function deleteBrainFile(
  agentId: string,
  path: string,
): Promise<void> {
  await del<BrainWriteResult>(
    `${brainBase(agentId)}/file?path=${encodeURIComponent(path)}`,
  );
}

/**
 * Absolute URL of the whole-brain archive download (PRD §6.9). The browser
 * follows it directly with the auth cookie and streams the attachment - no
 * `fetch`, so the bytes never pass through the SPA. Requests the `.zip` format.
 */
export function brainArchiveUrl(agentId: string): string {
  return apiUrl(`${brainBase(agentId)}/archive?format=zip`);
}

// ─── Brain versioning (MNEMO-12, PRD §6.9) ──────────────────────────────────
//
// shapes mirror MNEMO-12 (src/memory/versioning.ts + src/memory/commit-messages.ts).
//
// NB: the live MNEMO-12 routes/shapes differ from the placeholder sketch in the
// MNEMO-39 spec - same precedent as the MNEMO-11 note at the top of this file
// (mirror the real backend, not the spec stub). Concretely:
//   - history is `GET …/brain/history` (whole brain) and `…/brain/history/file?path=`
//     (one file, follows renames) - NOT a `…/commits` route;
//   - a commit carries `subject`/`ts`/`category` (a parsed category enum), NOT
//     `message`/`timestamp`/a `consolidate:` string prefix - consolidation passes
//     are `category === "consolidate"`;
//   - a commit's diff is `GET …/brain/diff?sha=` returning per-file numstat plus a
//     unified `patch` string - there is no per-file `status` enum, so the diff
//     renderer derives add/modify/delete/rename from the patch headers instead.

/**
 * The commit categories MNEMO-12 parses from the structured commit subject
 * (`<category>: …`). `consolidate` marks a "sleep"/consolidation pass.
 * Mirrors `CommitCategory` in src/memory/commit-messages.ts.
 */
export type CommitCategory =
  | "memory"
  | "consolidate"
  | "tool"
  | "explorer"
  | "init"
  | "restore"
  | "other";

/** One commit in the brain's git history. Mirrors MNEMO-12 `CommitEntry`. */
export interface Commit {
  /** Full 40-char commit sha. */
  sha: string;
  /** Commit author name (the stable agent identity, MNEMO-07). */
  author: string;
  /** Author timestamp, epoch ms. */
  ts: number;
  /** Commit subject line (the structured `<category>: …` message). */
  subject: string;
  /** Parsed category, so the UI labels/filters without re-deriving intent. */
  category: CommitCategory;
}

/** A page of commit history. Mirrors MNEMO-12 `HistoryPage`. */
export interface CommitHistoryPage {
  entries: Commit[];
  /** Pass back as `opts.cursor` for the next page; `null` when exhausted. */
  nextCursor: string | null;
}

/**
 * One file's diff within a commit: numstat counts + the (possibly truncated)
 * unified patch. Mirrors MNEMO-12 `CommitFileDiff`. The status badge is derived
 * from the `patch` headers by the renderer, not carried as a field.
 */
export interface FileDiff {
  /** Repo-relative path (the `b/`-side path for a rename). */
  path: string;
  /** Lines added (0 for a binary file). */
  additions: number;
  /** Lines deleted (0 for a binary file). */
  deletions: number;
  /** Unified patch for this file (full git headers + hunks), possibly truncated. */
  patch: string;
  /** True when `patch` was truncated past the backend size bound. */
  truncated?: boolean;
  /** True when git reported the file as binary (no textual diff). */
  binary?: boolean;
}

/** What a commit changed: the sha plus its per-file diffs. Mirrors MNEMO-12 `CommitDiff`. */
export interface CommitDiff {
  sha: string;
  files: FileDiff[];
}

/** A file's content at a specific revision. Mirrors MNEMO-12 `FileAtRevision`. */
export interface FileAtRevision {
  path: string;
  sha: string;
  /** File content at `sha`, possibly truncated to the backend byte bound. */
  content: string;
  truncated: boolean;
}

/** What a restore returns: the NEW commit's sha (null if nothing changed) + path. Mirrors MNEMO-12 `RestoreResult`. */
export interface RestoreResult {
  /** Absolute brain path restored (omitted for a whole-tree restore). */
  path?: string;
  /** Sha of the NEW commit the restore landed as, or null if the tree was clean. */
  commit: string | null;
}

/** Paging / filter options for {@link listCommits}. */
export interface ListCommitsOpts {
  /** Scope history to a single file (uses the file-history route; follows renames). */
  path?: string;
  /** Page size; the backend clamps to its own max. */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string | null;
}

/** Normalize a path to the repo-relative form the backend diffs report. */
function relBrainPath(path: string): string {
  let p = path.replace(/^\/+/, "");
  if (p.startsWith("brain/")) p = p.slice("brain/".length);
  return p;
}

/**
 * Commit history, newest first. With `opts.path` it scopes to one file's history
 * (the `…/history/file` route, following renames); otherwise the whole brain.
 * Returns the page (entries + `nextCursor`) so callers can paginate via `loadMore`.
 */
export function listCommits(
  agentId: string,
  opts?: ListCommitsOpts,
): Promise<CommitHistoryPage> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.cursor) params.set("cursor", opts.cursor);
  if (opts?.path) {
    params.set("path", opts.path);
    return get<CommitHistoryPage>(
      `${brainBase(agentId)}/history/file?${params.toString()}`,
    );
  }
  const qs = params.toString();
  return get<CommitHistoryPage>(
    `${brainBase(agentId)}/history${qs ? `?${qs}` : ""}`,
  );
}

/**
 * Per-file diffs for one commit. With `path`, filters to just that file (the
 * backend returns every file the commit touched). Paths are normalized to the
 * repo-relative form the backend diffs use before comparing.
 */
export async function getCommitDiff(
  agentId: string,
  sha: string,
  path?: string,
): Promise<FileDiff[]> {
  const diff = await get<CommitDiff>(
    `${brainBase(agentId)}/diff?sha=${encodeURIComponent(sha)}`,
  );
  if (!path) return diff.files;
  const want = relBrainPath(path);
  return diff.files.filter((f) => relBrainPath(f.path) === want);
}

/** Read a file's content at a given revision (the `…/brain/file-at` route). */
export function getFileAtCommit(
  agentId: string,
  sha: string,
  path: string,
): Promise<FileAtRevision> {
  return get<FileAtRevision>(
    `${brainBase(agentId)}/file-at?path=${encodeURIComponent(
      path,
    )}&sha=${encodeURIComponent(sha)}`,
  );
}

/**
 * One-click restore of a file to a prior revision. The backend lands it as a NEW
 * commit (so the restore is itself reversible + visible in history) and returns
 * that commit's sha.
 */
export function restoreFile(
  agentId: string,
  path: string,
  sha: string,
): Promise<RestoreResult> {
  return post<RestoreResult>(`${brainBase(agentId)}/restore`, { path, sha });
}
