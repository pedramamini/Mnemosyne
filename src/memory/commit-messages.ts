/**
 * Structured commit-message builders for the brain git repo (PRD §6.9).
 *
 * Every auto-commit message carries a parseable `<category>: …` prefix so the
 * brain-explorer history view (MNEMO-12) can categorize and filter revisions
 * without re-deriving intent from a free-form string. `initBrainRepo`
 * (src/memory/git.ts) writes the `init:` prefix; the builders here cover the
 * three runtime write paths; `parseCommitCategory` is the inverse used by the
 * history view. Pure string functions - unit-testable without a sandbox.
 */

/** The commit categories MNEMO-12 history can filter on. */
export type CommitCategory =
  | "memory"
  | "consolidate"
  | "tool"
  | "explorer"
  | "init"
  | "restore"
  | "other";

/** Commit message for a single memory/note write (MNEMO-10). */
export function writeCommitMsg(noteSlug: string): string {
  return `memory: write ${noteSlug}`;
}

/** Commit message for deleting a note (MNEMO-10) - same `memory:` category. */
export function deleteCommitMsg(noteSlug: string): string {
  return `memory: delete ${noteSlug}`;
}

/** Commit message for a consolidation ("sleep") pass (PRD §6.2). */
export function consolidateCommitMsg(summary: string): string {
  return `consolidate: ${summary}`;
}

/** Commit message for authoring/updating a self-authored tool (PRD §6.2). */
export function toolCommitMsg(name: string): string {
  return `tool: author ${name}`;
}

/**
 * Commit message for a NON-note write from the brain explorer (MNEMO-11, §6.9) -
 * a tool/report/binary edited or created directly from the web UI. Note edits go
 * through the MNEMO-10 pipeline and keep the `memory:` prefix, so they read as
 * first-class memory writes in history; only non-note explorer edits carry this.
 */
export function explorerEditMsg(path: string): string {
  return `explorer: edit ${path}`;
}

/** Commit message for deleting a NON-note path from the brain explorer (MNEMO-11). */
export function explorerDeleteMsg(path: string): string {
  return `explorer: delete ${path}`;
}

/**
 * Commit message for restoring ONE file to a prior revision (MNEMO-12, §6.9).
 * A restore is a NEW commit (never a hard reset), so it shows up in history and
 * is itself reversible; the `restore:` prefix lets the history view label it.
 */
export function restoreFileCommitMsg(path: string, shortSha: string): string {
  return `restore: ${path} to ${shortSha}`;
}

/** Commit message for restoring the WHOLE brain tree to a prior revision (MNEMO-12). */
export function restoreTreeCommitMsg(shortSha: string): string {
  return `restore: brain to ${shortSha}`;
}

/**
 * Extract the category from a commit message's `<prefix>:` head, mapping any
 * unknown prefix (or a message with no prefix) to `"other"`. Round-trips each
 * builder above plus the `init:` prefix `initBrainRepo` writes.
 */
export function parseCommitCategory(message: string): CommitCategory {
  const prefix = message.split(":", 1)[0]?.trim();
  switch (prefix) {
    case "memory":
    case "consolidate":
    case "tool":
    case "explorer":
    case "init":
    case "restore":
      return prefix;
    default:
      return "other";
  }
}
