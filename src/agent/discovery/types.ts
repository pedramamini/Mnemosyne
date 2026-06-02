/**
 * Discovery spec + state schemas (MNEMO-29, PRD §5/§6.3).
 *
 * The {@link DiscoverySpec} is the structured result of the clarify-scope
 * conversation - and it doubles as the `inputSchema` of the `finalize_discovery`
 * terminator tool (src/agent/discovery/tools.ts), so the ONLY way to end Discovery
 * is to emit a well-formed spec (the "terminator-tool-as-schema" pattern, mirrors
 * MNEMO-18). The spec persists to the DO's `agent_meta` table under a `discovery`
 * key (DO-resident operating state), NOT to D1 - Build (MNEMO-30) promotes the
 * relevant fields to the registry when it provisions.
 *
 * No business logic here - schemas + a default-state factory only. Facet keys
 * come from {@link DISCOVERY_FACETS} so the rubric, prompt, and schema agree.
 */
import { z } from "zod";
import { AgentTemplate } from "../../db/index.ts";
import type { DiscoveryFacetKey } from "./facets.ts";

/**
 * The kind of entity the agent specializes in. This is the BRIDGE to MNEMO-31's
 * entity templates: the four template names (`vendor`/`product`/`investor`/
 * `founder`, reused from the D1 `AgentTemplate` enum so the two stay in lockstep)
 * plus `"other"` for a subject that fits none of them. MNEMO-31 keys its template
 * overlay off this field; `"other"` falls back to the base persona.
 */
export const DiscoveryEntityType = z.enum([...AgentTemplate.options, "other"]);
export type DiscoveryEntityType = z.infer<typeof DiscoveryEntityType>;

/**
 * Per-facet free-text notes the model captured while scoping. Keyed by the
 * {@link DiscoveryFacetKey} rubric keys; the `satisfies` constraint makes the
 * compiler verify every facet has a slot (so adding a facet to the rubric forces
 * a matching schema field).
 */
const facetNotesShape = {
  subject: z.string(),
  entityType: z.string(),
  sources: z.string(),
  cadence: z.string(),
  outputFormat: z.string(),
} satisfies Record<DiscoveryFacetKey, z.ZodString>;
export const FacetNotes = z.object(facetNotesShape);
export type FacetNotes = z.infer<typeof FacetNotes>;

/**
 * The structured Discovery spec - the result the confidence gate emits. Required
 * fields (`subject`, `entityType`, …) make the terminator a real structural gate:
 * the model cannot "finish Discovery" with a half-formed understanding.
 * `confidence` is the model's self-assessment in [0,1] (the ~0.9 good-enough
 * threshold from PRD §6.3).
 */
export const DiscoverySpec = z.object({
  /** The agent's display name (carried from the opening Discovery input). */
  name: z.string().min(1),
  /** The user's short description of the agent (carried from the opening input). */
  description: z.string().min(1),
  /** What, specifically, the agent specializes in researching. */
  subject: z.string().min(1),
  /** The entity lens - bridge to MNEMO-31 templates. */
  entityType: DiscoveryEntityType,
  /** Where the agent should look (kinds of sources). */
  sources: z.array(z.string()),
  /** A cron-ish or natural-language cadence hint. */
  cadence: z.string(),
  /** What a good report looks like to this user. */
  outputFormat: z.string(),
  /** The model's self-assessed confidence that it understands the scope, [0,1]. */
  confidence: z.number().min(0).max(1),
  /** Per-facet notes the model captured while scoping. */
  facetNotes: FacetNotes,
  /** ISO timestamp the spec was finalized. */
  finalizedAt: z.string(),
});
export type DiscoverySpec = z.infer<typeof DiscoverySpec>;

/** Lifecycle status of the Discovery stage for one agent. */
export const DiscoveryStatus = z.enum(["in_progress", "complete"]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatus>;

/**
 * The model's RUNNING self-assessment, refreshed each turn via the non-terminal
 * `note_progress` tool (src/agent/discovery/tools.ts) - distinct from the final
 * {@link DiscoverySpec}, which only exists once the gate fires. It lets the UI
 * light the rubric and climb the confidence meter DURING the interview instead of
 * snapping to 5/5 at finalize. `facetNotes` reuses the spec shape: a non-empty
 * note means the model genuinely understands that facet yet (an empty string =
 * still open), so the same satisfied-check works for progress and the final spec.
 */
export const DiscoveryProgress = z.object({
  facetNotes: FacetNotes,
  confidence: z.number().min(0).max(1),
});
export type DiscoveryProgress = z.infer<typeof DiscoveryProgress>;

/**
 * The persisted Discovery state for one agent (stored under the `discovery` meta
 * key). `spec` is null until the confidence gate fires; `turns` counts how many
 * clarify-scope exchanges have happened; `progress` is the latest running
 * self-assessment (null until the model first reports it).
 */
export const DiscoveryState = z.object({
  status: DiscoveryStatus,
  spec: DiscoverySpec.nullable(),
  turns: z.number().int().nonnegative(),
  progress: DiscoveryProgress.nullable().default(null),
});
export type DiscoveryState = z.infer<typeof DiscoveryState>;

/** State for an agent that has just entered Discovery (nothing scoped yet). */
export function defaultDiscoveryState(): DiscoveryState {
  return { status: "in_progress", spec: null, turns: 0, progress: null };
}

/**
 * A document attached to an in-progress Discovery (DOCS-01): its id, filename, and
 * a short summary (the first chunk of converted markdown). Stored under a sibling
 * `discovery:documents` meta key - NOT in {@link DiscoveryState} - and injected
 * into the discoveryTurn LLM context so the interview "sees" the uploaded material.
 */
export const DiscoveryDocument = z.object({
  id: z.string(),
  filename: z.string(),
  summary: z.string(),
});
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>;
