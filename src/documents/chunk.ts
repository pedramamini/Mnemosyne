/**
 * Heading-aware Markdown chunking for brain ingestion (DOCS-01).
 *
 * A whole document is NEVER stored as one neuron (DOCS-01 header): we split on
 * top-level headings into sections - one neuron per section - plus a parent
 * "source index" neuron that `[[links]]` to each chunk, so the upload becomes a
 * small connected subgraph the agent can traverse. Every slug is namespaced under
 * the source (`sources/<source-slug>/…`) so two uploads can never collide on the
 * filesystem, and an oversized section is sub-split (next heading level, then
 * paragraph boundaries) so no single neuron is unwieldy.
 *
 * PURE - no I/O, no clock. `ingested_at` is left as a `{{INGESTED_AT}}` front-
 * matter placeholder the caller (seed.ts) fills, so the function is fully
 * unit-testable. Wikilink resolution in the brain is by slugified TITLE (see
 * `src/memory/graph-index.ts`), so each chunk's front-matter `title` is made
 * unique-per-source and the index/back/prev/next links reference that exact title.
 */

/** Soft size cap (bytes) for one chunk's content; a larger section is sub-split. */
const MAX_CHUNK_BYTES = 8 * 1024;

/** The front-matter placeholder seed.ts replaces with the real ingest timestamp. */
export const INGESTED_AT_PLACEHOLDER = "{{INGESTED_AT}}";

/** One neuron's slug (FS path under notes), resolution title, and full body. */
export interface ChunkNeuron {
  /** Namespaced note path slug, e.g. `sources/<source>/<n>-<heading>`. */
  slug: string;
  /** Unique-per-source title; the wikilink key other neurons resolve to. */
  title: string;
  /** The full note body (YAML front matter + section text + footer links). */
  content: string;
}

export interface ChunkResult {
  /** The parent source-index neuron's path slug (stored as `source_slug`). */
  sourceSlug: string;
  /** The source-index neuron (written first so chunk back-links resolve). */
  index: ChunkNeuron;
  /** The section neurons, in document order. */
  chunks: ChunkNeuron[];
}

/** UTF-8 byte length (multibyte-aware) so the size cap is real, not char-count. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Filesystem-safe kebab slug for a path segment: lowercase, non-alphanumerics →
 * `-`, collapsed + trimmed. Falls back to `fallback` when nothing survives (an
 * all-symbol heading), so a path segment is never empty.
 */
function kebab(s: string, fallback: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out === "" ? fallback : out;
}

/** Double-quote + escape a string for a YAML scalar (filenames carry `:`/quotes). */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A raw section: its heading text (null = pre-heading preamble) and full body. */
interface Section {
  heading: string | null;
  body: string;
}

/** A `#`-prefixed heading at `level` on a line NOT inside a fenced code block. */
function headingRegex(level: number): RegExp {
  return new RegExp(`^#{${level}}\\s+(.+?)\\s*$`);
}

/** Does the markdown contain any heading at exactly `level` (outside code fences)? */
function hasHeadingLevel(lines: string[], level: number): boolean {
  const re = headingRegex(level);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    else if (!inFence && re.test(line)) return true;
  }
  return false;
}

/**
 * Split `markdown` into sections at heading `level`, keeping the heading line in
 * each section body. Text before the first heading becomes a leading preamble
 * section (heading null) when non-empty. Code-fence aware so a `#` inside a fence
 * never starts a section.
 */
function sectionsAtLevel(markdown: string, level: number): Section[] {
  const re = headingRegex(level);
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { heading: string | null; lines: string[] } | null = null;
  let inFence = false;

  const flush = (): void => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (body !== "" || current.heading !== null) {
      sections.push({ heading: current.heading, body });
    }
  };

  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const m = inFence ? null : re.exec(line);
    if (m) {
      flush();
      current = { heading: m[1].trim(), lines: [line] };
    } else {
      current ??= { heading: null, lines: [] };
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

/** Split a body on blank-line paragraph boundaries, packing pieces under the cap. */
function paragraphSplit(body: string, maxBytes: number): string[] {
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim() !== "");
  const pieces: string[] = [];
  let buf = "";
  const push = (): void => {
    if (buf.trim() !== "") pieces.push(buf.trim());
    buf = "";
  };
  for (const para of paragraphs) {
    // A single paragraph over the cap is hard-split by length (last resort).
    if (byteLength(para) > maxBytes) {
      push();
      for (let i = 0; i < para.length; i += maxBytes) {
        pieces.push(para.slice(i, i + maxBytes));
      }
      continue;
    }
    const candidate = buf === "" ? para : `${buf}\n\n${para}`;
    if (byteLength(candidate) > maxBytes) {
      push();
      buf = para;
    } else {
      buf = candidate;
    }
  }
  push();
  return pieces.length > 0 ? pieces : [body.trim()];
}

