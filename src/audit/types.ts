/**
 * Audit log types - the per-agent "productivity stream" behind the glass cockpit.
 *
 * This is NOT a raw token/tool dump. Each event is a higher-level statement of
 * what the agent *did*. `level` is the altitude control: a UI shows `milestone`
 * by default (the calm narrated stream) and drops to `info` for "show the work".
 */

export type AuditLevel = "info" | "milestone" | "error";

export type AuditType =
  | "session.started"
  | "session.completed"
  | "source.read"
  | "memory.wrote"
  | "memory.linked"
  | "memory.consolidated"
  | "tool.authored"
  | "tool.ran"
  | "report.generated"
  | "chart.rendered"
  // Onboarding deep-dive phase boundary (milestone - the calm stream narrates
  // "Phase 2 of 6: Mapping the landscape" as the initial dive advances).
  | "onboarding.phase"
  // Weekly self-review ("Karpathy loop") outcome + the self-iteration it applied.
  | "assessment.completed"
  | "self.revised"
  | "narration"
  | "error";

/** A stored event. `seq`, `id`, `ts` are assigned by the store on append. */
export interface AuditEvent {
  seq: number; // monotonic per agent - ordering + streaming cursor
  id: string; // sortable-ish unique id
  agentId: string; // stamped from the owning DO
  ts: number; // epoch ms
  type: AuditType;
  level: AuditLevel;
  sessionId: string | null; // groups events from one research run
  text: string; // human summary; FTS-indexed
  payload: Record<string, unknown>; // structured detail
}

/** What a caller supplies when emitting. */
export interface AuditInput {
  type: AuditType;
  text: string;
  level?: AuditLevel; // default "info"
  sessionId?: string | null;
  payload?: Record<string, unknown>;
}

/** Structured filter for the audit stream. */
export interface AuditQuery {
  types?: AuditType[];
  level?: AuditLevel;
  sessionId?: string;
  sinceSeq?: number; // exclusive cursor - for incremental/live tailing
  fromTs?: number;
  toTs?: number;
  limit?: number; // default 100, capped at 1000
}
