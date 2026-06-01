/**
 * Delta-aware report orchestration (MNEMO-26).
 *
 * `generateDeltaReport` is the payoff of the memory thesis (PRD §6.4): because the
 * agent *remembers* prior state, a scheduled report is "here's what's new/changed
 * since last time," not a cold re-summary. It:
 *
 *   1. loads the PRIOR report's findings for this agent/scope (most recent matching
 *      report from the MNEMO-25 R2 archive; none ⇒ prior is empty ⇒ a full baseline);
 *   2. computes the CURRENT findings from the agent's neurons ({@link findingsFromMemory});
 *   3. diffs them ({@link diffFindings}) into a typed {@link FindingsDelta};
 *   4. builds a {@link ReportInput} that LEADS with a "What changed" section (and a
 *      prior-vs-current chart for numeric changes), embedding the current findings so
 *      the NEXT run diffs against this one (the round-trip baseline);
 *   5. calls the existing MNEMO-24/25 generator (`generateAndArchiveReport`).
 *
 * When the delta `isEmpty` and `opts.skipWhenUnchanged` is set (the scheduled-run
 * default), it returns `null` and emits a milestone narration "No material changes -
 * skipped report" instead of generating noise - protecting the §6.4 promise that a
 * scheduled report surfaces *change*, not churn.
 *
 * Every collaborator is injectable (the prior loader, the current-findings derivation,
 * the generator, the emitter) so the orchestration is unit-testable without a
 * container or R2 - mirroring the injection pattern across `src/reports/`.
 */
import type { AuditEmitter } from "../audit/index.ts";
import { type AgentTemplate, listReportsByAgent } from "../db/index.ts";
import type { Env } from "../env.ts";
import { getReportMarkdown } from "./archive.ts";
import { diffFindings, type FindingsDelta, summarizeDelta } from "./delta.ts";
import {
  type Findings,
  type FindingsScope,
  findingsFromMemory,
  findingsFromReport,
} from "./findings.ts";
import { ReportFrontMatter } from "./front-matter.ts";
import {
  type ArchivedReport,
  type GenerateReportDeps,
  generateAndArchiveReport,
} from "./generate.ts";
import type {
  ChartSpecData,
  GeneratedReport,
  ReportInput,
  ReportSection,
} from "./types.ts";

/** Report-shaping options (front matter + scheduled-skip behavior). */
export interface DeltaReportOpts {
  /**
   * When `true` and the delta is empty (nothing added/removed/changed), skip
   * generation entirely (return `null` + emit the "no material changes" milestone).
   * The scheduled-run default; an on-demand "give me a report now" passes `false`.
   */
  skipWhenUnchanged?: boolean;
  /** Report title; defaults to a scope/agent-derived "<agentId> - update". */
  title?: string;
  /** Entity-template lens for the front matter (vendor/product/investor/founder). */
  template?: AgentTemplate;
  /** Obsidian tags for the front matter. */
  tags?: string[];
  /** Reporting period covered (front matter `period`). */
  period?: string;
  /** Schedule cadence (front matter `cadence`), e.g. "weekly". */
  cadence?: string;
  /** ISO timestamp the report reflects; defaults to now. */
  created?: string;
  /** Brain neuron names this report links back to (`[[wikilink]]`s). */
  related?: string[];
  /** Session id for the skip-audit event (groups it with the run); defaults null. */
  sessionId?: string | null;
}

/**
 * Load the PRIOR report's findings for `agentId`/`scope`. The contract: return the
 * findings of the most recent matching report, or `null` when there is no prior
 * report (first run ⇒ a full baseline). The default reads them back out of the
 * MNEMO-25 R2 archive.
 */
export type LoadPriorFindings = (
  env: Env,
  agentId: string,
  scope: FindingsScope,
) => Promise<Findings | null>;

/** Compute the CURRENT findings; defaults to {@link findingsFromMemory}. */
export type ComputeCurrentFindings = (
  env: Env,
  agentId: string,
  scope: FindingsScope,
) => Promise<Findings>;

