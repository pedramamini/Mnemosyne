/**
 * Report-ready/update notification glue (MNEMO-28, PRD §6.4).
 *
 * `notifyReportReady` is the seam between the report lifecycle (MNEMO-24/25/26)
 * and the Resend transport ({@link sendReportNotification}). When a report is
 * generated or updated, the agent's OWNER is emailed a short notice: the delta
 * headline in the subject/body, the hero chart PNG embedded inline, and a deep
 * link to the full web report.
 *
 * Contract (the §6.4 promises this upholds):
 *   - it is a NOTIFICATION, not the report - short body + a deep link, never the
 *     full markdown;
 *   - it is BEST-EFFORT - the whole thing is wrapped so a send (or owner-lookup)
 *     failure is logged + audited but NEVER propagates, so it can't fail an
 *     already-durable report (callers fire it via `ctx.waitUntil`);
 *   - only "report ready/update" triggers it - the MNEMO-26 skip path (no report
 *     produced) never reaches here, so an unchanged run sends no email.
 *
 * Every collaborator (owner resolver, send transport, audit emitter) is injectable
 * so the glue is unit-testable without a real email send, mirroring the injection
 * pattern across `src/reports/` and `src/memory/`.
 */
import {
  type AuditEmitTarget,
  AuditEmitter,
  getAuditStub,
} from "../audit/index.ts";
import { getAccount, getAgent } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { FindingsDelta } from "../reports/delta.ts";
import { summarizeDelta } from "../reports/delta.ts";
import type { ArchivedReport } from "../reports/generate.ts";
import type { ChartAsset } from "../reports/types.ts";
import {
  type HeroChart,
  type ReportNotificationOpts,
  type SendResult,
  sendReportNotification,
} from "./resend.ts";

/**
 * What {@link notifyReportReady} is handed: the archived report (markdown, front
 * matter, chart assets, and the D1 {@link ArchivedReport.record} that yields the
 * report id for the deep link), plus the optional findings {@link FindingsDelta}
 * it led with - present for a MNEMO-26 delta report, absent for a baseline. The
 * delta drives the subject/body headline (via {@link summarizeDelta}).
 */
export type ReadyReport = ArchivedReport & { delta?: FindingsDelta };

/** The agent's owner, resolved for a notification. */
export interface ReportOwner {
  /** Owner email (the agent's account email). */
  email: string;
  /** Agent display name (the subject prefix). */
  agentName: string;
}

/** Injectable collaborators for {@link notifyReportReady}. */
export interface NotifyReportDeps {
  /**
   * Owner resolver - agent → `account_id` → `accounts.email` (+ the agent's
   * name). Defaults to {@link resolveReportOwner}. Returns `null` when the agent
   * or its account is missing (the notify then no-ops, audited).
   */
  resolveOwner?: (env: Env, agentId: string) => Promise<ReportOwner | null>;
  /** Send transport (default: {@link sendReportNotification}). */
  send?: (env: Env, opts: ReportNotificationOpts) => Promise<SendResult>;
  /**
   * Audit emitter for the outcome (a milestone narration on success, an `error`
   * on failure). Defaults to a fresh emitter forwarding to the agent's AuditLog
   * DO. Tests inject a spy.
   */
  emitter?: AuditEmitter;
}

/** Build the deep link to the full web report (`.../agents/:id/reports/:reportId`). */
function buildReportUrl(
  baseUrl: string,
  agentId: string,
  reportId: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/agents/${agentId}/reports/${reportId}`;
}

/** The basename (last path segment) of an absolute brain-FS asset path. */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Pick the hero chart: the FIRST chart asset carried on the report (bytes ride
 * inline from MNEMO-24, so this never re-reads R2/the brain FS), or `undefined`
 * when the report has no charts (a text-only report sends with no embedded image).
 */
function pickHeroChart(assets: ChartAsset[]): HeroChart | undefined {
  const first = assets[0];
  if (!first) return undefined;
  return { filename: basename(first.path), pngBytes: first.bytes };
}

/**
 * The delta headline for the subject/body: MNEMO-26's {@link summarizeDelta} when
 * the report led with a findings delta, else "New report" for a baseline (a
 * standalone report with no delta chain).
 */
function deltaHeadline(delta: FindingsDelta | undefined): string {
  if (!delta) return "New report";
  return summarizeDelta(delta).headline;
}

/**
 * Default owner resolver: agent → `account_id` → `accounts.email`, plus the
 * agent's display name. `null` when either row is absent (a deleted agent /
 * account - the notify no-ops rather than emailing nowhere).
 */
export async function resolveReportOwner(
  env: Env,
  agentId: string,
): Promise<ReportOwner | null> {
  const agent = await getAgent(env, agentId);
  if (!agent) return null;
  const account = await getAccount(env, agent.account_id);
  if (!account) return null;
  return { email: account.email, agentName: agent.name };
}

/**
 * Whether the owner wants report notifications. Default ON.
 *
 * // preferences: MNEMO-05 settings do not yet carry a notification toggle. When
 * they do, read the per-agent / per-account preference here (default on) and
 * return false to suppress the email without touching the call sites.
 */
function notificationsEnabled(_env: Env, _agentId: string): boolean {
  return true;
}

/**
 * Notify the agent's owner that a report is ready/updated. Resolves the owner
 * email, builds the deep link + picks the hero chart, sends via Resend, and
 * audits the outcome. The whole body is wrapped so a failure is logged + audited
 * but NEVER throws - callers fire it as `ctx.waitUntil(notifyReportReady(...))`.
 */
export async function notifyReportReady(
  env: Env,
  agentId: string,
  report: ReadyReport,
  deps: NotifyReportDeps = {},
): Promise<void> {
  const emitter =
    deps.emitter ??
    AuditEmitter.withSession(
      // The native RPC stub can't type `emit` (MNEMO-22 seam); cast through the
      // structural target, mirroring MnemosyneAgent.auditSink.
      getAuditStub(env, agentId) as unknown as AuditEmitTarget,
      null,
    );
  const resolveOwner = deps.resolveOwner ?? resolveReportOwner;
  const send = deps.send ?? sendReportNotification;

  try {
    // preferences seam (default on): an opted-out owner gets no email.
    if (!notificationsEnabled(env, agentId)) return;

    const owner = await resolveOwner(env, agentId);
    if (!owner) {
      await emitter.error(
        "Report ready, but owner email could not be resolved",
        {
          agentId,
          reportId: report.record.id,
        },
      );
      return;
    }

    const reportUrl = buildReportUrl(
      env.APP_BASE_URL,
      agentId,
      report.record.id,
    );
    const headline = deltaHeadline(report.delta);
    const result = await send(env, {
      to: owner.email,
      agentName: owner.agentName,
      reportTitle: report.frontMatter.title,
      deltaHeadline: headline,
      reportUrl,
      heroChart: pickHeroChart(report.assets),
    });

    if (result.ok) {
      // Milestone-level narration so the "report emailed" beat surfaces in the
      // calm cockpit stream (not the info "show the work" altitude).
      await emitter.emit({
        type: "narration",
        level: "milestone",
        sessionId: null,
        text: "Emailed report to owner",
        payload: { reportId: report.record.id, reportUrl, headline },
      });
    } else {
      await emitter.error("Failed to email report to owner", {
        agentId,
        reportId: report.record.id,
        error: result.error,
      });
    }
  } catch (err) {
    // Audit is observability, not control flow (§7.1): never propagate. The
    // emitter swallows its own failures, so this best-effort audit is safe.
    await emitter.error("Report notification threw", {
      agentId,
      reportId: report.record.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
