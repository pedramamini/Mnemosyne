import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/api/brain";
import { DiffViewer } from "../DiffViewer";

const modified: FileDiff = {
  path: "notes/a.md",
  additions: 1,
  deletions: 1,
  patch: [
    "diff --git a/notes/a.md b/notes/a.md",
    "index 1111111..2222222 100644",
    "--- a/notes/a.md",
    "+++ b/notes/a.md",
    "@@ -1,3 +1,3 @@",
    " context line",
    "-removed line",
    "+added line",
    " trailing context",
  ].join("\n"),
};

const added: FileDiff = {
  path: "notes/new.md",
  additions: 2,
  deletions: 0,
  patch: [
    "diff --git a/notes/new.md b/notes/new.md",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/notes/new.md",
    "@@ -0,0 +1,2 @@",
    "+first line",
    "+second line",
  ].join("\n"),
};

/** The `[data-diff-kind]` line wrapping a given text. */
function lineKind(text: string): string | null {
  return (
    screen
      .getByText(text)
      .closest("[data-diff-kind]")
      ?.getAttribute("data-diff-kind") ?? null
  );
}

describe("DiffViewer", () => {
  it("colors added lines as adds and removed lines as deletes", () => {
    render(<DiffViewer diffs={[modified]} />);

    expect(lineKind("added line")).toBe("add");
    expect(lineKind("removed line")).toBe("del");
    expect(lineKind("context line")).toBe("context");
    // Structural file headers (`--- a/…`, `+++ b/…`) are dropped, not rendered.
    expect(screen.queryByText("a/notes/a.md")).toBeNull();
  });

  it("shows a derived status badge per file", () => {
    render(<DiffViewer diffs={[modified, added]} />);

    expect(screen.getByText("modified")).toBeInTheDocument();
    expect(screen.getByText("added")).toBeInTheDocument();
  });

  it("shows the empty state for no changes", () => {
    render(<DiffViewer diffs={[]} />);

    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("shows a spinner while loading", () => {
    render(<DiffViewer diffs={[]} isLoading />);

    expect(screen.getByLabelText("Loading diff")).toBeInTheDocument();
  });
});
