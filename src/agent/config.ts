/**
 * Loop-budget constants for the agentic harness (MNEMO-15).
 *
 * The harness is the Vercel AI SDK loop hosted by `AIChatAgent` (PRD §7.1,
 * topology A). `stopWhen: stepCountIs(<budget>)` is the **hard ceiling** on the
 * call→tool→feed-back loop - a runaway guard, NOT the intended way the loop ends.
 *
 * The *deliberate* exit is the terminator tool (MNEMO-18): the model signals
 * "done" by calling it. Reaching one of these ceilings WITHOUT a terminator call
 * is therefore a detectable soft-fail (the loop ran out of road rather than
 * finishing on purpose) - callers/monitoring should treat a budget-exhausted
 * `finishReason` as a signal, not a success.
 *
 * Deep-research runs get a high ceiling (PRD §8.5: ~50–200 steps; the deepest
 * chains approach 100). Interactive chat is kept low - a human is in the loop and
 * can re-prompt, so a long unattended chain is the wrong default there.
 */

/**
 * Interactive (`streamText`) chat ceiling. A human is watching and can steer, so
 * a turn that needs more than this many model↔tool round-trips is almost always
 * a sign to break the work up rather than let it run on.
 */
export const INTERACTIVE_STEP_BUDGET = 30;

/**
 * Deep-research ceiling for headless/scheduled runs (PRD §8.5, range ~50–200).
 * The flagship deep-research path (reporting MNEMO-24, scheduling MNEMO-27)
 * passes this so a long autonomous investigation has room to plan → fetch →
 * write-to-brain → re-plan without tripping the guard prematurely.
 */
export const DEEP_RESEARCH_STEP_BUDGET = 200;

/**
 * Default ceiling for a headless `generateText` run when the caller does not
 * specify one. Sits between the interactive and deep-research budgets: enough for
 * a substantive background task, well short of the deep-research ceiling.
 */
export const DEFAULT_HEADLESS_STEP_BUDGET = 80;

/**
 * Discovery (MNEMO-29) clarify-scope ceiling. Kept low on purpose: Discovery is a
 * SHALLOW conversation - one or two follow-up questions per turn, then the
 * `finalize_discovery` terminator. The deliberate exit is the terminator firing
 * (the DO's `stopWhen` stops the moment it's called); this small step budget is
 * just the runaway guard for a single turn that fans out into tool retries.
 */
export const DISCOVERY_STEP_BUDGET = 8;

/**
 * Minimum number of clarify-scope exchanges (user turns, counting the opening
 * description) before {@link DiscoverySpec} finalization is permitted. Discovery
 * is a real interview, not a one-shot: the `finalize_discovery` terminator is
 * hard-gated below this floor (src/agent/discovery/tools.ts) so a vague one-liner
 * can't shortcut to "ready" - the model must draw the scope and sources out over
 * several turns first. The model aims for good-enough within ~3-5 exchanges.
 */
export const DISCOVERY_MIN_TURNS = 3;
