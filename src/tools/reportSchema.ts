/**
 * Final-report Zod schema (MNEMO-18).
 *
 * This schema does double duty: it is BOTH the shape of a deep-research run's
 * structured result AND the `inputSchema` of the terminator tool (src/tools/
 * terminator.ts). Per docs/PRD.md §6.3/§7.1, a deep-research run exits
 * deliberately by calling a terminator tool whose input schema IS this report -
 * the "terminator-tool-as-schema" pattern (docs/crema-architecture-reference.md
 * §6), which is cleaner than JSON-mode-and-pray: if the model finishes WITHOUT
 * calling it, that is a detectable soft-fail rather than a malformed blob to parse.
 *
 * The fields are Obsidian-friendly: MNEMO-24 renders a `FinalReportData` straight
 * to a markdown report with YAML front matter (title/confidence/sources as
 * front-matter, sections as `##` headings, `keyFindings` as a bulleted summary).
 */
import { z } from "zod";

/** One titled section of the report body (rendered as a `##` heading + prose). */
const ReportSection = z.object({
  heading: z.string().describe("Short section heading."),
  body: z.string().describe("The section's prose (markdown allowed)."),
  sourceUrls: z
    .array(z.string())
    .optional()
    .describe("URLs that back this section's claims."),
});

/** A cited source (front-matter + a 'Sources' list in the rendered report). */
const ReportSource = z.object({
  url: z.string().describe("Full URL of the source."),
  title: z.string().optional().describe("Human title of the source, if known."),
});

/**
 * The structured final report a deep-research run produces. Also the terminator
 * tool's `inputSchema` (see module doc): the model fills this out and submits it
 * as its single, deliberate exit action.
 */
export const FinalReport = z.object({
  title: z.string().describe("Title of the report."),
  summary: z.string().describe("A few sentences summarizing the findings."),
  sections: z
    .array(ReportSection)
    .describe("The report body, broken into titled sections."),
  keyFindings: z
    .array(z.string())
    .describe("The most important takeaways, one per entry."),
  sources: z
    .array(ReportSource)
    .describe("Every source actually consulted - never fabricated."),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("Overall confidence in the findings."),
});

/** The inferred TypeScript shape of {@link FinalReport}. */
export type FinalReportData = z.infer<typeof FinalReport>;
