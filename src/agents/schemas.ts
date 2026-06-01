/**
 * Request/response Zod schemas for the agent registry API (MNEMO-05).
 *
 * Pure schemas + inferred types - no handlers, no storage. Routes validate
 * inbound bodies against `CreateAgentBody` / `UpdateAgentBody` and shape every
 * response through `AgentResponse`. The persona `template` enum and the row
 * shape are reused from `src/db` so the API contract stays in lockstep with the
 * registry table rather than re-declaring (and drifting from) it.
 */
import { z } from "zod";
import { AgentRow, AgentTemplate } from "../db/index.ts";

/**
 * POST /agents body - the minimum to stand up an agent. `name` is required and
 * must be non-empty after trimming; `description` and `template` are optional.
 * System prompt / schedule are configured later via PATCH, not at create time.
 */
export const CreateAgentBody = z.object({
  name: z.string().trim().min(1, "name is required"),
  description: z.string().optional(),
  template: AgentTemplate.optional(),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

/**
 * PATCH /agents/:agentId body - every operational field is optional, but at
 * least one must be present (an empty patch is a client error, not a no-op).
 * Nullable fields accept `null` to explicitly clear a previously-set value.
 */
export const UpdateAgentBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    template: AgentTemplate.nullable().optional(),
    system_prompt: z.string().nullable().optional(),
    schedule_cron: z.string().nullable().optional(),
    status: z.string().trim().min(1).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;

/**
 * Wire shape returned by every /agents route. Derived from `AgentRow`: today it
 * is identical (the registry columns are all client-safe - no secrets to
 * strip), but keeping it as its own schema gives the API contract one place to
 * diverge from storage without churning call sites.
 */
export const AgentResponse = AgentRow;
export type AgentResponse = z.infer<typeof AgentResponse>;
