/**
 * Discovery soft rubric (MNEMO-29, PRD §5(1)/§6.3).
 *
 * The five facets the clarify-scope conversation tries to understand before it is
 * confident enough to finalize. This is a SOFT rubric the model uses to
 * SELF-ASSESS - *not* a required-fields gate and *not* a slot-filling form. The
 * model decides when it understands "enough" (the ~0.9 good-enough threshold from
 * PRD §6.3) and may finalize early if the opening description already covers them.
 * Nothing in the codebase blocks finalization on a per-field checklist; the only
 * structural gate is that the `finalize_discovery` terminator emits a well-formed
 * DiscoverySpec (src/agent/discovery/tools.ts).
 *
 * No logic lives here - this is the rubric DATA that both the system prompt
 * (prompt.ts) and the spec schema (types.ts) reference, so the conversation and
 * the persisted spec describe the same five dimensions.
 */

/** One facet of the soft rubric. */
export interface DiscoveryFacet {
  /** Stable key - matches the corresponding field on the DiscoverySpec. */
  key: DiscoveryFacetKey;
  /** Human label for the system prompt. */
  label: string;
  /** What "understood" means for this facet (woven into the system prompt). */
  prompt: string;
  /**
   * Relative weight in the model's self-assessment. Defaults to equal; `subject`
   * and `entityType` are weighted slightly higher because they anchor everything
   * downstream (a wrong subject/entity type invalidates the rest of the spec).
   */
  weight: number;
}

/**
 * The five facets of PRD §5(1). `key` is intentionally identical to the matching
 * field on {@link DiscoverySpec} so the rubric, the prompt, and the schema never
 * drift. `subject`/`entityType` carry the heavier weight (they anchor the spec).
 */
export const DISCOVERY_FACETS: readonly DiscoveryFacet[] = [
  {
    key: "subject",
    label: "Subject",
    prompt:
      "exactly what the agent should specialize in - the specific company, product, person, market, or topic it watches, narrow enough to research well.",
    weight: 1.5,
  },
  {
    key: "entityType",
    label: "Entity type",
    prompt:
      "which kind of thing the subject is - a vendor, a product, an investor, a founder, or something else - so the right research lens applies.",
    weight: 1.5,
  },
  {
    key: "sources",
    label: "Sources",
    prompt:
      "where the agent should look - the kinds of sites, feeds, filings, or publications that carry the signal worth tracking.",
    weight: 1,
  },
  {
    key: "cadence",
    label: "Cadence",
    prompt:
      "how often the agent should run and report - a rough schedule (e.g. weekly, on a specific day) or an on-demand hint.",
    weight: 1,
  },
  {
    key: "outputFormat",
    label: "Output format",
    prompt:
      "what a good report looks like to this user - the shape, length, and emphasis of the written findings they want back.",
    weight: 1,
  },
] as const;

/** Union of the rubric facet keys; mirrors the matching DiscoverySpec fields. */
export type DiscoveryFacetKey =
  | "subject"
  | "entityType"
  | "sources"
  | "cadence"
  | "outputFormat";
