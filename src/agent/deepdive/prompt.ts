/**
 * Per-phase deep-dive prompt assembly.
 *
 * Each deep-dive phase is a headless research run (`runHeadless`), so it gets the
 * full base persona + the deep-research overlay from the harness already. This
 * builds the per-phase `prompt` (the user-turn brief) that frames WHERE the agent
 * is in the dive, WHAT this phase is for, and WHAT it already established in the
 * phases before - so each phase builds on the last instead of starting cold.
 *
 * Pure function - no I/O - so it is unit-testable directly.
 */
import type { DiscoverySpec } from "../discovery/types.ts";
import { type DeepDivePhaseSpec, facetHint } from "./plan.ts";

/** A prior phase's outcome, threaded forward as context. */
export interface PriorPhaseSummary {
  label: string;
  note: string | null;
}

export interface DeepDivePromptInput {
  spec: DiscoverySpec;
  phase: DeepDivePhaseSpec;
  /** 1-based position of this phase in the dive. */
  phaseNumber: number;
  totalPhases: number;
  /** Summaries of the phases already completed this dive (in order). */
  prior: PriorPhaseSummary[];
}

/**
 * Compose the per-phase research brief. Sections: where-you-are framing → the
 * subject + sources → what earlier phases found → this phase's mandate → the
 * recall-then-remember discipline → how the phase ends.
 */
export function buildDeepDivePhasePrompt(input: DeepDivePromptInput): string {
  const { spec, phase, phaseNumber, totalPhases, prior } = input;
  const sections: string[] = [];

  sections.push(
    `This is your initial deep dive - the first time you've ever researched your subject. You're working through it in ${totalPhases} phases; this is phase ${phaseNumber} of ${totalPhases}: ${phase.label}.`,
  );

  const sources =
    spec.sources.length > 0
      ? spec.sources.join("; ")
      : "the subject's official site and reputable third-party coverage";
  sections.push(
    `Your subject: ${spec.subject}.\nStart from these kinds of sources: ${sources}.`,
  );

  // Carry forward what earlier phases established (skip empty notes).
  const priorWithNotes = prior.filter((p) => p.note && p.note.trim() !== "");
  if (priorWithNotes.length > 0) {
    const lines = priorWithNotes.map((p) => `- ${p.label}: ${p.note}`);
    sections.push(
      `So far in this dive you've established:\n${lines.join("\n")}\nBuild on this - recall the relevant notes before researching, and don't redo work you've already done.`,
    );
  }

  // The phase mandate (facets phase substitutes the entity-lens focus).
  const mandate = phase.mandate.replace(
    "{{FACETS}}",
    facetHint(spec.entityType),
  );
  sections.push(`This phase: ${mandate}`);

  sections.push(
    "Recall first (search and read your existing notes), then research, then write durable, well-linked notes as you go. Keep every claim sourced and dated. Work this phase to real depth: you have a generous step budget, so keep pulling threads and following citations until the mandate is genuinely exhausted - don't stop at the first passable result.",
  );

  // How the phase ends - every phase exits through the terminator so the harness
  // captures a structured result and the loop stops promptly.
  if (phase.id === "synthesis") {
    sections.push(
      `When the baseline is solid, end with submitFinalReport: the baseline brief in the format the person asked for (${spec.outputFormat}).`,
    );
  } else {
    sections.push(
      "Only once you've genuinely satisfied this phase's mandate - not before - end the run by calling submitFinalReport with a plain summary of what you established in THIS phase and the notes you wrote; that summary carries forward into the next phase. A few sentences is enough for the summary itself, but it should reflect substantial work, not a token pass.",
    );
  }

  return sections.join("\n\n");
}
