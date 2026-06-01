import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavItem } from "@/components/ui";
import { SidebarFlyout } from "../SidebarFlyout";

function renderFlyout() {
  return render(
    <SidebarFlyout
      label="Agents"
      trigger={(handlers) => (
        <NavItem
          href="/agents"
          aria-label="Agents"
          icon={<span data-testid="icon" />}
          collapsed
          {...handlers}
        >
          Agents
        </NavItem>
      )}
    >
      <span>Agent Alpha</span>
    </SidebarFlyout>,
  );
}

describe("SidebarFlyout", () => {
  it("renders the trigger but keeps the panel hidden until hovered", () => {
    renderFlyout();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(screen.queryByText("Agent Alpha")).toBeNull();
  });

  it("reveals the labeled panel on hover and hides it on Escape", () => {
    renderFlyout();
    const trigger = screen.getByRole("link", { name: "Agents" });

    fireEvent.mouseEnter(trigger);
    // The panel is a labeled <nav> landmark containing the body content.
    expect(
      screen.getByRole("navigation", { name: "Agents" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agent Alpha")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("Agent Alpha")).toBeNull();
  });

  it("opens on keyboard focus of the trigger", () => {
    renderFlyout();
    const trigger = screen.getByRole("link", { name: "Agents" });

    fireEvent.focus(trigger);
    expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
  });
});
