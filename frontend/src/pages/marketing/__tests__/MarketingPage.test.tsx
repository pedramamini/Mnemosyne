import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { MarketingPage } from "../MarketingPage";

function renderPage() {
  render(
    <AppearanceProvider>
      <MemoryRouter>
        <MarketingPage />
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

describe("MarketingPage", () => {
  it("renders the hero, about, and section headings", () => {
    renderPage();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /research that remembers/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /what's a mnemosyne/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /where mnemosyne is headed/i }),
    ).toBeInTheDocument();
  });

  it("offers entry points into the app", () => {
    renderPage();
    // Header CTA + hero CTA + final band all route into the app.
    expect(
      screen.getAllByRole("button", { name: /open the app/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: /sign up \/ in/i }),
    ).toBeInTheDocument();
  });

  it("lets visitors switch the theme but not the typeface (website font is locked)", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /search/i }));

    const labels = screen
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    // Theme switching stays available on the public site...
    expect(labels.some((l) => /^Theme:/.test(l))).toBe(true);
    // ...but the typeface is pinned to the brand face, so no font items.
    expect(labels.some((l) => /^Font:/.test(l))).toBe(false);
  });
});