/** The report generator; defaults to MNEMO-25's {@link generateAndArchiveReport}. */
export type ReportGenerator = (
  env: Env,
  agentId: string,
  input: ReportInput,
  deps: GenerateReportDeps,
) => Promise<GeneratedReport | ArchivedReport>;

/** Injectable collaborators for {@link generateDeltaReport}. */
export interface DeltaReportDeps {
  /** Prior-findings loader (default: read the most recent archived report). */
  loadPriorFindings?: LoadPriorFindings;
  /** Current-findings derivation (default: {@link findingsFromMemory}). */
  computeCurrentFindings?: ComputeCurrentFindings;
  /** Report generator (default: {@link generateAndArchiveReport}). */
  generate?: ReportGenerator;
  /** Per-run audit emitter (the skip event + the generator's `report.generated`). */
  emitter?: AuditEmitter;
  /** Deps forwarded to the generator (interpreter/sandbox - injected in tests). */
  generateDeps?: GenerateReportDeps;
}

/**
 * Generate a delta-aware report for `agentId`, or `null` when nothing material
 * changed and `opts.skipWhenUnchanged` is set. See the module doc for the flow.
 */
export async function generateDeltaReport(
  env: Env,
  agentId: string,
  scope: FindingsScope = {},
  opts: DeltaReportOpts = {},
  deps: DeltaReportDeps = {},
): Promise<GeneratedReport | ArchivedReport | null> {
  const loadPrior = deps.loadPriorFindings ?? defaultLoadPriorFindings;
  const computeCurrent =
    deps.computeCurrentFindings ?? ((e, a, s) => findingsFromMemory(e, a, s));
  const generate = deps.generate ?? generateAndArchiveReport;

  const prior = (await loadPrior(env, agentId, scope)) ?? { facts: [] };
  const current = await computeCurrent(env, agentId, scope);
  const delta = diffFindings(prior, current);
  const summary = summarizeDelta(delta);

  // Scheduled-run skip: empty delta + skipWhenUnchanged ⇒ no report, one milestone
  // narration so the cockpit records that the run happened and found nothing new.
  // MNEMO-26 skip path: NO report is produced here, so we return BEFORE the
  // generator runs - MNEMO-28's notifyReportReady (wired into the post-archive
  // path of generateAndArchiveReport) never fires. An unchanged run sends NO
  // email; only a real ready/update triggers a notification (§6.4).
  if (summary.isEmpty && opts.skipWhenUnchanged) {
    await emitNoMaterialChanges(deps.emitter, opts.sessionId ?? null, summary);
    return null;
  }

  const input = buildDeltaReportInput(
    agentId,
    delta,
    current,
    summary.headline,
    opts,
  );
  return generate(env, agentId, input, {
    ...deps.generateDeps,
    emitter: deps.emitter,
  });
}

/**
 * Assemble the {@link ReportInput} for a delta-aware report: front matter, a leading
 * "What changed" section (with a prior-vs-current chart for numeric changes), the
 * current `findings` (embedded so the next run diffs against this report), and the
 * `delta` (folded into the `report.generated` audit payload by `generateReport`).
 */
export function buildDeltaReportInput(
  agentId: string,
  delta: FindingsDelta,
  current: Findings,
  headline: string,
  opts: DeltaReportOpts,
): ReportInput {
  const created = opts.created ?? new Date().toISOString();
  const sections: ReportSection[] = [whatChangedSection(delta, headline)];

  return {
    frontMatter: ReportFrontMatter.parse({
      title: opts.title ?? `${agentId} - update`,
      type: "report",
      agentId,
      template: opts.template,
      tags: opts.tags ?? [],
      created,
      period: opts.period,
      cadence: opts.cadence,
      source_count: current.facts.length,
    }),
    sections,
    related: opts.related,
    findings: current,
    delta,
  };
}

/**
 * Build the leading "What changed" section: the headline, then New / Changed /
 * Removed bullet lists (only the non-empty ones). When any changed fact has numeric
 * prior + current values, attach a bar chart comparing prior vs current so the
 * report visualizes the movement (PRD §6.4 "charts comparing prior vs current").
 */
