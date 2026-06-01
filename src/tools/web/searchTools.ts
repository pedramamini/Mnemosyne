/**
 * Web-research tools (MNEMO-17): `webFetch` + `webSearch`, built per-turn by
 * {@link buildWebTools} and spread into the registry alongside the sandbox tools
 * (src/tools/registry.ts). Both carry the safety rails from PRD §6.3 and obey
 * the same large-output-to-FS discipline as MNEMO-16 ({@link spillIfLarge}):
 *
 *   - `webFetch` - GETs one URL through {@link safeFetch} (host block + 15s
 *     timeout + 200KB cap), reduces HTML to readable text ({@link htmlToText}),
 *     spills anything over the inline threshold to `/brain/.tool-out` and returns
 *     a PATH + preview (never the blob), and emits a `source.read` audit event.
 *     A blocked / timed-out / failed fetch returns a typed `{ error }` - it does
 *     NOT throw (a tool throw would abort the loop turn).
 *   - `webSearch` - queries the provider-neutral backend configured by the
 *     `WEB_SEARCH_*` env (PRD §6.3). With no backend configured it returns a
 *     typed `{ error: "search not configured" }`; otherwise a compact, capped,
 *     spill-if-large list of `{ title, url, snippet }` plus a `source.read` event.
 */
import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../../env.ts";
import { spillIfLarge } from "../largeOutput.ts";
import type { MnemosyneTool, ToolContext } from "../types.ts";
import { isBlocked } from "./blockedHosts.ts";
import { htmlToText } from "./extractText.ts";
import { safeFetch, WEB_TIMEOUT_MS } from "./safeFetch.ts";

/** Default and hard-ceiling result counts for `webSearch`. */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

/** Sentinel thrown by {@link runWebSearch} when no backend is configured. */
export const SEARCH_NOT_CONFIGURED = "search not configured";

/** One normalized search hit returned to the loop. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Run the configured web-search backend and return normalized hits - the core
 * shared by the `webSearch` tool and the dev probe route. Dispatches on
 * `WEB_SEARCH_PROVIDER`: keyless `duckduckgo`, else the keyed JSON backend.
 * Throws {@link SEARCH_NOT_CONFIGURED} when unset; transport/parse faults
 * propagate (callers map them to a typed error).
 */
export async function runWebSearch(
  env: Pick<
    Env,
    "WEB_SEARCH_PROVIDER" | "WEB_SEARCH_ENDPOINT" | "WEB_SEARCH_API_KEY"
  >,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const provider = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (!provider) throw new Error(SEARCH_NOT_CONFIGURED);
  if (provider === "duckduckgo" || provider === "ddg") {
    return runDuckDuckGo(query, limit);
  }
  const endpoint = env.WEB_SEARCH_ENDPOINT?.trim();
  const apiKey = env.WEB_SEARCH_API_KEY?.trim();
  if (!endpoint || !apiKey) throw new Error(SEARCH_NOT_CONFIGURED);
  return runSearchBackend(endpoint, apiKey, query, limit);
}

/**
 * Build the web-research tool catalog for one turn. Pure factory - it reads
 * `ctx.env` lazily inside each `execute`, so it is safe to call at registry-build
 * time even when no search backend is configured.
 */