/**
 * Reduce one section to bodies no larger than the cap: try the next heading level
 * first (so structure is preserved), else paragraph boundaries. Returns the
 * heading to label each resulting piece with plus its body.
 */
function subSplit(
  section: Section,
  level: number,
): Array<{ heading: string | null; body: string }> {
  if (byteLength(section.body) <= MAX_CHUNK_BYTES) return [section];

  // Try a deeper heading level (up to H6) before falling back to paragraphs.
  const lines = section.body.split(/\r?\n/);
  for (let deeper = level + 1; deeper <= 6; deeper++) {
    if (!hasHeadingLevel(lines, deeper)) continue;
    const subs = sectionsAtLevel(section.body, deeper);
    if (subs.length > 1) {
      return subs.flatMap((sub) =>
        subSplit(
          { heading: sub.heading ?? section.heading, body: sub.body },
          deeper,
        ),
      );
    }
  }

  // No usable deeper headings - split on paragraphs, labeling parts in order.
  const parts = paragraphSplit(section.body, MAX_CHUNK_BYTES);
  return parts.map((body, i) => ({
    heading: section.heading
      ? `${section.heading} (part ${i + 1})`
      : `Part ${i + 1}`,
    body,
  }));
}

/**
 * Chunk a converted document into brain-ready neurons. Splits on the shallowest
 * heading level present (H1, else H2, else the whole doc as one section),
 * sub-splits oversized sections, namespaces every slug under `sources/<source>`,
 * and builds a parent source-index neuron linking to each chunk in order.
 */
export function chunkMarkdown(input: {
  markdown: string;
  filename: string;
}): ChunkResult {
  const { filename } = input;
  const markdown = input.markdown.trim();
  const sourceBase = kebab(filename.replace(/\.[^./]+$/, ""), "document");
  const prefix = `sources/${sourceBase}`;
  const sourceSlug = `${prefix}/index`;

  // Shallowest heading level present drives the split; none → one section.
  const lines = markdown.split(/\r?\n/);
  const level = hasHeadingLevel(lines, 1)
    ? 1
    : hasHeadingLevel(lines, 2)
      ? 2
      : 0;
  const rawSections: Section[] =
    level === 0
      ? [{ heading: null, body: markdown }]
      : sectionsAtLevel(markdown, level);

  // Flatten to size-bounded pieces (each becomes one neuron).
  const pieces = rawSections.flatMap((s) =>
    subSplit(s, level === 0 ? 1 : level),
  );
  const total = pieces.length;

  // First pass: assign each chunk its slug + unique title (needed before bodies,
  // since prev/next/back links reference sibling titles).
  const indexTitle = `${filename} (source index)`;
  const planned = pieces.map((piece, i) => {
    const n = i + 1;
    const heading = piece.heading ?? "Untitled section";
    return {
      n,
      heading,
      body: piece.body,
      slug: `${prefix}/${n}-${kebab(heading, "section")}`,
      // `§<n>` guarantees uniqueness even when two sections share a heading.
      title: `${filename} - §${n} ${heading}`,
    };
  });

  const chunks: ChunkNeuron[] = planned.map((p, i) => {
    const prev = i > 0 ? planned[i - 1].title : null;
    const next = i < planned.length - 1 ? planned[i + 1].title : null;
    const frontMatter = [
      "---",
      `title: ${yamlString(p.title)}`,
      `source: ${yamlString(filename)}`,
      `source_slug: ${yamlString(sourceSlug)}`,
      `chunk: ${yamlString(`${p.n}/${total}`)}`,
      `ingested_at: ${INGESTED_AT_PLACEHOLDER}`,
      "---",
    ].join("\n");
    const links: string[] = [`From [[${indexTitle}]].`];
    if (prev) links.push(`Previous: [[${prev}]]`);
    if (next) links.push(`Next: [[${next}]]`);
    const content = `${frontMatter}\n\n${p.body}\n\n${links.join("  ")}\n`;
    return { slug: p.slug, title: p.title, content };
  });

  const indexFrontMatter = [
    "---",
    `title: ${yamlString(indexTitle)}`,
    `source: ${yamlString(filename)}`,
    `source_slug: ${yamlString(sourceSlug)}`,
    `ingested_at: ${INGESTED_AT_PLACEHOLDER}`,
    "---",
  ].join("\n");
  const indexBody = [
    `# ${filename}`,
    "",
    `Imported document, split into ${total} section${total === 1 ? "" : "s"}:`,
    "",
    ...planned.map((p) => `- [[${p.title}]]`),
  ].join("\n");
  const index: ChunkNeuron = {
    slug: sourceSlug,
    title: indexTitle,
    content: `${indexFrontMatter}\n\n${indexBody}\n`,
  };

  return { sourceSlug, index, chunks };
}
