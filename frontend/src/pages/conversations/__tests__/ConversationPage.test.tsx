import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChatMessage,
  getConversation,
  renameConversation,
} from "@/api/conversations";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { useAgentChat } from "@/components/chat/useAgentChat";
import { ToastProvider } from "@/components/ui";
import {
  type ChatOutletContext,
  ConversationPage,
  ConversationView,
} from "../ConversationPage";

// Mock the conversation network helpers (keep types/util real).
vi.mock("@/api/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/conversations")>();
  return {
    ...actual,
    getConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
  };
});

// Mock the streaming hook so no real network/transport is hit.
vi.mock("@/components/chat/useAgentChat", () => ({
  useAgentChat: vi.fn(),
}));

// AppLayout reads the session for the account slot - stub it as signed in.
vi.mock("@/auth/useSession", () => ({
  useSession: () => ({
    status: "authenticated",
    account: { id: "acc-1", email: "ada@example.com" },
    refresh: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const mockGetConversation = vi.mocked(getConversation);
const mockRenameConversation = vi.mocked(renameConversation);
const mockUseAgentChat = vi.mocked(useAgentChat);

const sendSpy = vi.fn();

// A faithful hook stand-in backed by real React state so input/messages/send
// behave like the real hook (send appends a user turn and spies the text).
function installHookMock() {
  mockUseAgentChat.mockImplementation(() => {
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    return {
      messages,
      input,
      setInput,
      send: (text?: string) => {
        const value = (text ?? input).trim();
        if (!value) return;
        sendSpy(value);
        setMessages((prev) => [
          ...prev,
          {
            id: `u-${prev.length}`,
            role: "user",
            parts: [{ type: "text", text: value }],
          },
        ]);
        setInput("");
      },
      status: "ready",
      stop: vi.fn(),
      error: undefined,
    };
  });
}

function renderAt(path = "/agents/a1/conversations/c1") {
  render(
    <AppearanceProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/agents/:agentId/conversations/:conversationId"
              element={<ConversationPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AppearanceProvider>,
  );
}

// Render ConversationView the way the agent detail Chat tab does: nested under a
// parent route that supplies the outlet context (incl. the expand controls).
function renderEmbedded(
  ctx: Partial<ChatOutletContext> = {},
  path = "/agents/a1/chat/c1",
) {
  render(
    <AppearanceProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/agents/:agentId/chat"
              element={
                <Outlet
                  context={
                    {
                      hrefFor: (id: string) => `/agents/a1/chat/${id}`,
                      agentName: "Realtor",
                      ...ctx,
                    } satisfies ChatOutletContext
                  }
                />
              }
            >
              <Route path=":conversationId" element={<ConversationView />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </AppearanceProvider>,
  );
}

describe("ConversationPage", () => {
  beforeEach(() => {
    sendSpy.mockReset();
    mockGetConversation.mockReset();
    mockRenameConversation.mockReset();
    installHookMock();
    mockGetConversation.mockResolvedValue({
      id: "c1",
      agentId: "a1",
      title: "Roadmap chat",
      created_at: "2026-05-25T10:00:00.000Z",
      updated_at: "2026-05-25T10:00:00.000Z",
      messages: [],
    });
    mockRenameConversation.mockResolvedValue({
      id: "c1",
      agentId: "a1",
      title: "Q3 planning",
      created_at: "2026-05-25T10:00:00.000Z",
      updated_at: "2026-05-25T10:00:00.000Z",
    });
  });

  it("appends a user message and calls the hook's send", async () => {
    renderAt();
    await screen.findByRole("button", { name: /Roadmap chat/ });

    const box = screen.getByLabelText("Message");
    await userEvent.type(box, "Ship it{Enter}");

    expect(sendSpy).toHaveBeenCalledWith("Ship it");
    expect(await screen.findByText("Ship it")).toBeInTheDocument();
  });

  it("renames the conversation from the inline title editor", async () => {
    renderAt();
    const titleButton = await screen.findByRole("button", {
      name: /Roadmap chat/,
    });

    await userEvent.click(titleButton);
    const titleInput = screen.getByLabelText("Conversation title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Q3 planning{Enter}");

    expect(mockRenameConversation).toHaveBeenCalledWith(
      "a1",
      "c1",
      "Q3 planning",
    );
  });

  it("omits the expand toggle on the standalone page (no rail to fill)", async () => {
    renderAt();
    await screen.findByRole("button", { name: /Roadmap chat/ });

    expect(
      screen.queryByRole("button", { name: /Expand chat|Collapse chat/ }),
    ).toBeNull();
  });

  it("renders the expand toggle when embedded and fires the handler", async () => {
    const onToggleExpand = vi.fn();
    renderEmbedded({ expanded: false, onToggleExpand });
    await screen.findByRole("button", { name: /Roadmap chat/ });

    const toggle = screen.getByRole("button", { name: "Expand chat" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("shows a collapse affordance once expanded", async () => {
    renderEmbedded({ expanded: true, onToggleExpand: vi.fn() });
    await screen.findByRole("button", { name: /Roadmap chat/ });

    const toggle = screen.getByRole("button", { name: "Collapse chat" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});
