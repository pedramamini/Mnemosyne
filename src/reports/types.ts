/**
 * Public type surface of the reporting module (MNEMO-23).
 *
 * Callers type against THESE shapes, never the raw `@cloudflare/sandbox` Code
 * Interpreter types - so the Beta SDK surface (PRD §8.1) stays behind
 * `src/reports/interpreter.ts`. The only SDK type referenced here is
 * {@link CodeContext} (re-aliased as {@link CtxHandle}): it is an opaque handle a
 * caller holds and hands back to `runCode`, so leaking just the handle type (not
 * the method surface) keeps the seam intact while letting callers store a context.
 *
 * Dependency-light on purpose: Zod (for {@link ChartSpec}) + the SDK's
 * `CodeContext` type alias + the {@link ReportFrontMatter} type. MNEMO-24 (report
 * generation) extends this file with its public shapes ({@link ReportInput},
 * {@link ChartAsset}, {@link GeneratedReport}) so the reporting contract lives in
 * one place.
 */
import type { CodeContext } from "@cloudflare/sandbox";
import { z } from "zod";
import type { FindingsDelta } from "./delta.ts";
import type { Findings } from "./findings.ts";
import type { ReportFrontMatter } from "./front-matter.ts";

/**
 * Opaque per-agent Python context handle. Created once per agent by
 * {@link CodeInterpreter.getContext} and reused across a run so matplotlib/pandas
 * imports (and any loaded dataframes) persist - the warm sandbox amortizes the
 * import cost (PRD §6.4/§7.3). Callers treat it as a token: get it, pass it to
 * `runCode`, never inspect it.
 */
export type CtxHandle = CodeContext;

/** A Python-level error surfaced by the interpreter (normalized from the SDK). */
export interface RunError {
  /** Error class name, e.g. `NameError`, `ValueError`. */
  name: string;
  /** Human-readable message. */
  message: string;
  /** Stack trace lines, if the kernel provided them. */
  traceback?: string[];
}

/**
 * One rich output of a code execution. Mirrors the subset of the SDK's result
 * shape this module cares about: `text` for stdout-ish reprs and `png` for a
 * base64-encoded image (the chart pipeline reads `png`). Kept as a plain
 * structural type so `src/reports/` callers don't import the SDK's `Result`.
 */
export interface RichResult {
  /** Plain-text representation, if any. */
  text?: string;
  /** Base64-encoded PNG image data, if the result is an image. */
  png?: string;
  /** Base64-encoded JPEG image data, if any. */
  jpeg?: string;
  /** Raw SVG markup, if the result is a vector image. */
  svg?: string;
}

/**
 * Normalized result of {@link CodeRunner.runCode} - the stable shape every
 * reporting caller depends on, independent of the SDK's `ExecutionResult`.
 * `error` is `null` on success (NOT thrown - a Python error is a normal result,
 * like a non-zero shell exit in {@link import("../sandbox/client.ts")}). Rich
 * outputs (charts, tables) ride in `results`.
 */
export interface RunResult {
  /** Accumulated stdout, joined into one string. */
  stdout: string;
  /** Accumulated stderr, joined into one string. */
  stderr: string;
  /** Python execution error, or `null` if the cell ran cleanly. */
  error: RunError | null;
  /** Rich outputs (e.g. an `image/png` chart) the cell produced. */
  results: RichResult[];
}

/**
 * The minimal code-execution surface the chart pipeline + python-env bootstrap
 * consume. {@link CodeInterpreter} implements it; tests inject a fake. Declaring
 * the dependency structurally (not as the concrete class) keeps `charts.ts` and
 * `python-env.ts` unit-testable WITHOUT a sandbox.
 */
export interface CodeRunner {
  runCode(ctx: CtxHandle, code: string): Promise<RunResult>;
}

/**
 * The brain-FS binary-write surface the chart pipeline persists PNGs through -
 * satisfied by the MNEMO-06 {@link import("../sandbox/client.ts").SandboxClient}
 * (`writeFileBytes` + `mkdir`). Injected (not imported concretely) so a test can
 * spy on the write without a container; `mkdir` is optional so a writer that
 * auto-creates parents can omit it.
 */
export interface BrainFileWriter {
  /** Write raw bytes to an absolute sandbox path (binary-safe). */
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Ensure a directory exists (`mkdir -p`); optional. */
  mkdir?(path: string): Promise<void>;
}

// ─── Chart specification ──────────────────────────────────────────────────────

/** One named data series of numeric values (a line, a bar group, scatter ys). */
const ChartSeries = z.object({
  name: z.string().optional().describe("Legend label for this series."),
  values: z
    .array(z.number())
    .min(1)
    .describe("The series' numeric values (y-axis)."),
  x: z
    .array(z.number())
    .optional()
    .describe("Optional explicit x positions (scatter); defaults to index."),
});

