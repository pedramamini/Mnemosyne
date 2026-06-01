/**
 * Consolidation - the apply half (PRD §6.2 / §6.9, MNEMO-10).
 *
 * Enforces the PRD's "versioned + diffed before commit" requirement: a bad merge
 * must be recoverable, never a silent corruption of the brain. `applyConsolidation`:
 *
 *   1. Asserts a clean git tree (MNEMO-07 `isCleanTree`). If the tree is dirty,
 *      it commits the pending work FIRST so the consolidation commit isolates
 *      exactly the consolidation change (clean diff, clean restore point).
 *   2. Computes the unified diff (before→after) for every op and records it.
 *   3. Applies each op through the write pipeline (src/memory/write.ts) so every
 *      change is reindexed - but with a no-op commit hook, so the per-op commits
 *      are deferred into one pass-wide commit.
 *   4. Makes ONE `autoCommit(consolidateCommitMsg(...))` capturing the whole pass.
 *
 * The ONE commit + the recorded diffs are the safety net the PRD demands: if a
 * pass goes wrong, the pre-pass commit is an intact restore point and the pass
 * commit can be reverted one-click (MNEMO-12 restore). If any op throws, the
 * pass aborts BEFORE the commit and best-effort discards the half-applied tree
 * (`git checkout`) so the brain is never left in a half-merged, committed state.
 */
import type { Env } from "../env.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { consolidateCommitMsg } from "./commit-messages.ts";
import type { ConsolidationOp, ConsolidationPlan } from "./consolidation.ts";
import { autoCommit, isCleanTree } from "./git.ts";
import { BRAIN_ROOT } from "./layout.ts";
import { type BrainWriteHooks, deleteNote, writeNote } from "./write.ts";

/** One rendered diff: the file it concerns and its unified-diff text. */
export interface ConsolidationDiff {
  /** Op kind that produced this diff (for grouping in the UI/audit). */
  type: ConsolidationOp["type"];
  /** Filename-stem slug of the note this diff describes. */
  slug: string;
  /** Unified-diff text (before→after), renderable as-is. */
  diff: string;
}

/** Result of an applied pass: the single commit sha (or null) + every diff. */
export interface ConsolidationResult {
  commit: string | null;
  diffs: ConsolidationDiff[];
}

/**
 * Apply a consolidation plan as one versioned, diffed pass. See the module
 * comment for the four-step contract. Returns the pass commit (null if the plan
 * was empty / no-op) and the diffs that were committed.
 */
export async function applyConsolidation(
  env: Env,
  agentId: string,
  plan: ConsolidationPlan,
  hooks: BrainWriteHooks,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<ConsolidationResult> {
  const diffs = diffPlan(plan);

  // Nothing to do - don't touch the tree or make an empty commit (idempotent).
  if (plan.ops.length === 0) return { commit: null, diffs };

  // Step 1: isolate the pass. A dirty tree gets committed first so the
  // consolidation commit captures ONLY the consolidation change.
  if (!(await isCleanTree(env, agentId, sandbox))) {
    await autoCommit(
      env,
      agentId,
      "consolidate: checkpoint pending work before pass",
      undefined,
      sandbox,
    );
  }

  // Step 3: apply through the write pipeline, deferring per-op commits (the
  // commit hook is a no-op) so the whole pass lands in ONE commit at step 4.
  const deferredCommit: BrainWriteHooks = {
    reindexNote: hooks.reindexNote,
    removeNeuron: hooks.removeNeuron,
    commitBrain: async () => null,
  };

  try {
    for (const op of plan.ops) {
      // Rewrite the target only when the content actually changes (an exact-dup
      // merge leaves the survivor untouched - its sole effect is the removal).
      if (op.after !== op.before) {
        await writeNote(
          env,
          agentId,
          { slug: op.target, content: op.after },
          deferredCommit,
          sandbox,
        );
      }
      if (op.removeSlug) {
        await deleteNote(env, agentId, op.removeSlug, deferredCommit, sandbox);
      }
    }
  } catch (err) {
    // Abort before the commit: discard the half-applied (uncommitted) tree so
    // the brain returns to the pre-pass committed state. Best-effort - the
    // uncommitted state is itself recoverable via the pre-pass commit (MNEMO-12).
    await sandbox
      .run(`git -C ${BRAIN_ROOT} checkout -- .`)
      .catch(() => undefined);
    throw err;
  }

  // Step 4: ONE commit for the entire pass - the diffed, versioned safety net.
  const summary = `${plan.ops.length} op(s): ${summarize(plan)}`;
  const commit = await autoCommit(
    env,
    agentId,
    consolidateCommitMsg(summary),
    undefined,
    sandbox,
  );
  return { commit, diffs };
}

/**
 * Render every op in a plan to its diff(s) - pure, so the DO's `dryRun` preview
 * and the real apply share one diff source. A `merge` yields two diffs: the
 * survivor rewrite and the removed duplicate (shown as a full deletion).
 */
export function diffPlan(plan: ConsolidationPlan): ConsolidationDiff[] {
  const diffs: ConsolidationDiff[] = [];
  for (const op of plan.ops) {
    if (op.after !== op.before) {
      diffs.push({
        type: op.type,
        slug: op.target,
        diff: unifiedDiff(op.target, op.before, op.after),
      });
    }
    if (op.removeSlug != null) {
      diffs.push({
        type: op.type,
        slug: op.removeSlug,
        diff: unifiedDiff(op.removeSlug, op.removeBefore ?? "", ""),
      });
    }
  }
  return diffs;
}

/** One-line plan summary for the commit message (op-type counts). */
function summarize(plan: ConsolidationPlan): string {
  const counts = new Map<string, number>();
  for (const op of plan.ops)
    counts.set(op.type, (counts.get(op.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${n} ${t}`).join(", ");
}

/**
 * Minimal line-based unified diff (before→after) with standard `---`/`+++`
 * headers. Uses an LCS over lines so unchanged context is shared and only real
 * insertions/deletions are marked - enough to render a readable diff without a
 * diff dependency. Not byte-exact GNU format, but a faithful before/after view.
 */
export function unifiedDiff(
  label: string,
  before: string,
  after: string,
): string {
  const a = before === "" ? [] : before.split(/\r?\n/);
  const b = after === "" ? [] : after.split(/\r?\n/);
  const lcs = lcsMatrix(a, b);

  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  for (; i < a.length; i++) out.push(`-${a[i]}`);
  for (; j < b.length; j++) out.push(`+${b[j]}`);
  return out.join("\n");
}

/** Longest-common-subsequence length matrix over two line arrays. */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}
