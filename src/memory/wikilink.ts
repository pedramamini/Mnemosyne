/**
 * Pure `[[wikilink]]` parser - the synapse extractor (PRD §4 / §6.2).
 *
 * PRD §4: "Files on the agent's filesystem = neurons. `[[wikilink]]`-style links
 * parsed into a real graph = synapses." PRD §6.2: "parse `[[wikilinks]]` into a
 * real graph; expose a visible map that grows; provide graph traversal as a
 * retrieval tool." This module is the *parse* half: it turns note content into a
 * list of outgoing links. The neuron/synapse INDEX (DO-SQLite) is built on top of
 * it in `src/memory/graph-index.ts`.
 *
 * Deliberately pure: NO filesystem and NO Durable Object calls. That keeps it
 * unit-testable on bare Node (`test/wikilink.test.ts`) independently of any
 * sandbox or DO, and lets the same parser run wherever a note's content is held.
 */

/** One parsed outgoing link. `target` is already slugified (comparable). */
export interface WikiLink {
  /** The link destination, normalized via {@link slugifyTarget} for resolution. */
  target: string;
  /** Optional display alias from `[[Target|Alias]]` - kept verbatim (trimmed). */
  alias?: string;
}

/**
 * Normalize a link target (or a note title) to a comparable slug so links
 * resolve regardless of capitalization/spacing: trim, case-fold (lowercase), and
 * collapse internal whitespace runs to a single space. `[[Acme Corp]]` and
 * `[[acme   corp]]` therefore slugify to the same `"acme corp"`. The neuron index
 * slugifies note titles through this SAME function, so a link and the note it
 * names land on an identical key.
 */
export function slugifyTarget(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Matches a `[[...]]` link whose body contains no brackets. The no-bracket body
 * means an unclosed `[[` (malformed) simply never matches - no link is produced.
 */
const WIKILINK_RE = /\[\[([^[\]]+)\]\]/g;

/**
 * Matches a code span: a run of backticks, the shortest content, then the SAME
 * run again (CommonMark-style). Per line, so it never swallows real prose across
 * a paragraph. Used to blank out inline code so a sample mentioning a wikilink
 * inside backticks is NOT counted as a synapse.
 */
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;

/** A line that opens or closes a fenced code block (``` or ~~~, 3+ chars). */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * Parse all `[[wikilinks]]` out of `content`. Supports plain `[[Target]]` and
 * aliased `[[Target|Alias]]`; ignores anything inside fenced code blocks and
 * inline code spans (so code samples don't create phantom synapses). Targets are
 * returned slugified (via {@link slugifyTarget}); empty targets are skipped.
 */
export function parseWikilinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let inFence = false;
  let fenceChar = "";

  for (const line of content.split(/\r?\n/)) {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const char = fence[1][0]; // "`" or "~"
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        continue;
      }
      if (char === fenceChar) {
        inFence = false;
        fenceChar = "";
        continue;
      }
      // A different fence char while a fence is open is just content; it still
      // sits inside the fence, so the skip below drops it.
    }
    if (inFence) continue;

    // Blank out inline code spans before scanning for links.
    const scannable = line.replace(INLINE_CODE_RE, " ");
    for (const m of scannable.matchAll(WIKILINK_RE)) {
      const inner = m[1];
      const pipe = inner.indexOf("|");
      const rawTarget = pipe === -1 ? inner : inner.slice(0, pipe);
      const target = slugifyTarget(rawTarget);
      if (target === "") continue; // e.g. `[[|Alias]]` - nothing to resolve.

      if (pipe === -1) {
        links.push({ target });
      } else {
        const alias = inner.slice(pipe + 1).trim();
        links.push(alias === "" ? { target } : { target, alias });
      }
    }
  }

  return links;
}
