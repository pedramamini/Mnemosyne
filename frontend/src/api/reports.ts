/**
 * Report viewer API (MNEMO-41) - a typed client over the MNEMO-25 retrieval
 * routes, built on the MNEMO-32 `apiFetch` transport. Pure functions, no React;
 * the session cookie rides along via `credentials: "include"` (see `client.ts`),
 * including on the `<img>` requests that `reportAssetUrl` produces.
 *
 * shapes mirror MNEMO-25 (src/reports/routes.ts + src/reports/archive.ts):
 *
 *   GET /agents/:id/reports                       -> { id, title, created_at, front_matter }[]
 *   GET /agents/:id/reports/:reportId             -> the report's report.md as text/markdown
 *   GET /agents/:id/reports/:reportId/assets/:f   -> a chart PNG as image/png
 *
 * NB - the LIVE backend differs from the MNEMO-41 spec sketch in two ways, so this
 * module mirrors the REAL routes (same precedent as `src/api/graph.ts` and
 * `src/api/brain.ts`: follow the backend, not the spec stub) and composes the
 * spec's friendlier shapes on top:
 *
 *   1. `GET /:reportId` returns the report's **raw markdown** (with its Obsidian
 *      YAML front matter still at the top), NOT a `{ markdown, frontMatter, assets }`
 *      JSON envelope. So `getReport` fetches the text, splits the front matter off
 *      with a tiny local YAML splitter (no `gray-matter` dep - the backend emits a
 *      narrow, known shape; see `src/reports/front-matter.ts`), derives the title /
 *      created timestamp from it, and resolves the body's embedded chart refs to
 *      asset URLs.
 *   2. There is **no** `/reports/search` route - MNEMO-25 explicitly deferred
 *      full-text search over report BODIES to this viewer phase. So `searchReports`
 *      runs the search CLIENT-SIDE over the (small, per-agent) report set: it lists
 *      the reports, fetches their bodies, and matches title + body, building a
 *      snippet around the first hit.
 */
import { apiUrl, get } from "./client";

// --- Raw MNEMO-25 wire shapes -----------------------------------------------

/**
 * One report's metadata as `GET /reports` returns it (src/reports/routes.ts).
 * `front_matter` is the stored front matter as a JSON STRING (or null) - D1 holds
 * it serialized; we parse it into an object below.
 */
interface RawReportMeta {
  id: string;
  title: string;
  created_at: string;
  front_matter: string | null;
}

// --- Viewer-facing shapes (the MNEMO-41 spec shapes) ------------------------

/** Report metadata for the list view. */
export interface ReportMeta {
  id: string;
  title: string;
  /** ISO-8601 (or whatever D1 stored) creation timestamp. */
  createdAt: string;
  /** Parsed Obsidian front matter, when present. */
  frontMatter?: Record<string, unknown>;
  /** A short human summary, when the front matter carries one. */
  summary?: string;
}

/** One embedded asset (a chart PNG) resolved to a fetchable URL. */
export interface ReportAsset {
  /** The asset's file name as referenced by the markdown (e.g. `chart-1.png`). */
  name: string;
  /** Absolute URL the `<img>` loads (the MNEMO-25 asset route). */
  url: string;
}

/** A single report, body + parsed front matter + resolved embedded assets. */
export interface Report {
  id: string;
  title: string;
  /** The markdown body with the YAML front matter stripped off. */
  markdown: string;
  /** Parsed Obsidian front matter. */
  frontMatter: Record<string, unknown>;
  /** Embedded chart PNGs referenced by the body, resolved to asset URLs. */
  assets?: ReportAsset[];
  createdAt: string;
}

/** A full-text search hit (title + a snippet around the match). */
export interface ReportSearchHit {
  id: string;
  title: string;
  snippet: string;
  createdAt: string;
}

/** Optional list pagination. The backend lists ALL reports newest-first; when
 * given, the window is applied client-side over that list. */
export interface ListReportsOpts {
  limit?: number;
  offset?: number;
}

