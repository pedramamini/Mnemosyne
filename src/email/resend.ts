/**
 * Resend transactional email - the magic-link send (MNEMO-03) and the
 * report-ready/update notification (MNEMO-28).
 *
 * Returns a typed `SendResult` and never throws on a non-2xx response: a failed
 * send must not leak through the auth route (which always answers 200 to avoid
 * email enumeration) nor block report archival (the notify path is best-effort).
 * Callers decide what to do with `{ ok: false }`.
 */
import type { Env } from "../env.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// Resend requires a verified sender domain; swap this for the production
// address once the domain is verified in the Resend dashboard.
const FROM_ADDRESS = "Mnemosyne <login@mnemosyne.app>";

// Report notifications send from a notifications mailbox (not the login one).
// Same verified-domain caveat applies - swap once the domain is verified.
const REPORTS_FROM_ADDRESS = "Mnemosyne <reports@mnemosyne.app>";

// Stable Content-ID for the inline hero chart. The HTML references it as
// `cid:<HERO_CHART_CID>`; the attachment carries the matching `content_id`, so
// the PNG renders in-client where an embedded SVG / external <img> would not
// (PRD §6.4 - the PNG is the one artifact that embeds across web AND email).
const HERO_CHART_CID = "mnemosyne-hero-chart";

export type SendResult = { ok: true } | { ok: false; error: string };

/** Minimal HTML body - one prominent link, plus the raw URL as a fallback. */
function magicLinkHtml(url: string): string {
  return [
    "<p>Click to sign in to Mnemosyne:</p>",
    `<p><a href="${url}">Sign in</a></p>`,
    "<p>This link is single-use and expires in 15 minutes.</p>",
    `<p>If the button doesn't work, paste this URL:<br>${url}</p>`,
  ].join("");
}

/**
 * POST a magic-link email to Resend. Surfaces transport and non-2xx failures as
 * `{ ok: false, error }` rather than throwing.
 */
export async function sendMagicLink(
  env: Env,
  email: string,
  url: string,
): Promise<SendResult> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: "Your Mnemosyne sign-in link",
        html: magicLinkHtml(url),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `resend ${res.status}: ${detail}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Report notification (MNEMO-28) ───────────────────────────────────────────

/** The inline hero chart carried into a report notification. */
export interface HeroChart {
  /** PNG filename (e.g. `funding-by-year.png`) - the attachment's `filename`. */
  filename: string;
  /** Raw PNG bytes; base64-encoded into the Resend attachment. */
  pngBytes: Uint8Array;
}

/** Inputs for {@link sendReportNotification}. */
export interface ReportNotificationOpts {
  /** Owner email address (the agent's account email). */
  to: string;
  /** The agent's display name (subject prefix). */
  agentName: string;
  /** The report title. */
  reportTitle: string;
  /** One-line delta headline, or "New report" for a first-run baseline. */
  deltaHeadline: string;
  /** Deep link to the full web report (`.../agents/:id/reports/:reportId`). */
  reportUrl: string;
  /** Optional hero chart embedded inline (via `cid:`) AND attached. */
  heroChart?: HeroChart;
}

/** Base64-encode raw bytes (no Buffer in the Workers runtime - mirrors secrets.ts). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Escape the five HTML-significant chars so an agent/report title can't break the body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The notification body - deliberately a SHORT notice, not the report itself
 * (PRD §6.4): headline + one-paragraph summary + the inline hero chart (when
 * present) + a deep link to the full web report. User-controlled strings are
 * HTML-escaped; the `reportUrl` is platform-built (ids only) so it is safe.
 */
function reportNotificationHtml(opts: ReportNotificationOpts): string {
  const agent = escapeHtml(opts.agentName);
  const title = escapeHtml(opts.reportTitle);
  const headline = escapeHtml(opts.deltaHeadline);
  const parts = [
    `<p>Your agent <strong>${agent}</strong> just published <strong>${title}</strong>.</p>`,
    `<p>${headline}</p>`,
  ];
  if (opts.heroChart) {
    parts.push(
      `<p><img src="cid:${HERO_CHART_CID}" alt="${title}" style="max-width:100%;height:auto;"></p>`,
    );
  }
  parts.push(`<p><a href="${opts.reportUrl}">View the full report</a></p>`);
  parts.push(
    `<p>If the button doesn't work, paste this URL:<br>${opts.reportUrl}</p>`,
  );
  return parts.join("");
}

/**
 * POST a report-ready/update notification to Resend. The subject is
 * `[<agentName>] <reportTitle> - <deltaHeadline>`; the body is a short notice with
 * a deep link to the full web report and, when `heroChart` is present, the chart
 * PNG as an inline attachment referenced via `cid:` (so it renders in-client).
 *
 * Mirrors {@link sendMagicLink}: surfaces transport / non-2xx failures as
 * `{ ok: false, error }` rather than throwing - the notify path is best-effort and
 * must never fail an already-archived report.
 */
export async function sendReportNotification(
  env: Env,
  opts: ReportNotificationOpts,
): Promise<SendResult> {
  try {
    const body: Record<string, unknown> = {
      from: REPORTS_FROM_ADDRESS,
      to: [opts.to],
      subject: `[${opts.agentName}] ${opts.reportTitle} - ${opts.deltaHeadline}`,
      html: reportNotificationHtml(opts),
    };
    if (opts.heroChart) {
      // A Resend attachment with a `content_id` is referenceable inline via
      // `cid:<content_id>` (the REST API uses snake_case fields).
      body.attachments = [
        {
          filename: opts.heroChart.filename,
          content: toBase64(opts.heroChart.pngBytes),
          content_type: "image/png",
          content_id: HERO_CHART_CID,
        },
      ];
    }

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `resend ${res.status}: ${detail}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
