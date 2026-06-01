/**
 * The fixed six-phase deep-dive plan (the initial onboarding research spine).
 *
 * Each phase is a self-contained research pass: a label (for the progress UI), a
 * MANDATE (what this phase is for, woven into the per-phase prompt by
 * {@link ./prompt.ts}), and a step budget (the phase's MAX DEPTH - the deliberate
 * exit is still the terminator, but the budget is high enough that a thorough
 * phase does real, sustained work before it earns the exit). The spine is fixed
 * and data-driven so the progress bar is honest (phase N of 6) and the dive is
 * always bounded; the agent decides *how* to satisfy each mandate, and is told to
 * go deep within it. Phase mandates are entity-lens-aware where it matters - the
 * `facets` phase pulls its focus from {@link FACET_HINTS}.
 *
 * Budgets are deliberately generous: a freshly-spawned agent should spend real
 * time (tens of model turns per phase) building, testing, and writing - the first
 * impression the product makes is "it did an hour of work," not "it wrote five
 * notes and stopped." The per-run cost cap (MNEMO-49) is the money guard; these
 * budgets are the depth guard.
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

/** A phase budget, clamped to the deep-research ceiling (the absolute max depth). */
function depth(steps: number): number {
  return Math.min(steps, DEEP_RESEARCH_STEP_BUDGET);
}

/**
 * The six phases, in order. Step budgets ramp from a tighter `orient` into the
 * heavy middle phases (landscape / developments / facets), a hands-on `tooling`
 * phase, then a focused `synthesis`. Each budget is this phase's MAX DEPTH - the
 * terminator is the intended exit, but the prompt tells the agent to keep pulling
 * threads until the mandate is genuinely exhausted, so a phase routinely uses tens
 * of turns. All clamp to {@link DEEP_RESEARCH_STEP_BUDGET} (the hard ceiling).
 */
export const DEEP_DIVE_PLAN: readonly DeepDivePhaseSpec[] = [
  {
    id: "orient",
    label: "Getting oriented",
    blurb:
      "Establishing who/what this is and where the authoritative sources are.",
    mandate:
      "Establish the ground truth about your subject: what it is, the canonical facts (what it does, when it started, where it lives on the web), and which sources are authoritative for it. Read the primary sources properly - don't stop at a single search-results page. Write the anchor note that the rest of your brain will link back to, and capture every official/primary source you'll return to.",
    stepBudget: depth(60),
  },
  {
    id: "landscape",
    label: "Mapping the landscape",
    blurb:
      "Charting the entities around the subject and linking them together.",
    mandate:
      "Map the landscape around your subject: the entities that matter to it through your lens - competitors and peers, key people, products, partners, or investors as appropriate. Write a focused note for EACH significant entity (aim for at least six to ten where the landscape supports it) and connect them with [[wikilinks]] back to your anchor note and to each other. Pull the thread - when one entity points to another worth knowing, follow it. Aim for a richly connected graph of small, linked notes, not a few sprawling ones.",
    stepBudget: depth(100),
  },
  {
    id: "developments",
    label: "Recent developments",
    blurb: "Building a dated, sourced timeline of what changed recently.",
    mandate:
      "Build a timeline of what has materially changed recently (roughly the last 6–12 months): announcements, releases, filings, leadership changes, public statements, and credible third-party coverage. Go past the first page of results - chase the specifics behind each headline. Date and source every item, separate confirmed facts from speculation, and link each development to the entities it touches.",
    stepBudget: depth(100),
  },
  {
    id: "facets",
    label: "Deep-diving key signals",
    blurb:
      "Digging into the specific signals that matter for this kind of subject.",
    // The {{FACETS}} token is replaced with the entity-lens focus by the prompt builder.
    mandate:
      "Go deep on the signals that matter most: {{FACETS}}. Pick the three or four that are most consequential for your subject and investigate each one PROPERLY - multiple sources, primary where you can get it, cross-checked. Write detailed, well-sourced notes and link them into the graph you've built. This is the phase where shallow research shows; do the real digging.",
    stepBudget: depth(120),
  },
  {
    id: "tooling",
    label: "Building your toolkit",
    blurb:
      "Authoring, testing, and documenting a reusable tool for this subject.",
    mandate:
      "Build a tool for your future self. By now you know what you'll need to check again and again for this subject - a changelog or blog to diff, a metrics or status endpoint to poll, filings or releases to pull, a search you'll re-run every cycle. Pick the single most valuable recurring action and AUTOMATE it: use authorTool to write a brain__ tool that performs it. Then TEST it - actually run the tool, inspect the output, and iterate (fix the script, re-run) until it works reliably; use runShell / runPython freely while you build. Finally DOCUMENT it: write a methodology note covering what the tool does, when to run it, what its output means, and how you validated it, linked into your graph. Authoring one solid, tested, documented tool beats sketching several you never ran.",
    stepBudget: depth(120),
  },
  {
    id: "synthesis",
    label: "Synthesizing the baseline",
    blurb: "Consolidating the brain and writing the baseline brief.",
    mandate:
      "Step back and synthesize. Re-read what you've written, resolve dangling links, merge duplicates, and tighten the notes. Update your Research Scope and Open Questions notes. Then produce a substantial baseline brief that captures the current state of your subject as of today - this is the reference point every future run will diff against, so make it thorough and well-structured. End the run by calling submitFinalReport with that baseline brief.",
    stepBudget: depth(90),
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
