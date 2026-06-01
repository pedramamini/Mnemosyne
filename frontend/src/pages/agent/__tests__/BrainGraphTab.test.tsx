import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BrainGraph, getBrainGraph } from "@/api/graph";
import { Button } from "@/components/ui";
import { BrainGraphTab } from "../BrainGraphTab";

// Spy on navigation while keeping the rest of react-router-dom intact.
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

// Mock the data fetch; keep the graph types/selectors real.
vi.mock("@/api/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/graph")>();
  return { ...actual, getBrainGraph: vi.fn() };
});

// Stub the canvas so the test never touches real <canvas>/force-graph. It renders
// the node/link counts and a clickable kit Button per node (lint-clean - no raw
// <button>) that fires onNodeClick with that node.
vi.mock("@/components/graph/BrainGraphCanvas", () => ({
  BrainGraphCanvas: ({
    nodes,
    links,
    onNodeClick,
  }: {
    nodes: Array<{ id: string; title?: string }>;
    links: unknown[];
    onNodeClick: (node: { id: string }) => void;
  }) => (
    <div data-testid="canvas-stub">
      <span data-testid="node-count">{nodes.length}</span>
      <span data-testid="link-count">{links.length}</span>
      {nodes.map((node) => (
        <Button key={node.id} onClick={() => onNodeClick(node)}>
          {node.title ?? node.id}
        </Button>
      ))}
    </div>
  ),
}));

const mockGetBrainGraph = vi.mocked(getBrainGraph);

const graph: BrainGraph = {
  nodes: [
    {
      id: "/brain/notes/a.md",
      path: "/brain/notes/a.md",
      title: "Note A",
      neuronType: "note",
      degree: 1,
    },
    {
      id: "/brain/notes/b.md",
      path: "/brain/notes/b.md",
      title: "Note B",
      neuronType: "note",
      degree: 2,
    },
    {
      id: "/brain/notes/c.md",
      path: "/brain/notes/c.md",
      title: "Note C",
      neuronType: "note",
      degree: 1,
    },
  ],
  edges: [
    { source: "/brain/notes/a.md", target: "/brain/notes/b.md" },
    { source: "/brain/notes/b.md", target: "/brain/notes/c.md" },
  ],
  brainSize: { neurons: 3, synapses: 2 },
};

function renderTab() {
  render(
    <MemoryRouter>
      <BrainGraphTab agentId="a1" />
    </MemoryRouter>,
  );
}

describe("BrainGraphTab", () => {
  beforeEach(() => {
    navigate.mockReset();
    mockGetBrainGraph.mockReset();
  });

  it("shows the brain-size badge from brainSize", async () => {
    mockGetBrainGraph.mockResolvedValue(graph);
    renderTab();

    expect(
      await screen.findByText("3 neurons · 2 synapses"),
    ).toBeInTheDocument();
  });

  it("passes the transformed nodes/links to the canvas", async () => {
    mockGetBrainGraph.mockResolvedValue(graph);
    renderTab();

    expect(await screen.findByTestId("canvas-stub")).toBeInTheDocument();
    expect(screen.getByTestId("node-count")).toHaveTextContent("3");
    expect(screen.getByTestId("link-count")).toHaveTextContent("2");
  });

  it("deep-links to the Brain explorer for a clicked neuron's path", async () => {
    mockGetBrainGraph.mockResolvedValue(graph);
    renderTab();

    await userEvent.click(
      await screen.findByRole("button", { name: "Note A" }),
    );

    expect(navigate).toHaveBeenCalledWith(
      "/agents/a1/brain?path=%2Fbrain%2Fnotes%2Fa.md",
    );
  });

  it("renders the empty-brain state when the graph has zero nodes", async () => {
    mockGetBrainGraph.mockResolvedValue({
      nodes: [],
      edges: [],
      brainSize: { neurons: 0, synapses: 0 },
    });
    renderTab();

    expect(await screen.findByText("No neurons yet")).toBeInTheDocument();
    expect(screen.queryByTestId("canvas-stub")).not.toBeInTheDocument();
  });
});
