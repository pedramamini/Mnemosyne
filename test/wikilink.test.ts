import { describe, expect, it } from "vitest";
import {
  parseWikilinks,
  slugifyTarget,
  type WikiLink,
} from "../src/memory/wikilink.ts";

// Pure functions - deterministic, no sandbox/DO needed (they run in the Workers
// pool but touch no bindings). This pins the synapse-extraction contract the
// neuron/synapse index (graph-index.ts) and graph traversal (PRD §6.2) build on:
// what counts as a link, how aliases parse, what's ignored, and that targets
// normalize to a comparable slug so links resolve across capitalization/spacing.

const targets = (content: string): string[] =>
  parseWikilinks(content).map((l) => l.target);

describe("parseWikilinks - plain and aliased links", () => {
  it("parses a plain link and slugifies its target", () => {
    expect(parseWikilinks("See [[Acme Corp]] for more.")).toEqual<WikiLink[]>([
      { target: "acme corp" },
    ]);
  });

  it("parses an aliased link, keeping the display alias verbatim", () => {
    expect(parseWikilinks("Backed by [[Sequoia Capital|Sequoia]].")).toEqual<
      WikiLink[]
    >([{ target: "sequoia capital", alias: "Sequoia" }]);
  });

  it("drops an empty alias (`[[Target|]]`) but keeps the target", () => {
    expect(parseWikilinks("[[Globex|]]")).toEqual<WikiLink[]>([
      { target: "globex" },
    ]);
  });

  it("skips a link with an empty target (`[[|Alias]]`)", () => {
    expect(parseWikilinks("[[|orphan]]")).toEqual([]);
  });

  it("parses multiple links across one note", () => {
    const content =
      "[[Acme]] raised from [[Sequoia|Sequoia Capital]] and [[a16z]].";
    expect(targets(content)).toEqual(["acme", "sequoia", "a16z"]);
    const links = parseWikilinks(content);
    expect(links[1]).toEqual({ target: "sequoia", alias: "Sequoia Capital" });
  });
});

describe("parseWikilinks - code is not a synapse", () => {
  it("ignores links inside an inline code span", () => {
    const content = "Real [[Acme]] but `code with [[NotALink]]` here.";
    expect(targets(content)).toEqual(["acme"]);
  });

  it("ignores links inside a fenced code block (```)", () => {
    const content = [
      "Intro [[Real Link]].",
      "```ts",
      "const x = '[[FencedLink]]';",
      "```",
      "Outro [[Another]].",
    ].join("\n");
    expect(targets(content)).toEqual(["real link", "another"]);
  });

  it("ignores links inside a ~~~ fenced block too", () => {
    const content = ["~~~", "[[FencedTilde]]", "~~~", "[[Outside]]"].join("\n");
    expect(targets(content)).toEqual(["outside"]);
  });

  it("handles double-backtick code spans containing a single backtick", () => {
    const content = "Keep [[Kept]], drop `` `[[Dropped]]` ``.";
    expect(targets(content)).toEqual(["kept"]);
  });
});

describe("parseWikilinks - malformed input", () => {
  it("ignores an unclosed `[[` with no matching close", () => {
    expect(parseWikilinks("dangling [[Acme and the rest of the line")).toEqual(
      [],
    );
  });

  it("returns nothing for content with no links", () => {
    expect(parseWikilinks("just prose, no links at all")).toEqual([]);
  });

  it("ignores empty brackets `[[]]`", () => {
    expect(parseWikilinks("empty [[]] here")).toEqual([]);
  });
});

describe("slugifyTarget - comparable normalization", () => {
  it("`[[Acme Corp]]` and `[[acme corp]]` are slug-equal", () => {
    expect(slugifyTarget("Acme Corp")).toBe(slugifyTarget("acme corp"));
    expect(parseWikilinks("[[Acme Corp]]")[0].target).toBe(
      parseWikilinks("[[acme corp]]")[0].target,
    );
  });

  it("trims, case-folds, and collapses internal whitespace", () => {
    expect(slugifyTarget("  Acme   Corp  ")).toBe("acme corp");
    expect(slugifyTarget("ACME\tCORP")).toBe("acme corp");
  });

  it("is idempotent", () => {
    const once = slugifyTarget("  Mixed   Case Title ");
    expect(slugifyTarget(once)).toBe(once);
  });
});
