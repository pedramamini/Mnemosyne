/**
 * Audit emission seams for the reporting path (MNEMO-21).
 *
 * The report renderer (MNEMO-23) and the Code-Interpreter chart renderer
 * (MNEMO-24) land in those phases; MNEMO-21 RESERVES the two emit points now so
 * the later phases only have to pass the per-run {@link AuditEmitter} in. Both
 * helpers take an OPTIONAL emitter so a caller mid-build (or a unit test) can skip
 * auditing without a guard at every call site - the emit is best-effort and the
 * {@link AuditEmitter} already swallows failures (audit is observability, §7.1).
 *
 * Keep payloads to summaries (a title, an R2 key, a filename) - never the report
 * body or the PNG bytes (the §7.1 large-output-to-FS discipline applies here too).
 */
import type { AuditEmitter } from "../audit/index.ts";

/** Delta summary carried into the `report.generated` audit payload (MNEMO-26). */
export interface ReportDeltaInfo {
  /** One-line human headline ("3 new facts, 1 changed, 0 removed since last report"). */
  headline: string;
  /** Count of newly-added facts. */
  added: number;
  /** Count of facts whose value changed. */
  changed: number;
  /** Count of facts no longer present. */
  removed: number;
}

/** What the report generator knows when the markdown artifact is produced. */
export interface ReportGeneratedInfo {
  /** Human title of the report (shown in the audit `text`). */
  title: string;
  /** Absolute brain-FS path the `.md` was persisted to (MNEMO-24). */
  brainPath?: string;
  /** R2 prefix/key the report archive lands at - filled by MNEMO-25's archive step. */
  r2Key?: string;
  /** The persisted D1 report id - filled by MNEMO-25's archive step. */
  reportId?: string;
  /**
   * MNEMO-26 delta summary - present when this report was driven off a findings
   * delta, so the glass cockpit shows *why* a report fired (what changed since last
   * time), not just that one did. Omitted for a standalone (non-delta) report.
   */
  delta?: ReportDeltaInfo;
}

/**
 * MNEMO-24: call where the report markdown artifact is produced + persisted to the
 * brain FS. Emits `report.generated` (milestone) with the title + the brain path.
 * MNEMO-25's `generateAndArchiveReport` calls this ONCE more after the R2 archive,
 * now carrying the real `r2Key`/`reportId` (both `null` until the artifact lifts
 * to R2 in the brain-FS-only `generateReport` path).
 */
export function emitReportGenerated(
  emitter: AuditEmitter | undefined,
  info: ReportGeneratedInfo,
): Promise<void> {
  if (!emitter) return Promise.resolve();
  // Lead the audit text with the delta headline when one is present, so the calm
  // milestone stream reads "what changed" rather than a generic "generated" line.
  const text = info.delta
    ? `Generated report: ${info.title} - ${info.delta.headline}`
    : `Generated report: ${info.title}`;
  return emitter.reportGenerated(text, {
    title: info.title,
    brainPath: info.brainPath ?? null,
    r2Key: info.r2Key ?? null,
    reportId: info.reportId ?? null,
    // MNEMO-26: the delta headline + counts ride along so the cockpit shows why.
    delta: info.delta ?? null,
  });
}

/** What the chart renderer knows when a PNG is produced. */
export interface ChartRenderedInfo {
  /** Human title of the chart. */
  title: string;
  /** The PNG filename (e.g. `funding-by-year.png`) the renderer wrote. */
  filename: string;
  /** Absolute brain-FS path the PNG was saved at (`/brain/reports/assets/...`). */
  path?: string;
}

/**
 * MNEMO-23: call where the Code Interpreter renders a chart to PNG. Emits
 * `chart.rendered` (info - "show the work") with the chart title + the saved
 * filename/path. Wired by `src/reports/charts.ts:renderChartPng` after a
 * successful PNG render (the emitter is optional + best-effort, §7.1).
 */
export function emitChartRendered(
  emitter: AuditEmitter | undefined,
  info: ChartRenderedInfo,
): Promise<void> {
  if (!emitter) return Promise.resolve();
  return emitter.chartRendered(
    `Rendered chart: ${info.title} (${info.filename})`,
    { title: info.title, filename: info.filename, path: info.path ?? null },
  );
}
