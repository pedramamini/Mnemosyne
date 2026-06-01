/**
 * `htmlToText` - a lightweight HTML → readable-plaintext reducer (MNEMO-17).
 *
 * Per the phase note, a fetched page is reduced to readable text BEFORE it is
 * spilled / fed back, so the loop never sees raw markup (raw HTML is mostly
 * tokens the model doesn't need - scripts, styles, attributes - and would bloat
 * the in-loop context the SDK never compacts, PRD §7.1). This is deliberately a
 * regex/tokenizer pass, NOT a DOM parse: no heavy `jsdom`/`linkedom` dependency
 * is pulled into the Worker bundle just to strip tags.
 */

/** Block-level regions whose CONTENT is noise, removed wholesale before tag-strip. */
const NOISE_BLOCKS = [
  /<script\b[\s\S]*?<\/script>/gi,
  /<style\b[\s\S]*?<\/style>/gi,
  /<noscript\b[\s\S]*?<\/noscript>/gi,
  /<head\b[\s\S]*?<\/head>/gi,
  /<!--[\s\S]*?-->/g,
];

/** The handful of named/numeric entities worth decoding for readability. */
const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
];

/**
 * Reduce `html` to collapsed, readable plaintext: drop script/style/comment
 * regions, replace every remaining tag with a space (so adjoining words don't
 * fuse), decode the common entities, and collapse runs of whitespace. Plain
 * (non-HTML) input passes through largely unchanged save whitespace collapsing.
 */
export function htmlToText(html: string): string {
  let text = html;
  for (const block of NOISE_BLOCKS) {
    text = text.replace(block, " ");
  }
  // Replace tags with a space rather than "" so "<p>a</p><p>b</p>" → "a b".
  text = text.replace(/<[^>]+>/g, " ");
  for (const [entity, replacement] of ENTITIES) {
    text = text.replace(entity, replacement);
  }
  return text.replace(/\s+/g, " ").trim();
}
