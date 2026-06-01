import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Conversation,
  listConversations,
  searchConversations,
} from "@/api/conversations";
import { ConversationList } from "../ConversationList";

// Mock only the network helpers; keep the rest of the adapter real.
vi.mock("@/api/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/conversations")>();
  return {
    ...actual,
    listConversations: vi.fn(),
    searchConversations: vi.fn(),
  };
});

// Spy on navigation while keeping the rest of react-router-dom intact.
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

const mockList = vi.mocked(listConversations);
const mockSearch = vi.mocked(searchConversations);

const conversations: Conversation[] = [
  {
    id: "c1",
    agentId: "a1",
    title: "Roadmap chat",
    created_at: "2026-05-25T10:00:00.000Z",
    updated_at: "2026-05-25T10:00:00.000Z",
    lastMessagePreview: "Let's plan Q3",
  },
  {
    id: "c2",
    agentId: "a1",
    title: "Bug triage",
    created_at: "2026-05-24T10:00:00.000Z",
    updated_at: "2026-05-24T10:00:00.000Z",
    lastMessagePreview: "Crash on login",
  },
];

function renderList(activeConversationId?: string) {
  render(
    <MemoryRouter>
      <ConversationList
        agentId="a1"
        activeConversationId={activeConversationId}
      />
    </MemoryRouter>,
  );
}

describe("ConversationList", () => {
  beforeEach(() => {
    navigate.mockReset();
    mockList.mockReset();
    mockSearch.mockReset();
    mockList.mockResolvedValue(conversations);
  });

  it("lists the agent's conversations", async () => {
    renderList();
    expect(await screen.findByText("Roadmap chat")).toBeInTheDocument();
    expect(screen.getByText("Bug triage")).toBeInTheDocument();
  });

  it("marks the active conversation", async () => {
    renderList("c2");
    await screen.findByText("Bug triage");
    const active = screen.getByRole("link", { current: "page" });
    expect(within(active).getByText("Bug triage")).toBeInTheDocument();
  });

  it("searches and renders matching results", async () => {
    mockSearch.mockResolvedValue([conversations[1]]);
    renderList();
    await screen.findByText("Roadmap chat");

    await userEvent.type(screen.getByLabelText("Search conversations"), "bug");

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith("a1", "bug"));
    expect(await screen.findByText("Bug triage")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Roadmap chat")).toBeNull());
  });

  it("navigates to a new conversation", async () => {
    renderList();
    await screen.findByText("Roadmap chat");
    await userEvent.click(
      screen.getByRole("button", { name: /New conversation/ }),
    );
    expect(navigate).toHaveBeenCalledWith("/agents/a1/conversations/new");
  });
});