/** Per-agent base path for every report route. */
function reportsBase(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/reports`;
}

/**
 * Build the absolute URL for an embedded report asset (a chart PNG). The MNEMO-25
 * backend serves blobs by ROUTE (`/reports/:id/assets/:file`), not as absolute R2
 * URLs, so this composes the route; `apiUrl` applies the same API-origin rules as
 * `apiFetch`, so an `<img src>` hits the same authenticated origin (cookies ride
 * along same-origin). `name` is the asset's bare file name.
 */
export function reportAssetUrl(
  agentId: string,
  reportId: string,
  name: string,
): string {
  return apiUrl(
    `${reportsBase(agentId)}/${encodeURIComponent(reportId)}/assets/${encodeURIComponent(name)}`,
  );
}

/** Parse the stored `front_matter` JSON string into an object (null/garbage -> undefined). */
function parseStoredFrontMatter(
  raw: string | null,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A front-matter `summary`-ish field, if present, as a display string. */
function summaryOf(
  fm: Record<string, unknown> | undefined,
): string | undefined {
  const s = fm?.summary;
  return typeof s === "string" && s.length > 0 ? s : undefined;
}

/**
 * List an agent's reports (newest first). Maps the raw wire shape to {@link ReportMeta}
 * (parsing the JSON `front_matter` string). `opts` windows the list client-side
 * (the backend returns the full set).
 */
export async function listReports(
  agentId: string,
  opts: ListReportsOpts = {},
): Promise<ReportMeta[]> {
  const raw = await get<RawReportMeta[]>(reportsBase(agentId));
  const mapped: ReportMeta[] = raw.map((r) => {
    const frontMatter = parseStoredFrontMatter(r.front_matter);
    return {
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      frontMatter,
      summary: summaryOf(frontMatter),
    };
  });
  const start = opts.offset ?? 0;
  const end = opts.limit != null ? start + opts.limit : undefined;
  return start === 0 && end === undefined ? mapped : mapped.slice(start, end);
}

/**
 * Fetch one report. The backend returns raw markdown (front matter + body); this
 * splits the front matter off, derives the title/created timestamp from it, and
 * resolves the body's embedded chart refs to asset URLs.
 */
export async function getReport(
  agentId: string,
  reportId: string,
): Promise<Report> {
  const text = await get<string>(
    `${reportsBase(agentId)}/${encodeURIComponent(reportId)}`,
  );
  const { frontMatter, body } = splitFrontMatter(text);

  const title = asString(frontMatter.title) ?? firstHeading(body) ?? reportId;
  const createdAt = asString(frontMatter.created) ?? "";
  const cleaned = stripFindingsBlock(body);
  const assets = collectAssets(agentId, reportId, cleaned);

  return {
    id: reportId,
    title,
    markdown: cleaned,
    frontMatter,
    assets,
    createdAt,
  };
}

/**
 * Full-text search over an agent's reports - CLIENT-SIDE, because MNEMO-25 ships
 * no `/reports/search` route (it deferred body FTS to this viewer). Lists the
 * reports, fetches their bodies in parallel, and returns the hits (title or body
 * matching `query`, case-insensitive) newest-first with a snippet around the match.
 * Suited to the small per-agent report set the viewer browses; an empty/blank
 * query returns no hits (the caller gates the query).
 */
export async function searchReports(
  agentId: string,
  query: string,
): Promise<ReportSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const needle = q.toLowerCase();

  const metas = await listReports(agentId);
  const bodies = await Promise.all(
    metas.map((m) =>
      getReport(agentId, m.id)
        .then((r) => r.markdown)
        .catch(() => ""),
    ),
  );

  const hits: ReportSearchHit[] = [];
  metas.forEach((m, i) => {
    const body = bodies[i];
    const inBody = body.toLowerCase().indexOf(needle);
    const inTitle = m.title.toLowerCase().includes(needle);
    if (inBody === -1 && !inTitle) return;
    hits.push({
      id: m.id,
      title: m.title,
      snippet:
        inBody !== -1 ? snippetAround(body, inBody, needle.length) : m.title,
      createdAt: m.createdAt,
    });
  });
  return hits;
}

// --- Markdown / front-matter helpers (exported for unit tests) --------------

/**
 * Split a `---`-fenced YAML front-matter block off the head of a markdown string.
 * A tiny, purpose-built parser for the narrow shape `src/reports/front-matter.ts`
 * emits - bare/double-quoted scalars, numbers, and `key:`/`  - item` block lists
 * (plus `key: []`). Not a general YAML parser. Returns the parsed object (empty
 * when there's no front matter) and the remaining body.
 */
export function splitFrontMatter(text: string): {
  frontMatter: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized);
  if (!match) return { frontMatter: {}, body: normalized };
  return {
    frontMatter: parseYamlBlock(match[1]),
    body: normalized.slice(match[0].length),
  };
}

/** Parse the inner lines of a front-matter block (scalars + block lists). */
function parseYamlBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === "" || rest === "[]") {
      // Possibly a block list on the following indented `  - item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = /^\s+-\s+(.*)$/.exec(lines[j]);
        if (!item) break;
        items.push(String(parseScalar(item[1])));
        j += 1;
      }
      out[key] = items;
      i = j;
    } else {
      out[key] = parseScalar(rest);
      i += 1;
    }
  }
  return out;
}

/** Parse one scalar: double-quoted (unescaped), number-like, or bare string. */
function parseScalar(raw: string): string | number {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** First `# heading` text in a markdown body, if any. */
function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1] : undefined;
}

/** Coerce a front-matter value to a non-empty display string, else undefined. */
function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Drop the machine-internal ` ```mnemosyne-findings ` fenced block (MNEMO-26's
 * round-trip state) so it never renders as a code block in the viewer.
 */
export function stripFindingsBlock(body: string): string {
  return body
    .replace(/```mnemosyne-findings[\s\S]*?```\s*/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Last path segment of a relative ref. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Scan a markdown body for embedded image refs - standard `![alt](src)` and
 * Obsidian `![[file]]` embeds - and resolve each RELATIVE (non-`http`) ref to a
 * MNEMO-25 asset URL keyed by file name. External `https` images are left out
 * (the renderer loads them directly).
 */
export function collectAssets(
  agentId: string,
  reportId: string,
  body: string,
): ReportAsset[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const src = m[1];
    if (!/^https?:\/\//i.test(src)) names.add(basename(src));
  }
  for (const m of body.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    names.add(basename(m[1].trim()));
  }
  return [...names].map((name) => ({
    name,
    url: reportAssetUrl(agentId, reportId, name),
  }));
}

/** Build a ~120-char snippet centred on a match, trimmed to word-ish edges. */
function snippetAround(body: string, at: number, len: number): string {
  const radius = 60;
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + len + radius);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < body.length ? "…" : ""}`;
}
