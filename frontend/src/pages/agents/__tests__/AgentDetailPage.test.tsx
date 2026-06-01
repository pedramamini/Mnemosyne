import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Agent, getAgent } from "@/api/agents";
import { ApiError } from "@/api/client";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { AgentDetailPage } from "../AgentDetailPage";

// Mock only the fetch; keep AGENT_TEMPLATES and the rest of the module real.
vi.mock("@/api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/agents")>();
  return { ...actual, getAgent: vi.fn() };
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

const mockGetAgent = vi.mocked(getAgent);

const agent: Agent = {
  id: "a1",
  name: "Acme Watch",
  description: "Tracks Acme Corp launches.",
  template: "vendor",
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

// Minimal nested route tree mirroring App.tsx, with stub panels so the test
// stays focused on the shell (header + tab strip + redirect + not-found).
function renderAt(path: string) {
  render(
    <AppearanceProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents/:agentId" element={<AgentDetailPage />}>
            <Route index element={<Navigate to="chat" replace />} />
            <Route path="chat" element={<div>Chat panel</div>} />
            <Route path="reports" element={<div>Reports panel</div>} />
            <Route path="brain" element={<div>Brain panel</div>} />
            <Route path="graph" element={<div>Graph panel</div>} />
            <Route path="audit" element={<div>Audit panel</div>} />
            <Route path="settings" element={<div>Settings panel</div>} />
            <Route path="metadata" element={<div>Metadata panel</div>} />
          </Route>
          <Route path="/agents" element={<div>Agents list</div>} />
        </Routes>
      </MemoryRouter>
    </AppearanceProvider>,
  );
}

describe("AgentDetailPage", () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
  });

  it("renders the header with the agent name and template", async () => {
    mockGetAgent.mockResolvedValueOnce(agent);
    renderAt("/agents/a1/settings");

    expect(
      await screen.findByRole("heading", { name: "Acme Watch", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText("vendor")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders the eight tabs", async () => {
    mockGetAgent.mockResolvedValueOnce(agent);
    renderAt("/agents/a1/settings");

    await screen.findByRole("heading", { name: "Acme Watch", level: 2 });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Chat",
      "Messaging",
      "Reports",
      "Brain",
      "Graph",
      "Audit",
      "Settings",
      "Metadata",
    ]);
  });

  it("redirects the bare detail route to the Chat tab", async () => {
    mockGetAgent.mockResolvedValueOnce(agent);
    renderAt("/agents/a1");

    expect(await screen.findByText("Chat panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows a not-found empty state when the agent is missing", async () => {
    mockGetAgent.mockRejectedValueOnce(new ApiError(404, "not found", null));
    renderAt("/agents/missing/chat");

    await waitFor(() =>
      expect(screen.getByText("Agent not found")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /Back to agents/ }),
    ).toBeInTheDocument();
  });
});
