/**
 * Weekly self-assessment prompt assembly (the "Karpathy loop").
 *
 * Two pieces, mirroring the deep-research path:
 *   - {@link ASSESSMENT_OVERLAY} - the per-turn system overlay (the counterpart of
 *     `DEEP_RESEARCH_OVERLAY`) that frames the run as a self-review and names the
 *     `record_assessment` terminator as the deliberate exit;
 *   - {@link buildAssessmentPrompt} - the per-run brief: the mission, the current
 *     operating playbook to revise, and the brain stats to ground the review.
 *
 * The framing is deliberately about *self-iteration*, not just grading: the
 * payoff is the rewritten operating playbook ("system prompt learning"), which the
 * DO folds into every subsequent run.
 *
 * Pure functions - no I/O - so they are unit-testable directly.
 */
import type { BrainSize } from "../../memory/graph-index.ts";
import type { DiscoverySpec } from "../discovery/types.ts";
import type { AssessmentRecord } from "./types.ts";

/**
 * The self-review overlay - appended as the headless run's `extras` (NOT the
 * deep-research overlay). It tells the model this is an inward-facing review of
 * its own work, what to weigh, and that it ends by calling `record_assessment`
 * exactly once with the structured result (whose schema includes the rewritten
 * operating playbook).
 */
export const ASSESSMENT_OVERLAY = `Weekly self-review
This is not an outward research run - it is your standing weekly review of your own work. No human is steering it. Step back and judge, honestly, how well you are serving the assignment you were set up for.

Ground the review in evidence, not vibes: recall and skim your own brain (its size, what's well-covered, what's thin or stale, where links dangle), and reconcile that against your mission. Where a quick check of the live web would tell you whether you've missed something material, do it - but keep this lightweight; the work here is judgment, not fresh research.

The point of the review is to get better. Extract concrete, durable lessons about how to do this job well, and rewrite your operating playbook to fold them in - this playbook is loaded into your context on every future run, so it is how you actually improve over time. Keep it tight and actionable (what to prioritize, what sources pay off, what to stop doing); replace the old one wholesale rather than letting it sprawl.

End the review by calling the record_assessment tool exactly once, as your final action, with your grade, summary, wins, gaps, lessons, any adjustments to propose to the person who set you up, and the full rewritten operating playbook. Do not end by writing prose: a review that stops without calling record_assessment has not been recorded.`;

export interface AssessmentPromptInput {
  spec: DiscoverySpec;
  /** The agent's current operating playbook (null/empty on the first review). */
  operatingNotes: string | null;
  /** Brain stats - neurons / synapses / dangling - to ground the review. */
  brainSize: BrainSize;
  /** The previous review, if any, so the model can judge progress since then. */
  previous: AssessmentRecord | null;
  /** ISO date of this review (so "this week" is concrete). */
  today: string;
}

/** Compose the per-run self-review brief. */
export function buildAssessmentPrompt(input: AssessmentPromptInput): string {
  const { spec, operatingNotes, brainSize, previous, today } = input;
  const sections: string[] = [];

  sections.push(`It's ${today}. Time for your weekly self-review.`);

  sections.push(
    [
      "Your mission",
      `You were set up to research: ${spec.subject}.`,
      `Context from setup: ${spec.description}`,
      `What a good output looks like: ${spec.outputFormat}`,
    ].join("\n"),
  );

  sections.push(
    `Your brain right now: ${brainSize.neurons} note(s), ${brainSize.synapses} link(s), ${brainSize.dangling} dangling link(s). Recall from it before you judge - thin coverage, stale notes, and dangling links are all signals.`,
  );

  const notes = operatingNotes?.trim();
  sections.push(
    notes
      ? `Your current operating playbook (rewrite this - keep what still holds, fold in this week's lessons, drop what didn't pan out):\n\n${notes}`
      : "You have no operating playbook yet - this review writes the first one. Capture the lessons from how the work has gone so far into a tight, actionable playbook.",
  );

  if (previous) {
    sections.push(
      `Last review (${previous.ranAt}) graded you "${previous.grade}" and noted these gaps to close: ${previous.gaps.length ? previous.gaps.join("; ") : "none recorded"}. Judge whether you've closed them.`,
    );
  }

  sections.push("Now run the review and finish by calling record_assessment.");

  return sections.join("\n\n");
}
