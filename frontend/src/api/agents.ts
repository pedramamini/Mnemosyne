/**
 * Agent registry API (MNEMO-34) - a typed client over the MNEMO-32 `apiFetch`
 * transport for the MNEMO-05 registry routes. Pure functions, no React; the
 * session cookie rides along via `credentials: "include"` (see `client.ts`).
 *
 *   listAgents()          → GET   /agents          (the account's agents)
 *   getAgent(id)          → GET   /agents/:id       (one owned agent, 404 → throws)
 *   createAgent(body)     → POST  /agents           (fallback/direct create → 201)
 *   updateAgent(id, patch)→ PATCH /agents/:id        (partial update)
 *
 * The `Agent` shape mirrors the backend `AgentResponse` (src/agents/schemas.ts,
 * derived from the D1 `AgentRow`). Nullable columns are typed `string | null`
 * rather than optional so the UI handles a cleared field explicitly.
 */
import { del, get, patch, post } from "./client";

/** The four persona templates - mirrors the backend `AgentTemplate` enum. */
export type AgentTemplate = "vendor" | "product" | "investor" | "founder";

/** Ordered list of templates, for filters/selects. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  "vendor",
  "product",
  "investor",
  "founder",
];

/** The wire shape returned by every `/agents` route (MNEMO-05 `AgentResponse`). */
export interface Agent {
  id: string;
  /** Owning account id - present on the wire; not surfaced in the UI today. */
  account_id?: string;
  name: string;
  /** Nullable in the registry - `null` once explicitly cleared. */
  description: string | null;
  /** Persona lens; `null` until chosen. */
  template: AgentTemplate | null;
  /** Lifecycle status (e.g. `draft`, `building`, `active`). Free-form string. */
  status: string;
  created_at: string;
  /** Configured later via PATCH; absent on a freshly created agent. */
  system_prompt?: string | null;
  /** Cron schedule, set during Build/operation. */
  schedule_cron?: string | null;
}

/** `POST /agents` body - the minimum to stand up an agent (MNEMO-05 `CreateAgentBody`). */
export interface CreateAgentBody {
  name: string;
  description?: string;
  template?: AgentTemplate;
}

/** `PATCH /agents/:id` body - every field optional; nullable fields clear on `null`. */
export interface UpdateAgentBody {
  name?: string;
  description?: string | null;
  template?: AgentTemplate | null;
  system_prompt?: string | null;
  schedule_cron?: string | null;
  status?: string;
}

/** List the current account's agents. */
export function listAgents(): Promise<Agent[]> {
  return get<Agent[]>("/agents");
}

/** Fetch one owned agent. Throws `ApiError` (404) if it does not exist / is not owned. */
export function getAgent(id: string): Promise<Agent> {
  return get<Agent>(`/agents/${encodeURIComponent(id)}`);
}

/** Create an agent directly (used as a fallback/direct create; the wizard goes via Discovery). */
export function createAgent(body: CreateAgentBody): Promise<Agent> {
  return post<Agent>("/agents", body);
}

/** Patch one owned agent. */
export function updateAgent(
  id: string,
  patchBody: UpdateAgentBody,
): Promise<Agent> {
  return patch<Agent>(`/agents/${encodeURIComponent(id)}`, patchBody);
}

/**
 * Permanently delete one owned agent (204, no body). Irreversible: the backend
 * tears down the agent's DO state, sandbox, R2 brain/report blobs, and registry
 * rows. Throws `ApiError` (404) if the agent doesn't exist / isn't owned.
 */
export function deleteAgent(id: string): Promise<void> {
  return del<void>(`/agents/${encodeURIComponent(id)}`);
}

/**
 * Brain-size metric (the "neurons + synapses" of §6.6). Maps to the MNEMO-09
 * read-only endpoint `GET /agents/:id/brain/size`, which serves straight from
 * the DO graph index (no sandbox warm): notes are `neurons`, `[[wikilinks]]`
 * are `synapses`, and `dangling` is the unresolved-link subset. The UI renders
 * neurons + synapses and degrades to "-" if the metric isn't available yet.
 */
export interface BrainStats {
  neurons: number;
  synapses: number;
  /** Synapses whose link target hasn't been written yet (unresolved). */
  dangling: number;
}

/** Fetch one agent's brain-size metric. Throws `ApiError` if unavailable. */
export function getBrainStats(id: string): Promise<BrainStats> {
  return get<BrainStats>(`/agents/${encodeURIComponent(id)}/brain/size`);
}
