/**
 * Discovery tool set (MNEMO-29, PRD §5/§6.3).
 *
 * Discovery is CONVERSATION-ONLY: no sandbox, web, or memory tools are exposed
 * here - the agent isn't provisioned yet, and scoping is pure dialogue + model
 * reasoning inside the always-cheap DO. Two tools, both structured channels that
 * keep machine-readable state OUT of the prose the person reads:
 *
 *   - `note_progress` (NON-terminal): the model reports its RUNNING per-facet
 *     understanding + overall confidence each turn. The DO persists it so the UI
 *     can light the rubric / climb the meter mid-interview. Carrying this over a
 *     tool call (not an inline `<followup>`/JSON blob in the reply) is what keeps
 *     the chat bubble clean - the assistant's message stays plain prose.
 *   - `finalize_discovery` (TERMINATOR, mirrors MNEMO-18's `submitFinalReport`):
 *     its `inputSchema` IS the {@link DiscoverySpec}, so the only way to end
 *     Discovery is to emit a well-formed spec. It is HARD-GATED by `canFinalize`
 *     ({@link DISCOVERY_MIN_TURNS}): below the floor it refuses and tells the
 *     model to keep interviewing, so a vague opener can't shortcut to "ready".
 *
 * The DO's `stopWhen` (MNEMO-15) stops the loop the moment `finalize_discovery`
 * succeeds, exactly as the MNEMO-18 terminator does.
 */
import { type ToolSet, tool } from "ai";
import { DiscoveryProgress, DiscoverySpec } from "./types.ts";

/** Callback the DO injects to persist the latest running self-assessment. */
export type OnDiscoveryProgress = (
  progress: DiscoveryProgress,
) => void | Promise<void>;

/** Callback the DO injects to persist the finalized spec + flip Discovery status. */
export type OnFinalizeDiscovery = (spec: DiscoverySpec) => void | Promise<void>;

/** Wiring the DO injects into the Discovery tool set for one clarify-scope turn. */
export interface DiscoveryToolDeps {
  /**
   * Whether the interview floor (DISCOVERY_MIN_TURNS) has been met. When false,
   * `finalize_discovery` refuses and nudges the model to keep asking questions.
   */
  canFinalize: boolean;
  /** Persist the running per-facet/confidence self-assessment. */
  onProgress: OnDiscoveryProgress;
  /** Persist the finalized spec + flip status to complete. */
  onFinalize: OnFinalizeDiscovery;
}

/**
 * Build the Discovery tool set. `note_progress` re-validates and forwards the
 * running self-assessment; `finalize_discovery` re-validates the spec (so a
 * malformed direct call rejects, not just an SDK-routed one), enforces the
 * `canFinalize` floor, invokes `onFinalize`, and returns a confirmation string.
 */
export function makeDiscoveryTools(deps: DiscoveryToolDeps): ToolSet {
  const { canFinalize, onProgress, onFinalize } = deps;
  return {
    note_progress: tool({
      description:
        "Call this at the START of every turn, before you reply, to record your " +
        "CURRENT understanding. For each facet give a short note in your own " +
        "words - or leave it an empty string if you do not genuinely understand " +
        "it yet (do not guess). Also give your overall confidence (0..1). This " +
        "is a private status update: it lights up the scope panel the person " +
        "sees. It does NOT end Discovery and is never shown as a message.",
      inputSchema: DiscoveryProgress,
      execute: async (input) => {
        const progress = DiscoveryProgress.parse(input);
        await onProgress(progress);
        return "Progress noted.";
      },
    }),
    finalize_discovery: tool({
      description:
        "TERMINATOR - call exactly once, as your final action, only AFTER a real " +
        "interview (typically 3-5 exchanges) once you genuinely understand what " +
        "this agent should specialize in. Submit the complete Discovery spec: " +
        "the subject, the entity type, the sources, the cadence, the output " +
        "format, your per-facet notes, and your overall confidence (0..1). This " +
        "is the only way to finish Discovery - do not finalize in prose.",
      inputSchema: DiscoverySpec,
      execute: async (input) => {
        if (!canFinalize) {
          // Hard floor: refuse, and steer the model back into the interview. The
          // loop continues (finalized stays false) and it asks another question.
          return (
            "Too early to finalize - you have not interviewed enough yet. Do " +
            "NOT finalize now. Ask another focused follow-up question instead, " +
            "especially about what to research in depth and where to pull data."
          );
        }
        const spec = DiscoverySpec.parse(input);
        await onFinalize(spec);
        return `Discovery finalized for "${spec.name}".`;
      },
    }),
  };
}
