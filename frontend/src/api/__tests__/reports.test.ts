import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchUrl,
  installFetchMock,
  jsonResponse,
  textResponse,
} from "../../test/apiMock";
import {
  collectAssets,
  getReport,
  listReports,
  reportAssetUrl,
  searchReports,
  splitFrontMatter,
  stripFindingsBlock,
} from "../reports";

describe("reports - splitFrontMatter (pure)", () => {
  it("parses quoted, numeric, and bare scalars", () => {
    const { frontMatter, body } = splitFrontMatter(
      '---\ntitle: "Weekly Watch"\ncount: 42\nstatus: live\n---\n# Body\n',
    );
    expect(frontMatter.title).toBe("Weekly Watch");
    expect(frontMatter.count).toBe(42);
    expect(frontMatter.status).toBe("live");
    expect(body).toBe("# Body\n");
  });

  it("parses a `key:`-then-indented block list", () => {
    const { frontMatter } = splitFrontMatter(
      "---\nsources:\n  - a.com\n  - b.com\n---\nbody",
    );
    expect(frontMatter.sources).toEqual(["a.com", "b.com"]);
  });

  it("treats `key: []` followed by no items as an empty list", () => {
    const { frontMatter } = splitFrontMatter("---\ntags: []\n---\nbody");
    expect(frontMatter.tags).toEqual([]);
  });

  it('unescapes \\n / \\t / \\" / \\\\ inside a double-quoted scalar', () => {
    const { frontMatter } = splitFrontMatter(
      '---\nnote: "a\\nb\\t\\"q\\"\\\\"\n---\n',
    );
    expect(frontMatter.note).toBe('a\nb\t"q"\\');
  });

  it("strips a leading BOM and handles CRLF fences", () => {
    const { frontMatter, body } = splitFrontMatter(
      '﻿---\r\ntitle: "x"\r\n---\r\nbody',
    );
    expect(frontMatter.title).toBe("x");
    expect(body).toBe("body");
  });

  it("returns the whole text as body when there is no front matter", () => {
    const { frontMatter, body } = splitFrontMatter("no front matter here");
    expect(frontMatter).toEqual({});
    expect(body).toBe("no front matter here");
  });
});

describe("reports - stripFindingsBlock (pure)", () => {
  it("drops the machine findings fence and collapses blank runs", () => {
    const out = stripFindingsBlock(
      "intro\n\n```mnemosyne-findings\n{json}\n```\n\n\n\nrest",
    );
    expect(out).not.toContain("mnemosyne-findings");
    expect(out).toBe("intro\n\nrest");
  });
});

describe("reports - collectAssets (pure)", () => {
  it("collects relative markdown + Obsidian embeds, skipping external https", () => {
    const assets = collectAssets(
      "a1",
      "r1",
      "![c](charts/chart-1.png)\n![[diagram.png]]\n![ext](https://x.com/y.png)",
    );
    const names = assets.map((a) => a.name).sort();
    expect(names).toEqual(["chart-1.png", "diagram.png"]);
    expect(assets[0].url).toContain("/agents/a1/reports/r1/assets/");
  });
});

describe("reports - reportAssetUrl (pure)", () => {
  it("encodes each path segment", () => {
    const url = reportAssetUrl("a b", "r/c", "f g.png");
    expect(url).toContain("/agents/a%20b/reports/r%2Fc/assets/f%20g.png");
  });
});

describe("reports - fetch-backed", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listReports maps the raw rows + parses front_matter JSON + windows with opts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          id: "r1",
          title: "One",
          created_at: "2026-01-01",
          front_matter: JSON.stringify({ summary: "first" }),
        },
        {
          id: "r2",
          title: "Two",
          created_at: "2026-01-02",
          front_matter: null,
        },
        {
          id: "r3",
          title: "Three",
          created_at: "2026-01-03",
          front_matter: "{not json",
        },
      ]),
    );
    const all = await listReports("a1");
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/reports");
    expect(all).toHaveLength(3);
    expect(all[0].summary).toBe("first");
    expect(all[1].frontMatter).toBeUndefined();
    expect(all[2].frontMatter).toBeUndefined(); // malformed JSON tolerated

    const windowed = await listReports("a1", { offset: 1, limit: 1 });
    expect(windowed.map((r) => r.id)).toEqual(["r2"]);
  });

  it("getReport splits front matter, derives title, strips findings, resolves assets", async () => {
    fetchMock.mockResolvedValue(
      textResponse(
        '---\ntitle: "T"\ncreated: "2026-02-02"\n---\n# H\n![c](chart-1.png)\n```mnemosyne-findings\nx\n```\n',
      ),
    );
    const report = await getReport("a1", "r1");
    expect(report.title).toBe("T");
    expect(report.createdAt).toBe("2026-02-02");
    expect(report.markdown).not.toContain("mnemosyne-findings");
    expect(report.assets?.[0].name).toBe("chart-1.png");
  });

  it("getReport falls back to the first heading when front matter has no title", async () => {
    fetchMock.mockResolvedValue(textResponse("# Derived Title\n\nbody"));
    const report = await getReport("a1", "r2");
    expect(report.title).toBe("Derived Title");
  });

  it("searchReports returns [] for a blank query without fetching", async () => {
    expect(await searchReports("a1", "  ")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searchReports matches title + body and builds a snippet", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/reports")) {
        return Promise.resolve(
          jsonResponse([
            {
              id: "r1",
              title: "needle in the title",
              created_at: "1",
              front_matter: null,
            },
            { id: "r2", title: "Other", created_at: "2", front_matter: null },
          ]),
        );
      }
      if (url.includes("/reports/r1")) {
        return Promise.resolve(textResponse("nothing relevant"));
      }
      return Promise.resolve(
        textResponse(`${"x".repeat(200)} needle ${"y".repeat(200)}`),
      );
    });
    const hits = await searchReports("a1", "needle");
    // r1 matches on title; r2 matches in body (with a centred snippet).
    expect(hits.map((h) => h.id).sort()).toEqual(["r1", "r2"]);
    const r2 = hits.find((h) => h.id === "r2");
    expect(r2?.snippet).toContain("needle");
    expect(r2?.snippet.startsWith("…")).toBe(true);
  });
});
