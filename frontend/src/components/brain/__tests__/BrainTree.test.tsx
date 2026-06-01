import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BrainEntry } from "@/api/brain";
import { BrainTree } from "../BrainTree";

const entries: BrainEntry[] = [
  { path: "notes/a.md", type: "file", size: 1, modified: 0 },
  { path: "notes/b.md", type: "file", size: 1, modified: 0 },
  { path: "tools/x.py", type: "file", size: 1, modified: 0 },
  { path: "index.md", type: "file", size: 1, modified: 0 },
];

function renderTree() {
  const onSelect = vi.fn();
  const onRequestNew = vi.fn();
  const onRequestDelete = vi.fn();
  render(
    <BrainTree
      entries={entries}
      selectedPath={null}
      onSelect={onSelect}
      onRequestNew={onRequestNew}
      onRequestDelete={onRequestDelete}
    />,
  );
  return { onSelect, onRequestNew, onRequestDelete };
}

describe("BrainTree", () => {
  it("renders directories collapsed, then reveals files on expand", async () => {
    renderTree();

    // The two synthesized directories render; a root-level file shows immediately.
    expect(screen.getByRole("button", { name: "notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "tools" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "index.md" }),
    ).toBeInTheDocument();

    // Children are hidden while their directory is collapsed.
    expect(screen.queryByRole("button", { name: "a.md" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "notes" }));

    // Expanding reveals the files nested under that directory.
    expect(screen.getByRole("button", { name: "a.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "b.md" })).toBeInTheDocument();
    // The other directory stays collapsed.
    expect(screen.queryByRole("button", { name: "x.py" })).toBeNull();
  });

  it("calls onSelect with the file path when a file row is clicked", async () => {
    const { onSelect } = renderTree();

    await userEvent.click(screen.getByRole("button", { name: "notes" }));
    await userEvent.click(screen.getByRole("button", { name: "a.md" }));

    expect(onSelect).toHaveBeenCalledWith("notes/a.md");
  });

  it("calls onRequestDelete from a row's delete affordance", async () => {
    const { onRequestDelete } = renderTree();

    // The root file's delete affordance is always visible.
    await userEvent.click(
      screen.getByRole("button", { name: "Delete index.md" }),
    );

    expect(onRequestDelete).toHaveBeenCalledWith("index.md");
  });

  it("calls onRequestNew from a directory's new-file affordance", async () => {
    const { onRequestNew } = renderTree();

    await userEvent.click(
      screen.getByRole("button", { name: "New file in notes" }),
    );

    expect(onRequestNew).toHaveBeenCalledWith("notes");
  });
});