export function buildWebTools(ctx: ToolContext): Record<string, MnemosyneTool> {
  return {
    webFetch: tool({
      description:
        "Fetch one web page and return its readable plain text (HTML stripped, " +
        "capped at ~200KB). Use after webSearch to read a promising result. " +
        "Refuses people-finder / address-aggregator sites. Large pages return a " +
        "file path + preview instead of the full text.",
      inputSchema: z.object({
        url: z.url().describe("Full http(s) URL to fetch."),
      }),
      execute: async ({ url }) => {
        let result: Awaited<ReturnType<typeof safeFetch>>;
        try {
          result = await safeFetch(url);
        } catch (err) {
          // Timeout / transport failure - typed error, no source.read (we read
          // nothing). A throw here would abort the whole loop turn.
          return { error: `fetch failed: ${errMsg(err)}` };
        }

        if (result.blocked) {
          // Hard host block - refused, emits NO source.read.
          return { error: `blocked host: refused to fetch ${url}` };
        }

        const isHtml = /text\/html|application\/xhtml/i.test(
          result.contentType,
        );
        const text = isHtml ? htmlToText(result.body) : result.body;
        const content = await spillIfLarge(ctx, "webFetch", text);

        // A read happened - narrate it so the cockpit shows "read N sources."
        await ctx.emit({
          type: "source.read",
          level: "info",
          sessionId: ctx.sessionId,
          text: `Read ${url} (${result.bytes} bytes${result.truncated ? ", truncated" : ""})`,
          payload: {
            url,
            bytes: result.bytes,
            status: result.status,
            truncated: result.truncated,
          },
        });

        return {
          url,
          status: result.status,
          contentType: result.contentType,
          truncated: result.truncated,
          content,
        };
      },
    }),

    webSearch: tool({
      description:
        "Search the public web. Returns a compact list of { title, url, snippet } " +
        "results (people-finder / aggregator hosts filtered out). Use specific " +
        "queries, then webFetch the URLs worth reading.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query - be specific."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`Max results (default ${DEFAULT_SEARCH_LIMIT}).`),
      }),
      execute: async ({ query, limit }) => {
        const cap = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

        // MNEMO-17: the backend (keyless DuckDuckGo by default, or a keyed JSON
        // provider) is selected by `WEB_SEARCH_PROVIDER` inside runWebSearch.
        let hits: SearchHit[];
        try {
          hits = await runWebSearch(ctx.env, query, cap);
        } catch (err) {
          const message = errMsg(err);
          // Surface the failure in the audit cockpit (a silent {error} return left
          // search faults invisible) - operators see WHY a research turn went dry.
          await ctx.emit({
            type: "error",
            level: "error",
            sessionId: ctx.sessionId,
            text: `Web search failed: ${message}`,
            payload: { query, message },
          });
          return {
            error:
              message === SEARCH_NOT_CONFIGURED
                ? SEARCH_NOT_CONFIGURED
                : `search failed: ${message}`,
          };
        }

        const json = JSON.stringify(hits, null, 2);
        const results = await spillIfLarge(ctx, "webSearch", json);

        await ctx.emit({
          type: "source.read",
          level: "info",
          sessionId: ctx.sessionId,
          text: `Searched "${query}" → ${hits.length} result${hits.length === 1 ? "" : "s"}`,
          payload: {
            query,
            count: hits.length,
            provider: ctx.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase() ?? null,
          },
        });

        return { query, count: hits.length, results };
      },
    }),
  };
}

/**
 * Provider-neutral search call. POSTs `{ query, limit }` (Bearer-keyed) to the
 * configured endpoint and maps a generic `{ results: [...] }` JSON shape into
 * {@link SearchHit}s, filtering blocked hosts. Swapping providers means changing
 * ONLY this adapter - tool code above stays put (PRD §6.3).
 *
 * MNEMO-17: real backends differ in request/response shape; specialize the
 * request body and field-mapping here per `WEB_SEARCH_PROVIDER` as needed.
 */
