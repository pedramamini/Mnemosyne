import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/api/agents";
import { AgentCard } from "../AgentCard";

const agent: Agent = {
  id: "a1",
  name: "Acme Watch",
  description: "Tracks Acme Corp launches.",
  template: "vendor",
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

describe("dashboard AgentCard", () => {
  it("renders name, template, status, and description", () => {
    render(
      <AgentCard
        agent={agent}
        brainSize={{ neurons: 5, synapses: 8 }}
        brainSizeLoading={false}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Acme Watch")).toBeInTheDocument();
    expect(screen.getByText("vendor")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Tracks Acme Corp launches.")).toBeInTheDocument();
  });

  it("renders the brain-size badge when given a metric", () => {
    render(
      <AgentCard
        agent={agent}
        brainSize={{ neurons: 5, synapses: 8 }}
        brainSizeLoading={false}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("5 neurons · 8 synapses")).toBeInTheDocument();
  });

  it("shows '-' while the metric is loading", () => {
    render(
      <AgentCard
        agent={agent}
        brainSize={undefined}
        brainSizeLoading={true}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.queryByText(/neurons/)).toBeNull();
  });

  it("shows '-' when the metric is undefined", () => {
    render(
      <AgentCard
        agent={agent}
        brainSize={undefined}
        brainSizeLoading={false}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("calls onOpen when the Open action is clicked", async () => {
    const onOpen = vi.fn();
    render(
      <AgentCard
        agent={agent}
        brainSize={{ neurons: 1, synapses: 0 }}
        brainSizeLoading={false}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Acme Watch" }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
