import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReportList, type ReportListItem } from "../ReportList";

const now = new Date().toISOString();

const items: ReportListItem[] = [
  { id: "r1", title: "Q2 Review", createdAt: now },
  { id: "r2", title: "Q1 Review", createdAt: now },
];

const hits: ReportListItem[] = [
  { id: "r2", title: "Q1 Review", createdAt: now, snippet: "…funding round…" },
];

describe("ReportList", () => {
  it("renders rows with titles and a relative date", () => {
    render(<ReportList items={items} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByText("Q2 Review")).toBeInTheDocument();
    expect(screen.getByText("Q1 Review")).toBeInTheDocument();
    // relativeTime of "now" renders "just now" on each row.
    expect(screen.getAllByText("just now")).toHaveLength(2);
  });

  it("calls onSelect with the row id when clicked", async () => {
    const onSelect = vi.fn();
    render(<ReportList items={items} selectedId={null} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: /Q2 Review/ }));
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("shows snippets only in search-results mode", () => {
    const { rerender } = render(
      <ReportList items={hits} selectedId={null} onSelect={vi.fn()} />,
    );
    // List mode: snippet is not rendered even when present on the item.
    expect(screen.queryByText("…funding round…")).not.toBeInTheDocument();

    rerender(
      <ReportList
        items={hits}
        selectedId={null}
        onSelect={vi.fn()}
        isSearchResults
        query="funding"
      />,
    );
    expect(screen.getByText("…funding round…")).toBeInTheDocument();
  });

  it("shows the list empty state when there are no reports", () => {
    render(<ReportList items={[]} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByText("No reports yet")).toBeInTheDocument();
  });

  it("shows the search empty state with the query when no hits", () => {
    render(
      <ReportList
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        isSearchResults
        query="zzz"
      />,
    );
    expect(screen.getByText('No matches for "zzz"')).toBeInTheDocument();
  });
});
