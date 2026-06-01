/**
 * Report archive + retrieval (MNEMO-25, PRD §6.4/§7.4).
 *
 * The brain-FS copy of a report (MNEMO-24) is the git-versioned WORKING copy; R2
 * is the durable STORE OF RECORD for the published artifact. This module lifts a
 * {@link GeneratedReport} into R2 and records its metadata in D1:
 *
 *   - One R2 "prefix" per report - `agents/<agentId>/reports/<reportId>/` - holding
 *     `report.md` (`text/markdown`) + `assets/<file>.png` (`image/png`), so a report
 *     is a self-contained object group. The prefix is derived from `agentId`/
 *     `reportId` ONLY (never model/user input), so a hostile title can't shape an
 *     R2 key. Asset filenames are the basename of each {@link ChartAsset.path}, which
 *     our renderer slugifies - re-validated here against {@link SAFE_ASSET_FILE} as
 *     defense in depth.
 *   - A D1 `reports` row (MNEMO-02 `createReport`) carrying `r2_key` = the prefix and
 *     `front_matter` = the serialized JSON front matter. D1 holds metadata ONLY (no
 *     blobs) so the list/search UI never enumerates R2.
 *
 * The read side ({@link getReportMarkdown}/{@link getReportAsset}) is the inverse:
 * look up the ownership-checked D1 record, resolve the R2 key off its prefix, and
 * return the object body (or null). The route handlers (`src/reports/routes.ts`)
 * stay thin over these so the R2-key derivation lives in ONE place.
 */
import { createReport, getReport, type ReportRow } from "../db/index.ts";
import type { Env } from "../env.ts";
import type { GeneratedReport } from "./types.ts";

/** The persisted report metadata row (the D1 index entry). */
export type ReportRecord = ReportRow;

/**
 * The only filename shape an archived asset may take: word chars / dot / hyphen,
 * ending `.png`. Shared with the retrieval route so the archive-time and read-time
 * guards agree. A `/` is impossible here (it's not in the class), so an asset key
 * can never traverse out of the report's `assets/` segment (R2 keys are flat
 * strings anyway, but this keeps the contract explicit).
 */
export const SAFE_ASSET_FILE = /^[\w.-]+\.png$/;

/** Build the R2 prefix for a report - derived from ids ONLY (no user input). */
export function reportPrefix(agentId: string, reportId: string): string {
  return `agents/${agentId}/reports/${reportId}/`;
}

/** The R2 key of a report's markdown body, off its prefix. */
function markdownKey(prefix: string): string {
  return `${prefix}report.md`;
}

/** The R2 key of one of a report's PNG assets, off its prefix. */
function assetKey(prefix: string, file: string): string {
  return `${prefix}assets/${file}`;
}

/** The basename (last path segment) of an absolute brain-FS asset path. */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Archive a generated report to R2 and record its metadata in D1.
 *
 * Mints a `reportId`, uploads `report.md` + each chart PNG under the report's
 * prefix with the correct `httpMetadata.contentType`, then inserts the D1 row
 * (`r2_key` = the prefix, `front_matter` = serialized JSON). Returns the persisted
 * {@link ReportRecord}. Asset bytes ride in on {@link ChartAsset.bytes} (carried
 * by MNEMO-24), so this never re-reads the brain FS.
 */
export async function archiveReport(
  env: Env,
  agentId: string,
  generated: GeneratedReport,
): Promise<ReportRecord> {
  const reportId = crypto.randomUUID();
  const prefix = reportPrefix(agentId, reportId);

  // (c) Upload the markdown body + each PNG asset under the report's prefix.
  await env.REPORTS_BUCKET.put(markdownKey(prefix), generated.markdown, {
    httpMetadata: { contentType: "text/markdown" },
  });

  for (const asset of generated.assets) {
    const file = basename(asset.path);
    if (!SAFE_ASSET_FILE.test(file)) {
      // Our renderer slugifies asset names, so this should be unreachable - fail
      // loud rather than write an unexpected key (defense in depth).
      throw new Error(`unsafe report asset filename: ${file}`);
    }
    await env.REPORTS_BUCKET.put(assetKey(prefix, file), asset.bytes, {
      httpMetadata: { contentType: "image/png" },
    });
  }

  // (d) Record the metadata row, reusing the minted `reportId` as the D1 PK so the
  // row id and the R2 prefix's id are the SAME UUID. `front_matter` is the
  // serialized JSON front matter; `r2_key` is the prefix (the retrieval side
  // resolves report.md/assets off it). D1 holds NO blob - only this index row.
  return createReport(env, {
    id: reportId,
    agent_id: agentId,
    title: generated.frontMatter.title,
    r2_key: prefix,
    front_matter: JSON.stringify(generated.frontMatter),
  });
}

/**
 * Resolve the ownership-checked D1 record for `reportId` under `agentId`, or null
 * when the report is absent OR owned by a different agent (no existence leak).
 */
async function ownedReport(
  env: Env,
  agentId: string,
  reportId: string,
): Promise<ReportRecord | null> {
  const row = await getReport(env, reportId);
  if (!row || row.agent_id !== agentId) return null;
  return row;
}

/**
 * Fetch a report's markdown body from R2, ownership-checked by `agent_id`. Returns
 * the R2 object (the route streams `.body` as `text/markdown`) or null when the
 * report doesn't exist for this agent / the blob is missing.
 */
export async function getReportMarkdown(
  env: Env,
  agentId: string,
  reportId: string,
): Promise<R2ObjectBody | null> {
  const record = await ownedReport(env, agentId, reportId);
  if (!record) return null;
  return env.REPORTS_BUCKET.get(markdownKey(record.r2_key));
}

/**
 * Fetch one of a report's PNG assets from R2, ownership-checked by `agent_id`.
 * `file` is validated against {@link SAFE_ASSET_FILE} (the route also pre-checks
 * it) so it can never resolve outside the report's `assets/` segment. Returns the
 * R2 object (the route streams `.body` as `image/png`) or null when missing /
 * unsafe / not owned.
 */
export async function getReportAsset(
  env: Env,
  agentId: string,
  reportId: string,
  file: string,
): Promise<R2ObjectBody | null> {
  if (!SAFE_ASSET_FILE.test(file)) return null;
  const record = await ownedReport(env, agentId, reportId);
  if (!record) return null;
  return env.REPORTS_BUCKET.get(assetKey(record.r2_key, file));
}
