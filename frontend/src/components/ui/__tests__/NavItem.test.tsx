import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavItem } from "../NavItem";

describe("NavItem", () => {
  it("renders its label when expanded", () => {
    render(
      <NavItem href="/x" icon={<span data-testid="icon" />}>
        Agents
      </NavItem>,
    );
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("shows the label as a caption and hides the trailing slot in collapsed mode", () => {
    render(
      <NavItem
        href="/x"
        collapsed
        aria-label="Agents"
        title="Agents"
        icon={<span data-testid="icon" />}
        trailing={<span data-testid="count">3</span>}
      >
        Agents
      </NavItem>,
    );
    // The label renders as a small caption beneath the icon (rail style).
    expect(screen.getByText("Agents")).toBeInTheDocument();
    // The trailing slot (e.g. a count badge) stays suppressed in the rail.
    expect(screen.queryByTestId("count")).toBeNull();
    // Icon stays; the link is still reachable + named.
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Agents" });
    expect(link).toHaveAttribute("href", "/x");
  });
});
