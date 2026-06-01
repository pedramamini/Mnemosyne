/**
 * Report generation orchestrator (MNEMO-24).
 *
 * `generateReport` is the on-demand / scheduled entry point that turns an assembled
 * {@link ReportInput} into a finished, persisted report artifact (PRD §6.4):
 *
 *   1. (findings) - the caller hands in the assembled `ReportInput` (front matter +
 *      sections drawn from the agent's memory via the MNEMO-09/10 layer). The
 *      `// MNEMO-26` seam below is where delta logic will pre-filter to *what changed*.
 *   2. ensure the agent's persistent Code Interpreter context + charting bootstrap
 *      (MNEMO-23 `getContext` + `ensureCharting`).
 *   3. assemble the markdown + chart PNGs (`buildReportMarkdown`).
 *   4. persist the `.md` to `/brain/reports/<slug>-<ts>.md` (the chart PNGs were
 *      already written under `assets/` by `renderChartPng`) via the MNEMO-06
 *      `writeFile` wrapper.
 *   5. emit `report.generated` (milestone) and return `{ markdown, frontMatter,
 *      brainPath, assets }`.
 *
 * It does NOT upload to R2 - that is MNEMO-25, which reads back `assets[]` (bytes
 * carried) + `brainPath`. The Code Interpreter + brain-FS client + audit emitter are
 * all injectable (`deps`) so the orchestrator runs headless in tests without a
 * container, mirroring `src/memory/write.ts`'s injection pattern.
 */
import type { AuditEmitter } from "../audit/index.ts";
import { notifyReportReady, type ReadyReport } from "../email/report-notify.ts";
import type { Env } from "../env.ts";
import { REPORTS_DIR } from "../memory/layout.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import { archiveReport, type ReportRecord } from "./archive.ts";
import { emitReportGenerated, type ReportDeltaInfo } from "./audit.ts";
import { slugify } from "./charts.ts";
import { type FindingsDelta, summarizeDelta } from "./delta.ts";
import { type CodeInterpreter, getCodeInterpreter } from "./interpreter.ts";
import { buildReportMarkdown } from "./markdown.ts";
import { ensureCharting } from "./python-env.ts";
import type { CtxHandle, GeneratedReport, ReportInput } from "./types.ts";

/**
 * Reduce a precomputed {@link FindingsDelta} (MNEMO-26) to the audit summary the
 * `report.generated` payload carries - the headline + the add/change/remove counts
 * - so the glass cockpit shows *why* a report fired. Returns `undefined` for a
 * standalone report with no delta.
 */
function deltaInfo(
  delta: FindingsDelta | undefined,
): ReportDeltaInfo | undefined {
  if (!delta) return undefined;
  return {
    headline: summarizeDelta(delta).headline,
    added: delta.added.length,
    changed: delta.changed.length,
    removed: delta.removed.length,
  };
}

/**
 * Injectable collaborators. In production each defaults to the per-agent resolver;
 * a test passes a mocked `CodeInterpreter` (returns a known PNG) + a spy brain-FS
 * `sandbox` + a spy `emitter`. `interpreter` must expose `getContext` + `runCode`
 * (the concrete {@link CodeInterpreter}); `sandbox` must expose `writeFile` (for the
 * `.md`) + `writeFileBytes`/`mkdir` (for the chart PNGs - it is the chart writer).
 */
export interface GenerateReportDeps {
  /** Per-agent Code Interpreter (context cache + `runCode`); defaults via env. */
  interpreter?: CodeInterpreter;
  /** Brain-FS client the `.md` + chart PNGs are written through; defaults via env. */
  sandbox?: SandboxClient;
  /** Optional per-run audit emitter (emits `report.generated` + per-chart events). */
  emitter?: AuditEmitter;
  /**
   * When `false`, suppress the brain-FS-only `report.generated` emit so the
   * caller can emit ONE finalized event after a later step. Defaults to emitting
   * (the standalone path). {@link generateAndArchiveReport} sets this so the
   * combined flow emits exactly one event carrying the real `r2Key`/`reportId`.
   */
  emitGenerated?: boolean;
  /**
   * MNEMO-28: fire-and-forget scheduler for the post-archive owner notification.
   * In a Worker pass `ctx.waitUntil`; in a DO pass `this.ctx.waitUntil` - so the
   * email send outlives the handler's return WITHOUT delaying the response. When
   * omitted, the notification is awaited inline (still best-effort - it never
   * throws), which is correct (just slower) for tests / a caller without a ctx.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * MNEMO-28: the owner-notification hook (default {@link notifyReportReady}).
   * Injected as a spy in tests; runs only on the {@link generateAndArchiveReport}
   * (post-archive) path, never on the brain-FS-only {@link generateReport}.
   */
  notify?: (env: Env, agentId: string, report: ReadyReport) => Promise<void>;
}

