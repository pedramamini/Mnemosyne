import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppShell, Button, useAppShell } from "@/components/ui";

// NB: the jsdom localStorage polyfill is a no-op here, so these tests assert the
// in-memory resize/collapse BEHAVIOR (width + collapsed state), not persistence -
// persistence is `usePersistentState`'s concern. Each mount reads the defaults.

/** A tiny consumer that flips the collapse state from inside the shell tree. */
function CollapseToggle() {
  const shell = useAppShell();
  return (
    <Button onClick={() => shell?.toggleCollapsed()}>
      {shell?.collapsed ? "collapsed" : "expanded"}
    </Button>
  );
}

function renderShell() {
  render(
    <AppShell sidebar={<CollapseToggle />}>
      <div>main content</div>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("renders the sidebar, main content, and a resize separator", () => {
    renderShell();
    expect(screen.getByText("main content")).toBeInTheDocument();
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "256");
  });

  it("resizes via the separator's keyboard controls", async () => {
    renderShell();
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    separator.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "272"); // 256 + 16

    await userEvent.keyboard("{Home}");
    expect(separator).toHaveAttribute("aria-valuenow", "192"); // clamped to min
  });

  it("toggles the collapse preference", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: "expanded" }));
    expect(
      screen.getByRole("button", { name: "collapsed" }),
    ).toBeInTheDocument();
  });
});
