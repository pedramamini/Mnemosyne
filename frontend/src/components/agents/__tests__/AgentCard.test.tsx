import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Agent } from "@/api/agents";
import { AgentCard } from "../AgentCard";

const agent: Agent = {
  id: "a1",
  name: "Acme Watch",
  description: "Tracks Acme Corp launches and pricing.",
  template: "vendor",
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

/** Render the card on `/agents` with a decoy detail route to observe navigation. */
function renderCard() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <Routes>
        <Route path="/agents" element={<AgentCard agent={agent} />} />
        <Route path="/agents/:id" element={<div>agent detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentCard", () => {
  it("renders the name, description and template badge", () => {
    renderCard();
    expect(screen.getByText("Acme Watch")).toBeInTheDocument();
    expect(
      screen.getByText("Tracks Acme Corp launches and pricing."),
    ).toBeInTheDocument();
    expect(screen.getByText("vendor")).toBeInTheDocument();
  });

  it("links to the agent detail route", () => {
    renderCard();
    expect(
      screen.getByRole("link", { name: /open acme watch/i }),
    ).toHaveAttribute("href", "/agents/a1");
  });

  it("navigates to the detail page on click", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("link", { name: /open acme watch/i }),
    );
    expect(screen.getByText("agent detail")).toBeInTheDocument();
  });
});
