import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs } from "../Tabs";

const tabs = [
  { id: "one", label: "One", content: <p>Panel one</p> },
  { id: "two", label: "Two", content: <p>Panel two</p> },
  { id: "three", label: "Three", content: <p>Panel three</p> },
];

describe("Tabs", () => {
  it("selects the first tab by default and reflects aria-selected", () => {
    render(<Tabs tabs={tabs} label="Demo" />);
    const [first, second] = screen.getAllByRole("tab");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Panel one")).toBeVisible();
  });

  it("moves selection with the arrow keys", async () => {
    render(<Tabs tabs={tabs} label="Demo" />);
    const [first, second] = screen.getAllByRole("tab");
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveFocus();
    expect(screen.getByText("Panel two")).toBeVisible();
  });

  it("wraps to the first tab from the last with End/ArrowRight", async () => {
    render(<Tabs tabs={tabs} label="Demo" />);
    const [first] = screen.getAllByRole("tab");
    first.focus();
    await userEvent.keyboard("{End}");
    const tabsEls = screen.getAllByRole("tab");
    expect(tabsEls[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(tabsEls[0]).toHaveAttribute("aria-selected", "true");
  });
});
