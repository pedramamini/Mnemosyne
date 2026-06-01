import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryRubric, DiscoveryState } from "@/api/discovery";
import { finalizeDiscovery, sendDiscoveryMessage } from "@/api/discovery";
import { DiscoveryChat } from "../DiscoveryChat";

// Mock the Discovery transport - DiscoveryChat is the unit under test.
vi.mock("@/api/discovery", () => ({
  sendDiscoveryMessage: vi.fn(),
  finalizeDiscovery: vi.fn(),
}));

const mockSend = vi.mocked(sendDiscoveryMessage);
const mockFinalize = vi.mocked(finalizeDiscovery);

const NO_FACETS: DiscoveryRubric = {
  subject: false,
  entityType: false,
  sources: false,
  cadence: false,
  outputFormat: false,
};

const ALL_FACETS: DiscoveryRubric = {
  subject: true,
  entityType: true,
  sources: true,
  cadence: true,
  outputFormat: true,
};

const initialState: DiscoveryState = {
  messages: [{ role: "assistant", content: "What should this agent track?" }],
  rubric: NO_FACETS,
  confidence: 0,
  ready: false,
};

function renderChat(onCreated = vi.fn()) {
  render(
    <DiscoveryChat
      discoveryId="agent-123"
      initialState={initialState}
      onCreated={onCreated}
    />,
  );
  return { onCreated };
}

describe("DiscoveryChat", () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockFinalize.mockReset();
  });

  it("shows progress but no create button while the gate is not ready", async () => {
    // One understood facet, gate still closed.
    mockSend.mockResolvedValueOnce({
      messages: [
        { role: "assistant", content: "Got it. How often should it run?" },
      ],
      rubric: { ...NO_FACETS, subject: true },
      confidence: 0.4,
      ready: false,
    });

    renderChat();
    expect(
      screen.getByText("What should this agent track?"),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("Your answer"),
      "Track Acme Corp",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(
      await screen.findByText("Got it. How often should it run?"),
    ).toBeInTheDocument();
    // Rubric reflects the returned facets (one of five understood).
    expect(screen.getByText(/1 of 5 facets understood/i)).toBeInTheDocument();
    // The gate is closed → no create affordance yet.
    expect(
      screen.queryByRole("button", { name: /create this agent/i }),
    ).toBeNull();
    expect(mockSend).toHaveBeenCalledWith("agent-123", "Track Acme Corp");
  });

  it("does not render a blank bubble for a whitespace-only assistant turn", () => {
    render(
      <DiscoveryChat
        discoveryId="agent-123"
        initialState={{
          messages: [{ role: "assistant", content: "   " }],
          rubric: NO_FACETS,
          confidence: 0,
          ready: false,
        }}
        onCreated={vi.fn()}
      />,
    );
    // The blank turn is filtered out, so the empty-state intro shows instead.
    expect(
      screen.getByText(
        /Tell Mnemosyne more about what this agent should track/i,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces the create button when ready and finalizes on click", async () => {
    mockSend.mockResolvedValueOnce({
      messages: [
        { role: "assistant", content: "I think I understand the scope." },
      ],
      rubric: ALL_FACETS,
      confidence: 0.92,
      ready: true,
    });
    mockFinalize.mockResolvedValueOnce({ agentId: "agent-123" });

    const { onCreated } = renderChat();

    await userEvent.type(screen.getByLabelText("Your answer"), "Weekly digest");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const createButton = await screen.findByRole("button", {
      name: /create this agent/i,
    });
    expect(screen.getByText(/5 of 5 facets understood/i)).toBeInTheDocument();

    await userEvent.click(createButton);

    await waitFor(() => expect(mockFinalize).toHaveBeenCalledWith("agent-123"));
    expect(onCreated).toHaveBeenCalledWith("agent-123");
  });
});
