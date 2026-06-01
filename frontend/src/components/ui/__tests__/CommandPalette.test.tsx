import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type CommandItem, CommandPalette } from "../CommandPalette";

function items(onSelect: () => void): CommandItem[] {
  return [
    { id: "agents", group: "Navigation", label: "Go to Agents", onSelect },
    {
      id: "settings",
      group: "Navigation",
      label: "Account settings",
      onSelect,
    },
    {
      id: "theme-dark",
      group: "Theme",
      label: "Theme: Dark",
      keywords: "appearance color",
      onSelect,
    },
  ];
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(
      <CommandPalette
        open={false}
        onClose={() => {}}
        items={items(() => {})}
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders all items as a combobox + listbox when open", () => {
    render(<CommandPalette open onClose={() => {}} items={items(() => {})} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("focuses the search field on open", () => {
    render(<CommandPalette open onClose={() => {}} items={items(() => {})} />);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("fuzzy-filters the list as the user types", async () => {
    render(<CommandPalette open onClose={() => {}} items={items(() => {})} />);
    await userEvent.keyboard("set");
    const options = screen.getAllByRole("option");
    // "set" matches "Account settings" (label) and "Theme: Dark" (no), and not "Go to Agents".
    const labels = options.map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Account settings"))).toBe(true);
    expect(labels.some((l) => l?.includes("Go to Agents"))).toBe(false);
  });

  it("matches on keywords as well as the label", async () => {
    render(<CommandPalette open onClose={() => {}} items={items(() => {})} />);
    await userEvent.keyboard("appearance");
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Theme: Dark"))).toBe(true);
  });

  it("navigates with arrows and selects with Enter", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} items={items(onSelect)} />);
    // First item active by default; ArrowDown → second item; Enter selects it.
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selects an item on click", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} items={items(onSelect)} />);
    await userEvent.click(
      screen.getByRole("option", { name: /Account settings/ }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the empty message when nothing matches", async () => {
    render(
      <CommandPalette
        open
        onClose={() => {}}
        items={items(() => {})}
        emptyMessage="Nothing here"
      />,
    );
    await userEvent.keyboard("zzzzz");
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} items={items(() => {})} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("previews the highlighted row and clears on non-preview rows", async () => {
    const onPreview = vi.fn();
    const onPreviewClear = vi.fn();
    const list: CommandItem[] = [
      { id: "agents", label: "Go to Agents", onSelect: () => {} },
      { id: "theme-dark", label: "Theme: Dark", onSelect: () => {}, onPreview },
    ];
    render(
      <CommandPalette
        open
        onClose={() => {}}
        items={list}
        onPreviewClear={onPreviewClear}
      />,
    );
    // First row has no preview → the active-row effect clears any live preview.
    expect(onPreview).not.toHaveBeenCalled();
    expect(onPreviewClear).toHaveBeenCalled();
    // Cycling onto the theme row applies it live.
    await userEvent.keyboard("{ArrowDown}");
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it("clears the preview when the palette closes", () => {
    const onPreviewClear = vi.fn();
    const list: CommandItem[] = [
      {
        id: "theme-dark",
        label: "Theme: Dark",
        onSelect: () => {},
        onPreview: () => {},
      },
    ];
    const { rerender } = render(
      <CommandPalette
        open
        onClose={() => {}}
        items={list}
        onPreviewClear={onPreviewClear}
      />,
    );
    onPreviewClear.mockClear();
    rerender(
      <CommandPalette
        open={false}
        onClose={() => {}}
        items={list}
        onPreviewClear={onPreviewClear}
      />,
    );
    expect(onPreviewClear).toHaveBeenCalledTimes(1);
  });
});
