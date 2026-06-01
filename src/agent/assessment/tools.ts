/**
 * The self-assessment terminator (`record_assessment`).
 *
 * Mirrors the deep-research terminator (src/tools/terminator.ts): its
 * `inputSchema` IS the {@link AssessmentInput}, so the only way to finish a weekly
 * review is to emit a well-formed assessment - which the SDK validates for us and
 * `execute` captures into a per-run closure. After the loop returns, the DO reads
 * the sink via `getResult()` and persists it; `wasCalled()` drives the run's
 * `stopWhen` so a deliberate finish ends the loop promptly. Built PER RUN (the
 * closure is the capture channel - the `ai` SDK has no return path from a tool
 * back to the call site).
 */
import { tool } from "ai";
import type { MnemosyneTool, ToolContext } from "../../tools/index.ts";
import { AssessmentInput } from "./types.ts";

/** The per-run assessment terminator: the tool + accessors for its captured result. */
export interface AssessmentTerminator {
  /** The `ai`-SDK tool to spread into the run's tool map (key `record_assessment`). */
  tool: MnemosyneTool;
  /** The captured assessment once the terminator fired, else null. */
  getResult: () => AssessmentInput | null;
  /** Whether the terminator has fired this run (drives `stopWhen`). */
  wasCalled: () => boolean;
}

/**
 * Build a per-run assessment terminator over the run's {@link ToolContext}. The
 * tool's `execute` validates + captures the assessment, emits an
 * `assessment.completed` milestone (grade + a lesson count), and returns
 * `{ recorded: true }`.
 */
export function makeAssessmentTerminator(
  ctx: ToolContext,
): AssessmentTerminator {
  let sink: AssessmentInput | null = null;
  let called = false;

  const terminator = tool({
    description:
      "TERMINATOR - call exactly once, as your final action, to record your " +
      "weekly self-review. Submit your grade, a short summary, what's working " +
      "(wins) and what's missing (gaps), the durable lessons you've learned, any " +
      "adjustments to propose to the person who set you up, and the FULL rewritten " +
      "operating playbook. This is the only way to finish the review - do not " +
      "finish in prose.",
    inputSchema: AssessmentInput,
    execute: async (input: AssessmentInput) => {
      called = true;
      sink = input;
      await ctx.emit({
        type: "assessment.completed",
        level: "milestone",
        sessionId: ctx.sessionId,
        text: `Weekly self-review: ${gradeLabel(input.grade)} (${lessonCount(input)})`,
        payload: {
          grade: input.grade,
          lessons: input.lessons.length,
          gaps: input.gaps.length,
        },
      });
      return { recorded: true };
    },
  });

  return {
    tool: terminator,
    getResult: () => sink,
    wasCalled: () => called,
  };
}

/** Human label for a grade in the audit line. */
function gradeLabel(grade: AssessmentInput["grade"]): string {
  switch (grade) {
    case "on_track":
      return "on track";
    case "needs_attention":
      return "needs attention";
    case "off_track":
      return "off track";
  }
}

/** "N lesson(s)" for the audit summary. */
function lessonCount(input: AssessmentInput): string {
  const n = input.lessons.length;
  return `${n} lesson${n === 1 ? "" : "s"}`;
}
