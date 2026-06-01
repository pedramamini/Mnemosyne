import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Agent, listAgents } from "@/api/agents";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { AgentListPage } from "../AgentListPage";

// Keep AGENT_TEMPLATES real (drives the filter options); mock only the fetch.
vi.mock("@/api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/agents")>();
  return { ...actual, listAgents: vi.fn() };
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

const agents: Agent[] = [
  {
    id: "a1",
    name: "Acme Watch",
    description: "Tracks Acme Corp launches.",
    template: "vendor",
    status: "active",
    created_at: "2026-05-25T00:00:00.000Z",
  },
  {
    id: "a2",
    name: "Globex Tracker",
    description: "Watches Globex product releases.",
    template: "product",
    status: "building",
    created_at: "2026-05-25T00:00:00.000Z",
  },
];

function renderPage() {
  render(
    <AppearanceProvider>
      <MemoryRouter initialEntries={["/agents"]}>
        <AgentListPage />
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

describe("AgentListPage", () => {
  beforeEach(() => {
    mockListAgents.mockReset();
  });

  // The shared sidebar (AppLayout → SidebarAgentNav) now also lists the agents
  // and fires its own `useAgents`, so the fetch must resolve for every caller
  // (`mockResolvedValue`, not `…Once`), and name assertions are scoped to the
  // page's <main> region - the sidebar isn't filtered by these page controls.
  const inMain = () => within(screen.getByRole("main"));

  it("renders a card for each fetched agent", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    expect(await inMain().findByText("Acme Watch")).toBeInTheDocument();
    expect(inMain().getByText("Globex Tracker")).toBeInTheDocument();
  });

  it("filters by the search box (name/description)", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    await inMain().findByText("Acme Watch");

    await userEvent.type(screen.getByLabelText("Search agents"), "globex");

    expect(inMain().getByText("Globex Tracker")).toBeInTheDocument();
    expect(inMain().queryByText("Acme Watch")).toBeNull();
  });

  it("narrows the list with the template filter", async () => {
    mockListAgents.mockResolvedValue(agents);
    renderPage();
    await inMain().findByText("Acme Watch");

    await userEvent.selectOptions(
      screen.getByLabelText("Filter by template"),
      "vendor",
    );

    expect(inMain().getByText("Acme Watch")).toBeInTheDocument();
    expect(inMain().queryByText("Globex Tracker")).toBeNull();
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
