import { describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  INGESTED_AT_PLACEHOLDER,
} from "../src/documents/chunk.ts";

// DOCS-01: the chunker is PURE (no I/O, no clock) so it's unit-tested directly.
// We pin: one neuron per heading section + a parent source-index, namespaced
// (collision-free) slugs, front matter carrying source/chunk, the {{INGESTED_AT}}
// placeholder, and oversized-section sub-splitting.

const MULTI = `# Introduction

Intro body.

# Methods

How we did it.

# Results

What we found.
`;

describe("chunkMarkdown", () => {
  it("produces one chunk per top-level heading plus a source index", () => {
    const { sourceSlug, index, chunks } = chunkMarkdown({
      markdown: MULTI,
      filename: "Acme Report.pdf",
    });

    expect(chunks).toHaveLength(3);
    expect(sourceSlug).toBe("sources/acme-report/index");
    expect(index.slug).toBe("sources/acme-report/index");

    // The index links to every chunk by its (unique) title.
    for (const chunk of chunks) {
      expect(index.content).toContain(`[[${chunk.title}]]`);
    }
    // Each chunk back-links to the index and carries the placeholder + front matter.
    for (const chunk of chunks) {
      expect(chunk.content).toContain(`[[${index.title}]]`);
      expect(chunk.content).toContain(INGESTED_AT_PLACEHOLDER);
      expect(chunk.content).toContain('source: "Acme Report.pdf"');
      expect(chunk.content).toMatch(/chunk: "\d+\/3"/);
    }
    // Every slug is namespaced under the source dir.
    for (const chunk of chunks) {
      expect(chunk.slug.startsWith("sources/acme-report/")).toBe(true);
    }
  });

  it("namespaces slugs per source, so two different uploads never collide", () => {
    const a = chunkMarkdown({ markdown: MULTI, filename: "Acme Report.pdf" });
    const b = chunkMarkdown({ markdown: MULTI, filename: "Beta Memo.pdf" });

    const aSlugs = new Set([a.index.slug, ...a.chunks.map((c) => c.slug)]);
    const bSlugs = [b.index.slug, ...b.chunks.map((c) => c.slug)];
    for (const slug of bSlugs) {
      expect(aSlugs.has(slug)).toBe(false);
      expect(slug.startsWith("sources/beta-memo/")).toBe(true);
    }
  });

  it("treats a heading-less document as a single section", () => {
    const { chunks } = chunkMarkdown({
      markdown: "Just a paragraph with no headings at all.",
      filename: "note.txt.pdf",
    });
    expect(chunks).toHaveLength(1);
  });

  it("sub-splits an oversized section so no single neuron is huge", () => {
    // One H1 section whose body is a single ~20 KB paragraph (no sub-headings) -
    // forces a paragraph-boundary sub-split into multiple neurons.
    const big = "word ".repeat(5000); // ~25 KB
    const { chunks } = chunkMarkdown({
      markdown: `# Big Section\n\n${big}`,
      filename: "huge.pdf",
    });

    expect(chunks.length).toBeGreaterThan(1);
    // No chunk body blows far past the ~8 KB cap (slack for front matter + links).
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk.content).length).toBeLessThan(
        12_000,
      );
    }
  });

  it("falls back to H2 splitting when the document has no H1", () => {
    const md = `## Alpha\n\nFirst.\n\n## Beta\n\nSecond.\n`;
    const { chunks } = chunkMarkdown({ markdown: md, filename: "h2.pdf" });
    expect(chunks).toHaveLength(2);
  });
});