function whatChangedSection(
  delta: FindingsDelta,
  headline: string,
): ReportSection {
  const lines: string[] = [`_${headline}_`];

  if (delta.added.length > 0) {
    lines.push("", "### New");
    for (const f of delta.added) {
      lines.push(`- **${f.label}** (\`${f.key}\`): ${f.value}`);
    }
  }
  if (delta.changed.length > 0) {
    lines.push("", "### Changed");
    for (const c of delta.changed) {
      lines.push(`- **${c.label}** (\`${c.key}\`): ${c.from} → ${c.to}`);
    }
  }
  if (delta.removed.length > 0) {
    lines.push("", "### Removed");
    for (const f of delta.removed) {
      lines.push(`- **${f.label}** (\`${f.key}\`): ${f.value}`);
    }
  }

  const section: ReportSection = {
    heading: "What changed",
    body: lines.join("\n"),
  };
  const chart = priorVsCurrentChart(delta);
  if (chart) section.chart = chart;
  return section;
}

/**
 * A bar chart comparing the prior vs current value of each numeric changed fact, or
 * `undefined` when no changed fact has parseable numbers on both sides. Two series
 * (Prior / Current) over the changed-fact labels.
 */
function priorVsCurrentChart(delta: FindingsDelta): ChartSpecData | undefined {
  const numeric = delta.changed
    .map((c) => ({
      label: c.label,
      from: parseNumeric(c.from),
      to: parseNumeric(c.to),
    }))
    .filter(
      (c): c is { label: string; from: number; to: number } =>
        c.from !== null && c.to !== null,
    );
  if (numeric.length === 0) return undefined;
  return {
    kind: "bar",
    title: "Changed metrics: prior vs current",
    labels: numeric.map((c) => c.label),
    series: [
      { name: "Prior", values: numeric.map((c) => c.from) },
      { name: "Current", values: numeric.map((c) => c.to) },
    ],
  };
}

/**
 * Parse a numeric value out of a fact's string value, tolerating currency symbols,
 * thousands separators, and surrounding whitespace (`"$10,500"` → `10500`,
 * `"10M"` → `10`). Returns `null` when no leading number is present (a non-numeric
 * fact, which simply doesn't appear in the comparison chart).
 */
function parseNumeric(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "");
  const match = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * The default {@link LoadPriorFindings}: read the most recent archived report's
 * markdown out of R2 and extract its embedded findings block. Returns `null` when
 * the agent has no prior report (first run) or the blob is missing - both treated as
 * "no prior state" so the run produces a full baseline.
 */
async function defaultLoadPriorFindings(
  env: Env,
  agentId: string,
  _scope: FindingsScope,
): Promise<Findings | null> {
  const reports = await listReportsByAgent(env, agentId);
  if (reports.length === 0) return null;
  const latest = reports[0]; // listReportsByAgent returns newest-first
  const body = await getReportMarkdown(env, agentId, latest.id);
  if (!body) return null;
  const markdown = await body.text();
  const fm = latest.front_matter
    ? (ReportFrontMatter.safeParse(safeJsonParse(latest.front_matter)).data ??
      null)
    : null;
  return findingsFromReport(fm, markdown);
}

/** Parse JSON, returning `undefined` (not a throw) on malformed input. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Emit the milestone "No material changes - skipped report" narration when a
 * scheduled run finds nothing new. A milestone-level `narration` (via the generic
 * emit passthrough) so it surfaces in the calm cockpit stream - recording that the
 * run happened and the skip was deliberate, not a failure.
 */
function emitNoMaterialChanges(
  emitter: AuditEmitter | undefined,
  sessionId: string | null,
  summary: { headline: string },
): Promise<void> {
  if (!emitter) return Promise.resolve();
  return emitter.emit({
    type: "narration",
    level: "milestone",
    sessionId,
    text: "No material changes - skipped report",
    payload: { headline: summary.headline, skipped: true },
  });
}
