import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/api/agents";
import { Button } from "@/components/ui";
import type { AgentDetailContext } from "@/pages/agents/AgentDetailPage";
import type { ChatOutletContext } from "@/pages/conversations/ConversationPage";
import { ChatTab } from "../ChatTab";

// The rail fetches conversations on mount; stub it so the test stays offline and
// focused on ChatTab's expand wiring (the rail's own behaviour is tested apart).
// NB: jsdom's localStorage is a no-op here (see AppShell.test.tsx), so these
// tests assert the in-memory toggle behaviour, not the persisted preference.
vi.mock("@/components/chat/ConversationList", () => ({
  ConversationList: () => <div data-testid="rail" />,
}));

const agent: Agent = {
  id: "a1",
  name: "Realtor",
  description: "Austin real estate.",
  template: "vendor",
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

// Stand-in for the conversation view: surfaces the expand controls it receives
// via outlet context so we can drive + observe the toggle without the real thread.
function StubThread() {
  const ctx = useOutletContext<ChatOutletContext>();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="ctx-expanded">{String(ctx.expanded)}</span>
      <Button onClick={() => ctx.onToggleExpand?.()}>expand</Button>
      <Button onClick={() => navigate("/agents/a1/chat")}>leave</Button>
    </div>
  );
}

function renderTab(path = "/agents/a1/chat/c1") {
  const context: AgentDetailContext = { agent, onAgentUpdated: vi.fn() };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agents/:agentId" element={<Outlet context={context} />}>
          <Route path="chat" element={<ChatTab />}>
            <Route path=":conversationId" element={<StubThread />} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatTab", () => {
  it("collapses the rail when the thread requests expansion", async () => {
    const { container } = renderTab();
    const pane = container.querySelector(
      "[data-conversation-open]",
    ) as HTMLElement;

    // Starts two-pane: not expanded, context reports collapsed.
    expect(pane).not.toHaveAttribute("data-expanded");
    expect(screen.getByTestId("ctx-expanded")).toHaveTextContent("false");

    await userEvent.click(screen.getByRole("button", { name: "expand" }));

    // The pane flips to expanded (the CSS hook that hides the rail) and the
    // context the thread reads follows.
    expect(pane).toHaveAttribute("data-expanded", "true");
    expect(screen.getByTestId("ctx-expanded")).toHaveTextContent("true");
  });

  it("drops the expanded layout once no conversation is open", async () => {
    const { container } = renderTab();
    const pane = container.querySelector(
      "[data-conversation-open]",
    ) as HTMLElement;

    await userEvent.click(screen.getByRole("button", { name: "expand" }));
    expect(pane).toHaveAttribute("data-expanded", "true");

    // Leaving the open conversation must restore the rail so another can be
    // picked/started - expansion is gated on having a conversation open.
    await userEvent.click(screen.getByRole("button", { name: "leave" }));

    expect(pane).not.toHaveAttribute("data-expanded");
    expect(pane).not.toHaveAttribute("data-conversation-open");
    expect(screen.getByTestId("rail")).toBeInTheDocument();
  });
});