/**
 * Generate + persist a report from an assembled {@link ReportInput}. Returns the
 * composed markdown, the front matter, the brain-FS path of the `.md`, and the
 * chart assets (with bytes) for MNEMO-25's R2 archive / inline-embed step.
 */
export async function generateReport(
  env: Env,
  agentId: string,
  input: ReportInput,
  deps: GenerateReportDeps = {},
): Promise<GeneratedReport> {
  // (a) Findings + delta (MNEMO-26 seam, filled): when the caller is
  // `generateDeltaReport` it has already diffed remembered prior state vs. current
  // and handed us a `ReportInput` that LEADS with the delta and carries `findings`
  // (embedded by the markdown assembler below, so the next run diffs against this
  // one) + `delta` (folded into the audit payload). A standalone MNEMO-24 report
  // omits both and passes through unchanged.

  // (b) Ensure the agent's persistent Python context + deterministic charting env.
  const interpreter = deps.interpreter ?? getCodeInterpreter(env, agentId);
  const sandbox = deps.sandbox ?? getSandbox(env, agentId);
  const ctx: CtxHandle = await interpreter.getContext(agentId);
  await ensureCharting(interpreter, ctx);

  // (c) Assemble markdown + render/persist the chart PNGs (under assets/).
  const { markdown, assets } = await buildReportMarkdown(input, {
    interp: interpreter,
    ctx,
    writer: sandbox,
    emitter: deps.emitter,
  });

  // (d) Persist the `.md` to /brain/reports/<slug>-<ts>.md via the MNEMO-06 wrapper.
  // The chart PNGs were already written under assets/ by renderChartPng. Ensure the
  // reports dir exists (idempotent) so a never-warmed brain doesn't fail the write.
  const slug = slugify(input.frontMatter.title, "report");
  const brainPath = `${REPORTS_DIR}/${slug}-${Date.now()}.md`;
  await sandbox.mkdir(REPORTS_DIR);
  await sandbox.writeFile(brainPath, markdown);

  // (e) Audit + return. report.generated (milestone) carries the title + brainPath;
  // the combined flow (generateAndArchiveReport) suppresses this and re-emits with
  // the real r2Key once the artifact lifts to R2. Best-effort (the emitter swallows
  // its own failures - audit is observability, §7.1).
  if (deps.emitGenerated !== false) {
    await emitReportGenerated(deps.emitter, {
      title: input.frontMatter.title,
      brainPath,
      delta: deltaInfo(input.delta),
    });
  }

  return { markdown, frontMatter: input.frontMatter, brainPath, assets };
}

/**
 * The result of {@link generateAndArchiveReport}: the {@link GeneratedReport} plus
 * the persisted D1 {@link ReportRecord} (its id + R2 prefix). Callers that only need
 * the markdown can read the spread fields; the report list/viewer reads `record`.
 */
export interface ArchivedReport extends GeneratedReport {
  /** The persisted D1 metadata row (id, r2_key, front_matter, created_at). */
  record: ReportRecord;
}

/**
 * The §6.4 happy path in one call: generate → persist-to-brain → archive-to-R2 →
 * record-in-D1. Runs {@link generateReport} (brain-FS only, audit emit SUPPRESSED),
 * lifts the artifact to R2 + records the D1 row via {@link archiveReport}, then
 * emits the ONE finalized `report.generated` milestone carrying the real
 * `r2Key`/`reportId`. `generateReport` stays callable on its own (tests); archiving
 * is the additive step layered here.
 */
export async function generateAndArchiveReport(
  env: Env,
  agentId: string,
  input: ReportInput,
  deps: GenerateReportDeps = {},
): Promise<ArchivedReport> {
  const generated = await generateReport(env, agentId, input, {
    ...deps,
    emitGenerated: false,
  });
  const record = await archiveReport(env, agentId, generated);

  // Finalize the audit milestone now that the artifact is durable: one
  // report.generated carrying the brain path AND the real R2 key + report id.
  await emitReportGenerated(deps.emitter, {
    title: generated.frontMatter.title,
    brainPath: generated.brainPath,
    r2Key: record.r2_key,
    reportId: record.id,
    delta: deltaInfo(input.delta),
  });

  const archived: ArchivedReport = { ...generated, record };

  // MNEMO-28: notify the owner the report is ready/updated. Fire-and-forget (via
  // the injected ctx.waitUntil) so the email never delays the caller, and
  // best-effort (notifyReportReady wraps its own send + audits the outcome) so it
  // can NEVER fail the already-durable report. Carries `input.delta` so the email
  // headline reflects what changed. Awaited inline when no scheduler is injected.
  const notify = deps.notify ?? notifyReportReady;
  const notifying = notify(env, agentId, { ...archived, delta: input.delta });
  if (deps.waitUntil) deps.waitUntil(notifying);
  else await notifying;

  return archived;
}