async function runSearchBackend(
  endpoint: string,
  apiKey: string,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) {
      throw new Error(`search backend ${res.status}`);
    }
    const body = (await res.json()) as { results?: unknown };
    return normalizeHits(body.results, limit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * KEYLESS search backend (the zero-config default): DuckDuckGo's no-JS HTML
 * endpoint. GETs the results page with a browser-like UA (the endpoint rejects
 * empty/bot agents) and parses the `result__a` / `result__snippet` anchors into
 * {@link SearchHit}s, resolving DDG's `/l/?uddg=` redirect wrapper back to the
 * real URL. No API key, so agents can research out of the box; swap to a keyed
 * provider via `WEB_SEARCH_PROVIDER` for higher quality/quota. Host-filtered +
 * capped like every other backend.
 */
async function runDuckDuckGo(
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const q = encodeURIComponent(query);
  // DDG rate-limits Cloudflare's shared egress IPs intermittently: a blocked
  // request returns a page with NO parseable results (count 0) even though the
  // same query succeeds moments later. So try TWO endpoints (the no-JS `html`
  // one + the `lite` table layout, which rate-limit separately) across a couple
  // of rounds with backoff, and return the first non-empty result set. Only a
  // persistent block yields [] (the caller then reports "no results" honestly).
  const endpoints: Array<{
    url: string;
    parse: (html: string, limit: number) => SearchHit[];
  }> = [
    {
      url: `https://html.duckduckgo.com/html/?q=${q}`,
      parse: parseDuckDuckGoHtml,
    },
    {
      url: `https://lite.duckduckgo.com/lite/?q=${q}`,
      parse: parseDuckDuckGoLite,
    },
  ];
  let lastError: unknown = null;
  for (let round = 0; round < 2; round++) {
    for (const ep of endpoints) {
      try {
        const hits = ep.parse(await fetchDuckDuckGoHtml(ep.url), limit);
        if (hits.length > 0) return hits;
      } catch (err) {
        lastError = err;
      }
    }
    // brief backoff before the next round - the intermittent block often clears
    await new Promise((resolve) => setTimeout(resolve, 350 * (round + 1)));
  }
  // All attempts came back empty/blocked. If every attempt actually THREW
  // (transport failure, not just empty), surface that; else genuinely no results.
  if (lastError) throw lastError;
  return [];
}

/** GET one DDG endpoint with a browser-like UA (the endpoints reject bot agents). */
async function fetchDuckDuckGoHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the `lite.duckduckgo.com/lite/` table layout (a different markup from the
 * `html` endpoint, rate-limited separately): result links carry `class=result-link`
 * and snippets sit in `<td class=result-snippet>`. Attribute order/quoting varies,
 * so match the anchor tag then pull `href` + text out of it.
 */
function parseDuckDuckGoLite(html: string, limit: number): SearchHit[] {
  const snippets: string[] = [];
  const snippetRe =
    /<td[^>]*class=['"]?result-snippet['"]?[^>]*>([\s\S]*?)<\/td>/gi;
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1]));
  }

  const hits: SearchHit[] = [];
  const anchorRe =
    /<a\b([^>]*class=['"]?result-link['"]?[^>]*)>([\s\S]*?)<\/a>/gi;
  let index = 0;
  for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
    const href = m[1].match(/href=['"]?([^'"\s>]+)/)?.[1];
    const url = href ? resolveDuckDuckGoUrl(href) : null;
    const snippet = snippets[index] ?? "";
    index += 1;
    if (!url || isBlocked(url)) continue;
    hits.push({ url, title: stripTags(m[2]), snippet: snippet.slice(0, 600) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Parse DDG no-JS HTML into hits (links + their snippets, in document order). */
function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const snippets: string[] = [];
  const snippetRe =
    /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1]));
  }

  const hits: SearchHit[] = [];
  const linkRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let index = 0;
  for (let m = linkRe.exec(html); m; m = linkRe.exec(html)) {
    const url = resolveDuckDuckGoUrl(m[1]);
    const snippet = snippets[index] ?? "";
    index += 1;
    if (!url || isBlocked(url)) continue;
    hits.push({
      url,
      title: stripTags(m[2]),
      snippet: snippet.slice(0, 600),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Resolve DDG's `//duckduckgo.com/l/?uddg=<encoded>` redirect to the real URL. */
function resolveDuckDuckGoUrl(href: string): string | null {
  const wrapped = href.match(/[?&]uddg=([^&]+)/);
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped[1]);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return null;
}

/** Strip HTML tags + decode the handful of entities DDG emits in title/snippet. */
function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Coerce a backend's loosely-typed `results` into capped, host-filtered hits. */
function normalizeHits(raw: unknown, limit: number): SearchHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: SearchHit[] = [];
  for (const item of raw) {
    if (hits.length >= limit) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const url = pickString(r, ["url", "link", "href"]);
    if (!url || isBlocked(url)) continue;
    hits.push({
      url,
      title: pickString(r, ["title", "name"]) ?? "",
      snippet: (
        pickString(r, ["snippet", "content", "description"]) ?? ""
      ).slice(0, 600),
    });
  }
  return hits;
}

/** First string-valued property among `keys`, else undefined. */
function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Message of an unknown thrown value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
