/**
 * Weekly self-assessment ("Karpathy loop") state schemas.
 *
 * Once an agent is operating, it periodically (weekly) steps back and reviews
 * itself against its mission, then *self-iterates*: this is "system prompt
 * learning" (Karpathy) applied to a research agent - instead of waiting on a
 * weight update, the agent writes down explicit, human-readable lessons about how
 * to do its job better and folds them back into its own operating context on the
 * next run. The model-authored output of one review is an {@link AssessmentInput}
 * (captured by the `record_assessment` terminator); the DO stamps it into an
 * {@link AssessmentRecord} and keeps a short rolling {@link AssessmentState}.
 *
 * The load-bearing field is `operatingNotes` - the full revised operating
 * playbook. The DO caches it (so every later turn's system prompt carries the
 * accumulated lessons) and mirrors it to a brain note for the human to read.
 *
 * Schemas + a default-state factory only; the prompt lives in {@link ./prompt.ts},
 * the terminator in {@link ./tools.ts}, the orchestration on the DO.
 */
import { z } from "zod";

/** Weekly cadence the loop runs on - Monday 14:00 UTC, an hour after the default
 * report cron so a self-review and a delta report don't pile onto one wake. */
export const ASSESSMENT_CADENCE_CRON = "0 14 * * 1";

/** Max assessments retained in the rolling history (newest kept). */
export const ASSESSMENT_HISTORY_CAP = 8;

/** How is the agent doing against its mission? The headline of one review. */
export const AssessmentGrade = z.enum([
  "on_track",
  "needs_attention",
  "off_track",
]);
export type AssessmentGrade = z.infer<typeof AssessmentGrade>;

/**
 * Concrete self-iterations the review proposes. These are PROPOSALS surfaced to
 * the owner, not silently applied - the mission and cadence are the owner's to
 * own. (The one thing the loop DOES apply itself is `operatingNotes`, since that
 * is the agent's own working memory about how to do its job.)
 */
export const AssessmentAdjustments = z.object({
  /** A shift in research emphasis going forward (free text), if any. */
  focus: z.string().optional(),
  /** Sources to start leaning on / stop relying on, if any. */
  sources: z.array(z.string()).optional(),
  /** A proposed cadence change in plain language (NOT auto-applied), if any. */
  cadence: z.string().optional(),
  /** Anything else worth flagging to the owner. */
  note: z.string().optional(),
});
export type AssessmentAdjustments = z.infer<typeof AssessmentAdjustments>;

/**
 * The model-authored result of one self-review - the `record_assessment`
 * terminator's `inputSchema`, so the only way to finish a review is to emit a
 * well-formed assessment (same terminator-as-schema gate as Discovery / reports).
 */
export const AssessmentInput = z.object({
  /** Overall grade against the mission. */
  grade: AssessmentGrade,
  /** A few sentences: how the agent is doing against what it was set up to watch. */
  summary: z.string().min(1),
  /** What's working - concrete strengths to keep. */
  wins: z.array(z.string()),
  /** What's missing or weak - concrete gaps to close. */
  gaps: z.array(z.string()),
  /** The durable lessons to internalize (the system-prompt-learning deltas). */
  lessons: z.array(z.string()),
  /** Concrete self-iterations proposed (surfaced to the owner). */
  adjustments: AssessmentAdjustments,
  /**
   * The FULL revised operating playbook - the agent's own standing notes on how
   * to do this job well. Replaces the prior playbook wholesale (the model is
   * given the current one and asked to rewrite it), so it stays coherent rather
   * than an ever-growing append log. Injected into every later turn's prompt.
   */
  operatingNotes: z.string(),
});
export type AssessmentInput = z.infer<typeof AssessmentInput>;

/** One stored review. `id`/`ranAt` are stamped by the DO on capture. */
export const AssessmentRecord = AssessmentInput.extend({
  id: z.string(),
  ranAt: z.string(),
});
export type AssessmentRecord = z.infer<typeof AssessmentRecord>;

/**
 * The persisted assessment state for one agent (stored under the `assessment`
 * meta key). `history` is a short rolling window (newest first), `lastRecord` a
 * convenience pointer to `history[0]`.
 */
export const AssessmentState = z.object({
  lastRunAt: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRecord: AssessmentRecord.nullable(),
  history: z.array(AssessmentRecord),
});
export type AssessmentState = z.infer<typeof AssessmentState>;

/** State for an agent that has never run a self-assessment. */
export function defaultAssessmentState(): AssessmentState {
  return { lastRunAt: null, runCount: 0, lastRecord: null, history: [] };
}
