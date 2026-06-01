/**
 * Deep-dive (initial onboarding) state schemas (PRD §5/§6.3 follow-on).
 *
 * After Build (MNEMO-30) provisions an agent, it does NOT yet know anything - its
 * brain holds only the template's seed notes. The **deep dive** is the agent's
 * first job: a multi-phase initial research pass that fills the brain end to end
 * before the agent settles into its recurring cadence. It runs entirely in the
 * background as a chain of alarm-driven phases (see {@link MnemosyneAgent.runDeepDivePhase}),
 * so it survives hibernation and is resumable - each completed phase is recorded
 * here as the resume cursor, exactly like {@link BuildStatus.completed}.
 *
 * This module is schemas + a default-state factory only; the fixed 5-phase plan
 * (labels + mandates) lives in {@link ./plan.ts} and the orchestration on the DO.
 */
import { z } from "zod";

/**
 * The fixed five-phase spine of the initial deep dive, in execution order. The
 * spine is deliberately fixed (not model-planned) so the progress bar is honest
 * and bounded; the agent has full freedom *within* each phase.
 *
 *  - `orient`        - establish the subject's identity + authoritative sources
 *  - `landscape`     - map the surrounding entities and link them (build the graph)
 *  - `developments`  - timeline of what materially changed recently
 *  - `facets`        - dig into the entity-lens signals that matter most
 *  - `synthesis`     - consolidate, resolve loose ends, set the baseline brief
 */
export const DeepDivePhaseId = z.enum([
  "orient",
  "landscape",
  "developments",
  "facets",
  "synthesis",
]);
export type DeepDivePhaseId = z.infer<typeof DeepDivePhaseId>;

/** Per-phase lifecycle. `pending` → `running` → `complete` | `failed`. */
export const DeepDivePhaseStatus = z.enum([
  "pending",
  "running",
  "complete",
  "failed",
]);
export type DeepDivePhaseStatus = z.infer<typeof DeepDivePhaseStatus>;

/** Overall lifecycle of the deep dive for one agent. */
export const DeepDivePhase = z.enum([
  "not_started",
  "running",
  "complete",
  "failed",
]);
export type DeepDivePhase = z.infer<typeof DeepDivePhase>;

/**
 * One phase's record - the unit the progress UI renders and the orchestrator
 * advances. `note` is the short summary the phase produced (carried forward as
 * context into later phases, and shown in the UI).
 */
export const DeepDivePhaseRecord = z.object({
  id: DeepDivePhaseId,
  /** Human label for the progress UI (e.g. "Mapping the landscape"). */
  label: z.string(),
  status: DeepDivePhaseStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Short, model-authored summary of what the phase established (or the error). */
  note: z.string().nullable(),
});
export type DeepDivePhaseRecord = z.infer<typeof DeepDivePhaseRecord>;

/**
 * The persisted deep-dive state for one agent (stored under the `deepdive` meta
 * key). `phases` is the full ordered plan with per-phase progress - the array a
 * progress bar reads `completed / total` off of. A phase that `failed` does NOT
 * abort the dive (one weak phase shouldn't leave the brain empty); the dive still
 * reaches `complete`, and `error` carries the last failure for visibility.
 */
export const DeepDiveStatus = z.object({
  phase: DeepDivePhase,
  phases: z.array(DeepDivePhaseRecord),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type DeepDiveStatus = z.infer<typeof DeepDiveStatus>;

/** State for an agent whose deep dive has not been kicked off yet. */
export function defaultDeepDiveStatus(): DeepDiveStatus {
  return {
    phase: "not_started",
    phases: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}
