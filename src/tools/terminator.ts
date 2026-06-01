/**
 * The terminator tool (MNEMO-18) - a deep-research run's deliberate loop exit.
 *
 * The terminator's `inputSchema` IS the final-report schema ({@link FinalReport}),
 * so when the model calls it the SDK validates the structured report for us and
 * `execute` captures it into a per-run closure `sink`. After `generateText`
 * returns, the DO reads the sink via `getResult()` - the "terminator-tool-as-
 * schema" pattern (docs/crema-architecture-reference.md §6; PRD §6.3/§7.1).
 *
 * Calling the terminator does not itself halt the loop mid-step, but the run's
 * `stopWhen` (src/agent/stopConditions.ts) also stops once `wasCalled()` is true,
 * so a deliberate exit ends the loop promptly. A run that hits the step ceiling
 * WITHOUT firing the terminator is the detectable soft-fail (the DO emits an
 * `error`-level audit note for it).
 *
 * Built PER RUN - each run gets its own `sink`/`called` state - because the
 * closure is the capture mechanism (the `ai` SDK has no return channel from a
 * tool back to the call site other than reading state the tool wrote).
 */
import { tool } from "ai";
import { FinalReport, type FinalReportData } from "./reportSchema.ts";
import type { MnemosyneTool, ToolContext } from "./types.ts";

/** The per-run terminator: the tool to register + accessors for its captured result. */
export interface Terminator {
  /** The `ai`-SDK tool to spread into the run's tool map (key `submitFinalReport`). */
  tool: MnemosyneTool;
  /** The captured report once the terminator fired, else null. */
  getResult: () => FinalReportData | null;
  /** Whether the terminator has fired this run (drives `stopWhen`). */
  wasCalled: () => boolean;
}

/**
 * Build a per-run terminator over the turn's {@link ToolContext}. The returned
 * `tool`'s `execute` captures the validated report into `sink`, emits a
 * `report.generated` audit event (title + section count), and returns
 * `{ saved: true }`; `getResult()`/`wasCalled()` expose the captured state.
 */
export function makeTerminator(ctx: ToolContext): Terminator {
  let sink: FinalReportData | null = null;
  let called = false;

  const terminator = tool({
    description:
      "TERMINATOR - call exactly once with your final, structured findings to " +
      "end the research. Submit the complete report (title, summary, sections, " +
      "key findings, and every source you actually consulted) as your final " +
      "action. Do not fabricate sources.",
    inputSchema: FinalReport,
    execute: async (report: FinalReportData) => {
      called = true;
      sink = report;
      await ctx.emit({
        type: "report.generated",
        level: "milestone",
        sessionId: ctx.sessionId,
        text: `Final report: ${report.title} (${sectionCount(report)})`,
        payload: {
          title: report.title,
          sections: report.sections.length,
          confidence: report.confidence,
        },
      });
      return { saved: true };
    },
  });

  return {
    tool: terminator,
    getResult: () => sink,
    wasCalled: () => called,
  };
}

/** "N sections" / "1 section" for the audit summary line. */
function sectionCount(report: FinalReportData): string {
  const n = report.sections.length;
  return `${n} section${n === 1 ? "" : "s"}`;
}
