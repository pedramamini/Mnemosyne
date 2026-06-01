/**
 * The fixed five-phase deep-dive plan (the initial onboarding research spine).
 *
 * Each phase is a self-contained research pass: a label (for the progress UI), a
 * MANDATE (what this phase is for, woven into the per-phase prompt by
 * {@link ./prompt.ts}), and a step budget (the phase's runaway ceiling - the
 * deliberate exit is still the terminator). The spine is fixed and data-driven so
 * the progress bar is honest (phase N of 5); the agent decides *how* to satisfy
 * each mandate. Phase mandates are entity-lens-aware where it matters - the
 * `facets` phase pulls its focus from {@link FACET_HINTS}.
 */
import { DEEP_RESEARCH_STEP_BUDGET } from "../config.ts";
import type { DiscoveryEntityType } from "../discovery/types.ts";
import type {
  DeepDivePhaseId,
  DeepDivePhaseRecord,
  DeepDiveStatus,
} from "./types.ts";

/** One phase of the plan. `mandate` is the phase's research brief (prompt input). */
export interface DeepDivePhaseSpec {
  id: DeepDivePhaseId;
  /** Short human label shown in the progress UI. */
  label: string;
  /** One- or two-sentence framing of what this phase is for (shown in the UI). */
  blurb: string;
  /** The research brief woven into the phase prompt (imperative, agent-facing). */
  mandate: string;
  /** Runaway ceiling for this phase's headless loop (deliberate exit is the terminator). */
  stepBudget: number;
}

/**
 * Entity-lens focus for the `facets` phase - the signals that matter most for
 * each kind of subject. Keyed by {@link DiscoveryEntityType}; `other` is the
 * generic fallback. Kept here (not on the entity template) so the deep-dive plan
 * owns its own emphasis without widening the template contract.
 */
const FACET_HINTS: Record<DiscoveryEntityType, string> = {
  vendor:
    "pricing and packaging, security and compliance posture, the product roadmap and recent releases, notable customers and case studies, and how it stacks up against its closest competitors",
  product:
    "core features and how they're evolving, the release cadence and recent changelog, real user reception and reviews, integrations and ecosystem, and the head-to-head with competing products",
  investor:
    "the stated investment thesis and focus areas, the active portfolio, recent deals and exits, fund size and dry powder, and the people writing the checks",
  founder:
    "the person's background and track record, their current and past ventures, their public stances and writing, their network, and what they're building or backing now",
  other:
    "the dimensions that matter most for this specific subject - whatever a knowledgeable person tracking it would care about: status, momentum, the people involved, the money, and the credible third-party take",
};

/** The focus line for the `facets` phase, by entity lens. */
export function facetHint(entityType: DiscoveryEntityType): string {
  return FACET_HINTS[entityType] ?? FACET_HINTS.other;
}

/**
 * The five phases, in order. Step budgets ramp from a tighter `orient` to the
 * heavier middle phases, then a focused `synthesis`. All sit at or below the
 * deep-research ceiling - the terminator is the intended exit, the budget the
 * guard.
 */
export const DEEP_DIVE_PLAN: readonly DeepDivePhaseSpec[] = [
  {
    id: "orient",
    label: "Getting oriented",
    blurb:
      "Establishing who/what this is and where the authoritative sources are.",
    mandate:
      "Establish the ground truth about your subject: what it is, the canonical facts (what it does, when it started, where it lives on the web), and which sources are authoritative for it. Write the anchor note that the rest of your brain will link back to, and capture the official/primary sources you'll return to.",
    stepBudget: 40,
  },
  {
    id: "landscape",
    label: "Mapping the landscape",
    blurb:
      "Charting the entities around the subject and linking them together.",
    mandate:
      "Map the landscape around your subject: the entities that matter to it through your lens - competitors and peers, key people, products, partners, or investors as appropriate. Write a focused note for each significant entity and connect them with [[wikilinks]] back to your anchor note. Aim for a connected graph of small, linked notes, not a few sprawling ones.",
    stepBudget: 50,
  },
  {
    id: "developments",
    label: "Recent developments",
    blurb: "Building a dated, sourced timeline of what changed recently.",
    mandate:
      "Build a timeline of what has materially changed recently (roughly the last 6–12 months): announcements, releases, filings, leadership changes, public statements, and credible third-party coverage. Date and source every item, separate confirmed facts from speculation, and link each development to the entities it touches.",
    stepBudget: 50,
  },
  {
    id: "facets",
    label: "Deep-diving key signals",
    blurb:
      "Digging into the specific signals that matter for this kind of subject.",
    // The {{FACETS}} token is replaced with the entity-lens focus by the prompt builder.
    mandate:
      "Go deep on the signals that matter most: {{FACETS}}. Pick the two to four of these that are most consequential for your subject and investigate each properly, writing detailed, well-sourced notes and linking them into the graph you've built.",
    stepBudget:
      DEEP_RESEARCH_STEP_BUDGET >= 60 ? 60 : DEEP_RESEARCH_STEP_BUDGET,
  },
  {
    id: "synthesis",
    label: "Synthesizing the baseline",
    blurb: "Consolidating the brain and writing the baseline brief.",
    mandate:
      "Step back and synthesize. Re-read what you've written, resolve dangling links, merge duplicates, and tighten the notes. Update your Research Scope and Open Questions notes. Then produce a baseline brief that captures the current state of your subject as of today - this is the reference point every future run will diff against. End the run by calling submitFinalReport with that baseline brief.",
    stepBudget: 60,
  },
];

/** The phase spec for an id (the plan is small; a find is fine). */
export function phaseSpec(id: DeepDivePhaseId): DeepDivePhaseSpec {
  const spec = DEEP_DIVE_PLAN.find((p) => p.id === id);
  if (!spec) throw new Error(`unknown deep-dive phase: ${id}`);
  return spec;
}

/** A fresh, all-`pending` phase-record list from the plan (the dive's starting cursor). */
export function initialPhaseRecords(): DeepDivePhaseRecord[] {
  return DEEP_DIVE_PLAN.map((p) => ({
    id: p.id,
    label: p.label,
    status: "pending" as const,
    startedAt: null,
    finishedAt: null,
    note: null,
  }));
}

/** The deep-dive status an agent enters when its dive is kicked off. */
export function startingDeepDiveStatus(now: string): DeepDiveStatus {
  return {
    phase: "running",
    phases: initialPhaseRecords(),
    startedAt: now,
    finishedAt: null,
    error: null,
  };
}
