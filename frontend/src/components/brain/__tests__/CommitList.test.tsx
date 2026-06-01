import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Commit } from "@/api/brain";
import { CommitList } from "../CommitList";

const NOW = Date.now();

const commits: Commit[] = [
  {
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    author: "Mnemosyne Agent",
    ts: NOW - 2 * 60 * 60 * 1000, // 2h ago
    subject: "memory: add welcome note",
    category: "memory",
  },
  {
    sha: "1234567abcdef01234567abcdef01234567abcd0",
    author: "Mnemosyne Agent",
    ts: NOW - 5 * 60 * 1000, // 5m ago
    subject: "consolidate: nightly sleep pass\n\nmerged 3 notes",
    category: "consolidate",
  },
];

describe("CommitList", () => {
  it("renders each commit's short message, short sha, and relative time", () => {
    render(
      <CommitList commits={commits} selectedSha={null} onSelect={vi.fn()} />,
    );

    // Short message (first line only - the body after the blank line is dropped).
    expect(screen.getByText("memory: add welcome note")).toBeInTheDocument();
    expect(
      screen.getByText("consolidate: nightly sleep pass"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/merged 3 notes/)).toBeNull();

    // Short (7-char) shas.
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();

    // Relative time rendered for each row.
    expect(screen.getByText("2h ago")).toBeInTheDocument();
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("badges a consolidation-pass commit", () => {
    render(
      <CommitList commits={commits} selectedSha={null} onSelect={vi.fn()} />,
    );

    const badges = screen.getAllByText("consolidation");
    // Exactly one commit (the `consolidate:` one) carries the badge.
    expect(badges).toHaveLength(1);
  });

  it("calls onSelect with the full sha when a row is clicked", async () => {
    const onSelect = vi.fn();
    render(
      <CommitList commits={commits} selectedSha={null} onSelect={onSelect} />,
    );

    await userEvent.click(screen.getByText("memory: add welcome note"));

    expect(onSelect).toHaveBeenCalledWith(
      "abcdef1234567890abcdef1234567890abcdef12",
    );
  });

  it("renders a Load more control only when there is another page", async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <CommitList
        commits={commits}
        selectedSha={null}
        onSelect={vi.fn()}
        onLoadMore={onLoadMore}
        hasMore={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    rerender(
      <CommitList
        commits={commits}
        selectedSha={null}
        onSelect={vi.fn()}
        onLoadMore={onLoadMore}
        hasMore
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
