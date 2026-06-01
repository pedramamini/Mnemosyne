/**
 * Stop conditions for the agentic loop (MNEMO-18).
 *
 * `terminatorOrBudget` combines the two ways a deep-research run can end:
 *   - the terminator tool firing - the *prompt-intended* and now *enforced* exit:
 *     the model is told to call `submitFinalReport` as its final action, and once
 *     `wasCalled()` is true the loop stops promptly rather than taking another
 *     speculative step; and
 *   - `stepCountIs(stepBudget)` - the *hard ceiling* (a runaway guard, PRD §8.5).
 *
 * Reaching the ceiling WITHOUT the terminator having fired is the detectable
 * soft-fail (PRD §7.1/§8.5): the run ran out of road instead of finishing on
 * purpose. The DO surfaces that as an `error`-level audit note.
 */
import { type StopCondition, stepCountIs, type ToolSet } from "ai";

/**
 * Stop when EITHER the terminator has fired (`wasCalled()`) OR the step budget is
 * exhausted. `wasCalled` is the per-run accessor from {@link makeTerminator}, so
 * the predicate sees the live terminator state each time the SDK evaluates it.
 */
export function terminatorOrBudget(
  stepBudget: number,
  wasCalled: () => boolean,
): StopCondition<ToolSet>[] {
  return [stepCountIs(stepBudget), () => wasCalled()];
}
