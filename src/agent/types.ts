/**
 * Zod schemas + types for the DO's persisted operating state.
 *
 * These describe DO-resident state ONLY. The source of truth for cross-agent
 * listing is the D1 registry row (`agents` table, MNEMO-02/05); the DO mirrors
 * just what it needs to operate so search/brain-size work without waking the
 * sandbox (PRD §7.4). The `template` enum is reused from the D1 layer rather
 * than re-declared so the two stay in lockstep.
 */
import { z } from "zod";
import { AgentTemplate } from "../db/index.ts";

/** Per-agent settings persisted (as JSON) in `agent_meta`. */
export const AgentSettings = z.object({
  /** Resolved/BYOK model id; null until set (provider resolution lands Track C). */
  model: z.string().nullable(),
  /** Research persona template; mirrors the D1 registry column. */
  template: AgentTemplate.nullable(),
  /** Operator-authored system prompt override; null = use the template default. */
  systemPrompt: z.string().nullable(),
  /**
   * Operational tool capabilities enabled for this agent (MNEMO-30 Build): web
   * search/fetch + sandbox exec + self-authored tools (the MNEMO-16/17/19
   * registry). Empty until Build runs. `.default([])` so pre-Build settings JSON
   * (written before this field existed) still parses, filling the empty list.
   */
  enabledTools: z.array(z.string()).default([]),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

/** Per-agent run schedule persisted (as JSON) in `agent_meta`. */
export const AgentSchedule = z.object({
  /** Cron expression for scheduled research runs; null = manual only. */
  cron: z.string().nullable(),
  /** Whether the schedule is active. */
  enabled: z.boolean(),
});
export type AgentSchedule = z.infer<typeof AgentSchedule>;

/** Settings for a brand-new agent before anything is configured. */
export function defaultSettings(): AgentSettings {
  return { model: null, template: null, systemPrompt: null, enabledTools: [] };
}

/** Schedule for a brand-new agent (no cron, disabled). */
export function defaultSchedule(): AgentSchedule {
  return { cron: null, enabled: false };
}
