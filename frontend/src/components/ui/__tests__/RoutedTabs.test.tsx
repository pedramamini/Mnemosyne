import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { type RoutedTabSpec, RoutedTabs } from "../RoutedTabs";

const tabs: RoutedTabSpec[] = [
  { label: "Alpha", to: "alpha" },
  { label: "Beta", to: "beta", badge: 3 },
  { label: "Gamma", to: "gamma" },
];

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<RoutedTabs tabs={tabs} label="Sections" />}>
          <Route path="alpha" element={<p>Alpha panel</p>} />
          <Route path="beta" element={<p>Beta panel</p>} />
          <Route path="gamma" element={<p>Gamma panel</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("RoutedTabs", () => {
  it("renders a tab per spec and its routed panel", () => {
    renderAt("/alpha");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByText("Alpha panel")).toBeVisible();
  });

  it("marks the active tab from the route", () => {
    renderAt("/beta");
    expect(screen.getByRole("tab", { name: /Beta/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /Alpha/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByText("Beta panel")).toBeVisible();
  });

  it("navigates between tabs with the arrow keys", async () => {
    renderAt("/alpha");
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    alpha.focus();

    await userEvent.keyboard("{ArrowRight}");

    const beta = screen.getByRole("tab", { name: /Beta/ });
    expect(beta).toHaveAttribute("aria-selected", "true");
    expect(beta).toHaveFocus();
    expect(screen.getByText("Beta panel")).toBeVisible();
  });
});
