/**
 * Git-in-sandbox helper - the brain's revision control (PRD §6.9).
 *
 * The brain is a git repo INSIDE the sandbox: auto-committed on every memory
 * write and on each consolidation pass, giving per-file diffs + one-click
 * restore (MNEMO-12) and the "versioned + diffed before commit" safety net
 * consolidation requires (MNEMO-10). Git-in-sandbox is the fine-grained layer;
 * R2 object versioning (src/sandbox/persistence.ts) is the coarser backstop.
 *
 * EVERY git/FS operation goes through the MNEMO-06 client wrapper
 * ({@link SandboxClient}) - never the raw SDK. The `sandbox` parameter is
 * injectable (defaulting to the live handle) so the issued git sequence is
 * testable without a real container, mirroring the lifecycle module.
 *
 * Safety: git runs against an explicit `-C /brain` (no reliance on cwd), and
 * every value interpolated into a command (commit messages, identity) is
 * single-quoted via {@link shQuote} so note content/paths can never break out
 * of the command.
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { BRAIN_DIRS, BRAIN_ROOT } from "./layout.ts";

/** Stable, non-personal identity every brain commit is attributed to (§6.9). */
export const GIT_AUTHOR_NAME = "Mnemosyne Agent";
export const GIT_AUTHOR_EMAIL = "agent@mnemosyne.local";

/**
 * All git invocations target the brain repo explicitly - no cwd dependence.
 * Exported so the versioning module (MNEMO-12) issues its history/diff/restore
 * reads through the SAME `git -C /brain` prefix - one source of truth, no drift.
 */
export const GIT = `git -C ${BRAIN_ROOT}`;

/** Path to the repo's `.git`, probed for idempotent init. */
const GIT_DIR = `${BRAIN_ROOT}/.git`;

/**
 * POSIX single-quote escaping: wrap in `'…'` and rewrite each embedded `'` as
 * `'\''` (close-quote, escaped-quote, reopen-quote). This makes ANY string -
 * spaces, quotes, `$`, backticks, newlines - a single safe shell word, so
 * model-authored note slugs and commit summaries cannot inject shell.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Provision the brain layout + git repo. Idempotent: if `/brain/.git` already
 * exists (e.g. restored from R2, which carries the whole tree including `.git`),
 * this no-ops and returns `false`. On a fresh brain it creates {@link BRAIN_DIRS},
 * writes a README + `.gitignore`, `git init`s, pins the agent identity, and makes
 * the initial commit - returning `true`.
 */
export async function initBrainRepo(
  env: Env,
  agentId: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<boolean> {
  // Idempotency probe: a restored brain already has `.git`, so don't re-init.
  const probe = await sandbox.run(
    `test -d ${GIT_DIR} && echo exists || echo none`,
  );
  if (probe.stdout.trim() === "exists") return false;

  // Lay down the canonical directory tree (recursive → also creates /brain).
  for (const dir of BRAIN_DIRS) {
    await sandbox.mkdir(dir);
  }

  // Seed a human-readable README + a .gitignore for transient/cache files so
  // the very first commit is meaningful and scratch files never get versioned.
  await sandbox.writeFile(
    `${BRAIN_ROOT}/README.md`,
    "# Brain\n\nThis directory is a git-versioned Mnemosyne agent brain (PRD §6.9).\n\n" +
      "- `notes/` - neurons (`.md` notes linked via `[[wikilinks]]`)\n" +
      "- `tools/` - self-authored, reusable tools\n" +
      "- `reports/` - archived computed reports\n",
  );
  await sandbox.writeFile(
    `${BRAIN_ROOT}/.gitignore`,
    // Transient archive/scratch files used by the R2 persistence envelope and
    // common cache/temp noise - never part of the versioned brain.
    "*.tmp\n*.tgz\n*.tar\n*.b64\n.cache/\n__pycache__/\n.mnemosyne-warm\n",
  );

  await sandbox.run(`${GIT} init`);
  await sandbox.run(`${GIT} config user.name ${shQuote(GIT_AUTHOR_NAME)}`);
  await sandbox.run(`${GIT} config user.email ${shQuote(GIT_AUTHOR_EMAIL)}`);

  // A fresh `git init` has no commits; the layout we just wrote is real content,
  // so this initial commit is never empty.
  await sandbox.run(`${GIT} add -A`);
  await sandbox.run(`${GIT} commit -m ${shQuote("init: brain layout")}`);
  return true;
}

/** Options for {@link autoCommit}. */
export interface AutoCommitOptions {
  /** Permit a commit with no staged changes. Defaults to `false` (skip → null). */
  allowEmpty?: boolean;
}

/**
 * The single auto-commit chokepoint (PRD §6.2/§6.9): stage everything and commit
 * with the given (structured) message, returning the new commit sha - or `null`
 * if the tree was clean and nothing was committed. Every memory-write path and
 * the consolidation pass funnels through here so history is complete and diffs
 * are meaningful.
 */
export async function autoCommit(
  env: Env,
  agentId: string,
  message: string,
  opts?: AutoCommitOptions,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<string | null> {
  await sandbox.run(`${GIT} add -A`);

  // Nothing staged + not forcing empty → no commit, signal "no change" as null.
  if (!opts?.allowEmpty && (await isCleanTree(env, agentId, sandbox))) {
    return null;
  }

  // Assemble from parts so an absent `--allow-empty` leaves no stray gap, and -
  // critically - so no post-processing ever touches whitespace INSIDE the
  // single-quoted message (a commit message may legitimately contain runs of
  // spaces or newlines).
  const parts = [GIT, "commit"];
  if (opts?.allowEmpty) parts.push("--allow-empty");
  parts.push("-m", shQuote(message));
  const commit = await sandbox.run(parts.join(" "));
  if (commit.exitCode !== 0) return null;

  const head = await sandbox.run(`${GIT} rev-parse HEAD`);
  const sha = head.stdout.trim();
  return sha === "" ? null : sha;
}

/**
 * Whether the brain working tree is clean (no staged or unstaged changes), via
 * `git status --porcelain` - empty output means clean. Used by {@link autoCommit}
 * to avoid empty commits and by callers that want to gate work on a dirty tree.
 */
export async function isCleanTree(
  env: Env,
  agentId: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<boolean> {
  const status = await sandbox.run(`${GIT} status --porcelain`);
  return status.stdout.trim() === "";
}
