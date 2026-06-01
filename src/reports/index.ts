/**
 * Public surface of the reporting module (MNEMO-23).
 *
 * Track E foundation: persistent per-agent Python contexts (the Sandbox Code
 * Interpreter) + a chart→PNG pipeline. PRD §6.4/§7.3/§8.1. ALL Sandbox Code
 * Interpreter access (the Beta `createCodeContext`/`runCode`) is isolated to
 * `interpreter.ts` - the single seam the §8.1 caveat is pinned to. Charts always
 * converge on PNG bytes (the one artifact that embeds across web, email, and SMS).
 *
 * MNEMO-24 (report generation) imports from here.
 */
export {
  archiveReport,
  getReportAsset,
  getReportMarkdown,
  type ReportRecord,
  reportPrefix,
  SAFE_ASSET_FILE,
} from "./archive.ts";
export {
  emitChartRendered,
  emitReportGenerated,
  type ReportDeltaInfo,
  type ReportGeneratedInfo,
} from "./audit.ts";
export {
  buildChartCode,
  buildSvgToPngCode,
  type ChartRenderDeps,
  ReportError,
  renderChartPng,
  slugify,
  svgToPng,
} from "./charts.ts";
export {
  diffFindings,
  type FactChange,
  type FindingsDelta,
  normalizeValue,
  summarizeDelta,
} from "./delta.ts";
export {
  buildDeltaReportInput,
  type ComputeCurrentFindings,
  type DeltaReportDeps,
  type DeltaReportOpts,
  generateDeltaReport,
  type LoadPriorFindings,
  type ReportGenerator,
} from "./delta-report.ts";
export {
  canonicalizeFindings,
  Fact,
  FINDINGS_FENCE,
  Findings,
  type FindingsFromMemoryDeps,
  type FindingsScope,
  type FindingsSource,
  findingsBlock,
  findingsFromMemory,
  findingsFromReport,
  groupBySection,
  parseFindingsBlock,
  SandboxFindingsSource,
  serializeFindings,
} from "./findings.ts";
export {
  ReportFrontMatter,
  serializeFrontMatter,
} from "./front-matter.ts";
export {
  type ArchivedReport,
  type GenerateReportDeps,
  generateAndArchiveReport,
  generateReport,
} from "./generate.ts";
export {
  CodeInterpreter,
  getCodeInterpreter,
  type InterpreterSandbox,
  type RawExecutionResult,
} from "./interpreter.ts";
export {
  type BuildReportDeps,
  buildReportMarkdown,
} from "./markdown.ts";
export { ensureCharting, ensureSvg } from "./python-env.ts";
export {
  type BrainFileWriter,
  type ChartAsset,
  ChartSpec,
  type ChartSpecData,
  type CodeRunner,
  type CtxHandle,
  type GeneratedReport,
  type ReportInput,
  type ReportSection,
  type RichResult,
  type RunError,
  type RunResult,
} from "./types.ts";
