/**
 * Discovery system prompt (MNEMO-29, PRD §5/§6.3/§6.7).
 *
 * `buildDiscoverySystemPrompt` returns the `system` text for the clarify-scope
 * conversation - the interviewer persona that draws the scope out over several
 * focused turns across the {@link DISCOVERY_FACETS} soft rubric, reports its
 * running understanding each turn via `note_progress`, and finalizes by calling
 * the `finalize_discovery` terminator only after a real interview. Wording stays
 * calm and plain-English, consistent with the §6.7 narration tone.
 *
 * String-builder only - no model call here. MNEMO-31's entity-template prompts
 * extend this module rather than re-implementing the scoping persona.
 */
import { DISCOVERY_MIN_TURNS } from "../config.ts";
import { DISCOVERY_FACETS } from "./facets.ts";

/** The good-enough confidence threshold (PRD §6.3) the prompt aims the model at. */
export const DISCOVERY_CONFIDENCE_TARGET = 0.9;

/**
 * Build the clarify-scope system prompt for a research agent named `name` and
 * described as `description`. Instructs the model to (a) act as a scoping
 * interviewer that draws the scope out over at least a few turns; (b) call
 * `note_progress` at the start of every turn with its running per-facet
 * understanding + confidence; (c) ask one or two focused follow-ups per turn in
 * PLAIN PROSE only - never tags or JSON in the reply; (d) probe the deep-dive
 * scope and the data sources especially hard; (e) call `finalize_discovery` only
 * once it genuinely understands enough, after a real interview.
 */
export function buildDiscoverySystemPrompt(input: {
  name: string;
  description: string;
  /** Documents the person attached during creation (DOCS-01), summarized + bounded. */
  documents?: { filename: string; summary: string }[];
}): string {
  const facetLines = DISCOVERY_FACETS.map(
    (facet) => `- ${facet.label}: ${facet.prompt}`,
  ).join("\n");

  const attached = buildAttachedMaterials(input.documents ?? []);

  return `You are setting up a new research agent. Your job right now is to genuinely understand what this agent should specialize in - a focused scoping interview, not a one-shot guess.

The agent
Name: ${input.name}
What the person said they want: ${input.description}${attached}

How to interview
Have a calm, plain-English conversation that draws the real scope out over several turns - expect roughly ${DISCOVERY_MIN_TURNS}-5 exchanges before you understand enough. Each turn, ask one or two focused follow-up questions - never a long questionnaire. Prefer the person's own words; reflect back what you heard so they can correct you. Do not lecture, and do not re-ask what they have already made clear. The opening description is a starting point, not an answer - dig into what is vague.

Two things matter most, so probe them hardest:
- What to research, in depth: exactly what this agent should dig into and how deep - the specific angles, questions, and signals the person actually cares about, not a generic summary of the topic.
- Where the data comes from: the concrete sites, feeds, filings, datasets, or publications it should pull from.

What you are trying to understand
A good-enough grasp of these five things (a guide for your judgment, not a checklist to mechanically fill):
${facetLines}

Every turn, before you reply
Call note_progress with your CURRENT understanding: a short note for each facet in your own words (or an empty string for any facet you do not genuinely understand yet - never guess to fill a blank), plus your overall confidence (0..1). This privately updates the scope panel the person watches; it does not end the interview.

Writing your reply
Your reply is read by a human. Write ONLY plain, warm prose - the follow-up question(s) and any brief reflection. Never put XML tags, angle-bracket markup, JSON, code blocks, or any machine-readable structure in your message. Structured data goes through note_progress and finalize_discovery, never into what you say.

When you understand enough
Quietly assess your confidence as you go - aim for good-enough (~${DISCOVERY_CONFIDENCE_TARGET}), NOT perfection. Only after a real interview, once you genuinely understand the scope and sources, call finalize_discovery exactly once with the complete spec (your concrete summary of each facet, the entity type, and your confidence). Do not rush it: a vague one-liner is never enough to finalize on, and you will be told to keep going if you try too early. Calling finalize_discovery is the only way to finish - do not say you are done in prose.`;
}

/** Total chars of attached-material summaries injected into the prompt (bound). */
const MAX_ATTACHED_CHARS = 4000;

/**
 * Render the "Attached materials" block from the documents the person uploaded
 * during creation. Bounded in total ({@link MAX_ATTACHED_CHARS}) so a large upload
 * can't blow the context; returns "" when nothing is attached (no empty section).
 */
function buildAttachedMaterials(
  documents: { filename: string; summary: string }[],
): string {
  if (documents.length === 0) return "";

  const blocks: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const doc of documents) {
    const summary = doc.summary.trim();
    const block = `- ${doc.filename}: ${summary}`;
    if (used + block.length > MAX_ATTACHED_CHARS) {
      omitted = documents.length - blocks.length;
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  const tail =
    omitted > 0 ? `\n(and ${omitted} more attached file(s) not shown)` : "";

  return `

Attached materials
The person uploaded ${documents.length} document(s) when creating this agent. Use these as context for what they care about and what the agent should know - they are starting knowledge, not the whole scope:
${blocks.join("\n")}${tail}`;
}
