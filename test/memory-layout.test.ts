import { describe, expect, it } from "vitest";
import {
  consolidateCommitMsg,
  parseCommitCategory,
  toolCommitMsg,
  writeCommitMsg,
} from "../src/memory/commit-messages.ts";
import {
  BRAIN_DIRS,
  BrainPathError,
  NOTES_DIR,
  notePath,
  REPORTS_DIR,
  TOOLS_DIR,
  toolPath,
} from "../src/memory/layout.ts";

// Pure functions - deterministic, no sandbox/container needed (they run in the
// Workers pool but touch no bindings). The brain-layout safety invariant (a
// hostile slug cannot escape /brain) and the commit-message round-trip are the
// load-bearing contracts MNEMO-10/MNEMO-12 build on, so they're pinned here.

describe("brain layout - directory constants", () => {
  it("BRAIN_DIRS lists notes, tools, and reports under /brain", () => {
    expect(BRAIN_DIRS).toContain(NOTES_DIR);
    expect(BRAIN_DIRS).toContain(TOOLS_DIR);
    expect(BRAIN_DIRS).toContain(REPORTS_DIR);
    expect(NOTES_DIR).toBe("/brain/notes");
    expect(TOOLS_DIR).toBe("/brain/tools");
    expect(REPORTS_DIR).toBe("/brain/reports");
  });
});

describe("brain layout - notePath", () => {
  it("joins a slug under /brain/notes and appends .md", () => {
    expect(notePath("acme")).toBe("/brain/notes/acme.md");
  });

  it("does not double the .md extension", () => {
    expect(notePath("acme.md")).toBe("/brain/notes/acme.md");
  });

  it("rejects upward traversal, absolute paths, and embedded ..", () => {
    expect(() => notePath("../etc/passwd")).toThrow(BrainPathError);
    expect(() => notePath("/etc/passwd")).toThrow(BrainPathError);
    expect(() => notePath("foo/../../escape")).toThrow(BrainPathError);
    expect(() => notePath("")).toThrow(BrainPathError);
  });
});

describe("brain layout - toolPath", () => {
  it("joins a name under /brain/tools without assuming an extension", () => {
    expect(toolPath("scrape.py")).toBe("/brain/tools/scrape.py");
    expect(toolPath("digest.sh")).toBe("/brain/tools/digest.sh");
  });

  it("rejects traversal and absolute escapes", () => {
    expect(() => toolPath("../../bin/sh")).toThrow(BrainPathError);
    expect(() => toolPath("/usr/bin/evil")).toThrow(BrainPathError);
    expect(() => toolPath("a\\b")).toThrow(BrainPathError);
  });
});

describe("commit-message builders", () => {
  it("each builder produces its category prefix", () => {
    expect(writeCommitMsg("acme")).toBe("memory: write acme");
    expect(consolidateCommitMsg("merged 3 notes")).toBe(
      "consolidate: merged 3 notes",
    );
    expect(toolCommitMsg("scrape.py")).toBe("tool: author scrape.py");
  });

  it("parseCommitCategory round-trips every category", () => {
    expect(parseCommitCategory(writeCommitMsg("x"))).toBe("memory");
    expect(parseCommitCategory(consolidateCommitMsg("y"))).toBe("consolidate");
    expect(parseCommitCategory(toolCommitMsg("z"))).toBe("tool");
    expect(parseCommitCategory("init: brain layout")).toBe("init");
  });

  it("maps an unknown or prefix-less message to 'other'", () => {
    expect(parseCommitCategory("random commit")).toBe("other");
    expect(parseCommitCategory("fix: typo")).toBe("other");
  });
});
