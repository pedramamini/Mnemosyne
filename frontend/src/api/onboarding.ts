/**
 * Onboarding (initial deep dive) API adapter.
 *
 * The single point of contact with the backend deep-dive endpoint
 * (`GET /agents/:id/deepdive`). The deep dive is the agent's multi-phase initial
 * research pass, kicked off by Build; this read-only status drives the onboarding
 * progress bar. The shapes mirror the backend `DeepDiveStatus` 1:1 (no remapping
 * needed yet); if the backend contract shifts, adapt it HERE only.
 */
import { get } from "./client";

/** Overall lifecycle of the deep dive. */
export type DeepDivePhase = "not_started" | "running" | "complete" | "failed";

/** Per-phase lifecycle. */
export type DeepDivePhaseStatus = "pending" | "running" | "complete" | "failed";

/** One phase's progress record (the unit the progress UI renders). */
export interface DeepDivePhaseRecord {
  id: string;
  label: string;
  status: DeepDivePhaseStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Short summary the phase produced (shown under a completed phase). */
  note: string | null;
}

/** The deep-dive status - the array a progress bar reads `completed / total` off. */
export interface DeepDiveStatus {
  phase: DeepDivePhase;
  phases: DeepDivePhaseRecord[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Fetch the agent's current deep-dive progress. */
export function fetchDeepDiveStatus(agentId: string): Promise<DeepDiveStatus> {
  return get<DeepDiveStatus>(`/agents/${encodeURIComponent(agentId)}/deepdive`);
}

/** True while the dive is actively running (worth polling for progress). */
export function isDeepDiveActive(status: DeepDiveStatus): boolean {
  return status.phase === "running";
}

/** Count of phases that have completed (for the determinate progress value). */
export function completedPhaseCount(status: DeepDiveStatus): number {
  return status.phases.filter((p) => p.status === "complete").length;
}
