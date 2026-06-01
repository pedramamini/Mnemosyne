import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Agent, listAgents } from "@/api/agents";
import { getBrainSize } from "@/api/graph";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { restoreMatchMedia, stubMatchMedia } from "@/test/matchMedia";
import { DashboardPage } from "../DashboardPage";

// Keep AGENT_TEMPLATES real (drives the filter options); mock only the fetch.
vi.mock("@/api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/agents")>();
  return { ...actual, listAgents: vi.fn() };
});

// Mock the brain-size client; everything else in graph.ts stays real.
vi.mock("@/api/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/graph")>();
  return { ...actual, getBrainSize: vi.fn() };
});

// AppLayout reads the session for the account slot - stub it as signed in.
vi.mock("@/auth/useSession", () => ({
  useSession: () => ({
    status: "authenticated",
    account: { id: "acc-1", email: "ada@example.com" },
    refresh: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const mockListAgents = vi.mocked(listAgents);
const mockGetBrainSize = vi.mocked(getBrainSize);

const agents: Agent[] = [
  {
    id: "a1",
    name: "Acme Watch",
    description: "Tracks Acme Corp launches.",
    template: "vendor",
    status: "active",
    created_at: "2026-05-01T00:00:00.000Z",
  },
  {
    id: "a2",
    name: "Globex Tracker",
    description: "Watches Globex product releases.",
    template: "product",
    status: "building",
    created_at: "2026-05-10T00:00:00.000Z",
  },
  {
    id: "a3",
    name: "Initech Radar",
    description: "Founder intel on Initech.",
    template: "founder",
    status: "active",
    created_at: "2026-05-05T00:00:00.000Z",
  },
];

function renderPage() {
  render(
    <AppearanceProvider>
      <MemoryRouter initialEntries={["/agents"]}>
        <DashboardPage />
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    mockListAgents.mockReset();
    mockGetBrainSize.mockReset();
    // Distinct counts per agent; a2's metric rejects to exercise graceful "-".
    mockGetBrainSize.mockImplementation((id: string) => {
      if (id === "a1")
        return Promise.resolve({ neurons: 5, synapses: 8, dangling: 1 });
      if (id === "a3")
        return Promise.resolve({ neurons: 2, synapses: 3, dangling: 0 });
      return Promise.reject(new Error("metric unavailable"));
    });
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  // The shared sidebar (AppLayout → SidebarAgentNav) now also lists the agents
  // and fires its own `useAgents`, so: (1) the fetch must resolve for *every*
  // caller (`mockResolvedValue`, not `…Once`), and (2) agent-name assertions are
  // scoped to the dashboard grid - the sidebar isn't filtered by the dashboard
  // search/template controls, so a name can legitimately persist there.
  const inGrid = () => within(screen.getByTestId("agent-grid"));

  it("renders all three cards with their streamed-in metrics", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();

    await screen.findByTestId("agent-grid");
    expect(inGrid().getByText("Acme Watch")).toBeInTheDocument();
    expect(inGrid().getByText("Globex Tracker")).toBeInTheDocument();
    expect(inGrid().getByText("Initech Radar")).toBeInTheDocument();

    expect(
      await screen.findByText("5 neurons · 8 synapses"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("2 neurons · 3 synapses"),
    ).toBeInTheDocument();
  });

  it("renders the failing-metric card with '-'", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();

    // Wait for the two good metrics to settle, then a2's card holds a single "-".
    await screen.findByText("5 neurons · 8 synapses");
    await screen.findByText("2 neurons · 3 synapses");
    await waitFor(() => expect(screen.getByText("-")).toBeInTheDocument());
    expect(inGrid().getByText("Globex Tracker")).toBeInTheDocument();
  });

  it("filters the grid by the search box", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    await screen.findByTestId("agent-grid");

    await userEvent.type(screen.getByLabelText("Search agents"), "acme");

    await waitFor(() =>
      expect(inGrid().queryByText("Globex Tracker")).toBeNull(),
    );
    expect(inGrid().getByText("Acme Watch")).toBeInTheDocument();
    expect(inGrid().queryByText("Initech Radar")).toBeNull();
  });

  it("narrows the grid with the template filter", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    await screen.findByTestId("agent-grid");

    await userEvent.selectOptions(
      screen.getByLabelText("Filter by template"),
      "founder",
    );

    expect(inGrid().getByText("Initech Radar")).toBeInTheDocument();
    expect(inGrid().queryByText("Acme Watch")).toBeNull();
    expect(inGrid().queryByText("Globex Tracker")).toBeNull();
  });

  it("renders a single-column grid on a mobile viewport", async () => {
    stubMatchMedia(true);
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    const grid = await screen.findByTestId("agent-grid");

    // The mobile branch drops the auto-fit min-column width for an explicit
    // single column - proving the responsive branch is taken.
    expect(grid).toHaveStyle({
      gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
    });
  });

  it("shows the empty state when there are no agents", async () => {
    mockListAgents.mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText("No agents yet - create your first"),
      ).toBeInTheDocument(),
    );
  });
});