/**
 * The small, Zod-typed description of a chart the {@link import("./charts.ts")}
 * pipeline renders to PNG. Shared with MNEMO-24 report generation. Deliberately
 * minimal - four chart kinds cover the research-report needs (trend, comparison,
 * correlation, composition); richer styling is the renderer's deterministic job,
 * not the spec's.
 */
export const ChartSpec = z.object({
  kind: z
    .enum(["line", "bar", "scatter", "pie"])
    .describe("The chart type to render."),
  title: z.string().min(1).describe("Chart title (rendered above the plot)."),
  series: z
    .array(ChartSeries)
    .min(1)
    .describe("One or more data series. A pie uses the first series' values."),
  labels: z
    .array(z.string())
    .optional()
    .describe("Category labels (x-axis ticks, or pie slice labels)."),
  xLabel: z.string().optional().describe("X-axis label."),
  yLabel: z.string().optional().describe("Y-axis label."),
});

/** The inferred TypeScript shape of {@link ChartSpec}. */
export type ChartSpecData = z.infer<typeof ChartSpec>;

// ─── Report generation surface (MNEMO-24) ────────────────────────────────────

/**
 * One section of a report body: a heading, markdown prose, and an OPTIONAL chart.
 * When `chart` is present the markdown assembler renders it to PNG (via MNEMO-23's
 * `renderChartPng`) and inserts an `![title](assets/<file>.png)` image at the
 * section. Bodies may themselves contain `[[wikilinks]]` back into the brain.
 */
export interface ReportSection {
  /** Section heading (rendered as a `##` heading). */
  heading: string;
  /** The section's prose, markdown allowed. */
  body: string;
  /** Optional chart rendered to an embedded PNG for this section. */
  chart?: ChartSpecData;
}

/**
 * The assembled input to `buildReportMarkdown` / `generateReport`: the front matter
 * plus an ordered list of {@link ReportSection}s, plus `related` neuron names that
 * become `[[wikilink]]`s in a "Related" section so the report is a first-class
 * neuron in the brain graph (PRD §6.2). The caller assembles this from the agent's
 * memory; the MNEMO-26 delta seam will pre-filter sections to *what changed*.
 */
export interface ReportInput {
  /** Obsidian front matter (title/template/tags/provenance). */
  frontMatter: ReportFrontMatter;
  /** Ordered report body sections. */
  sections: ReportSection[];
  /** Brain neuron names/slugs to link back to (rendered as `[[wikilink]]`s). */
  related?: string[];
  /**
   * MNEMO-26 seam: the structured {@link Findings} this report is built from. When
   * present the markdown assembler embeds them as a fenced ` ```mnemosyne-findings `
   * JSON block, so the NEXT scheduled run can diff against this report (the round-trip
   * baseline). Absent for a plain MNEMO-24 report that isn't part of a delta chain.
   */
  findings?: Findings;
  /**
   * MNEMO-26 seam: the precomputed delta this report leads with. When present its
   * headline + counts ride along into the `report.generated` audit payload so the
   * glass cockpit shows *why* a report fired. Set by `generateDeltaReport`; absent
   * for a standalone report.
   */
  delta?: FindingsDelta;
}

/**
 * A rendered chart PNG carried alongside the report. `bytes` are kept (not just
 * the path) so MNEMO-25 can upload to R2 / inline for email+SMS without re-reading
 * the brain FS; `path` is the absolute brain-FS path the PNG was written to.
 */
export interface ChartAsset {
  /** Absolute brain-FS path the PNG was written to (`/brain/reports/assets/...`). */
  path: string;
  /** The PNG bytes (for downstream embedding - MNEMO-25). */
  bytes: Uint8Array;
  /** The chart title (used as the image alt text + audit summary). */
  title: string;
}

/**
 * The result of `generateReport`: the composed markdown, the (parsed) front matter,
 * the brain-FS path the `.md` was persisted to, and the chart assets (with bytes)
 * for MNEMO-25's R2 archive / inline-embed step. R2 upload itself is NOT done here.
 */
export interface GeneratedReport {
  /** The full report markdown (front matter + body + embedded image refs). */
  markdown: string;
  /** The report's front matter. */
  frontMatter: ReportFrontMatter;
  /** Absolute brain-FS path of the persisted `.md` (`/brain/reports/<slug>-<ts>.md`). */
  brainPath: string;
  /** Rendered chart PNGs carried for downstream embedding (MNEMO-25). */
  assets: ChartAsset[];
}
