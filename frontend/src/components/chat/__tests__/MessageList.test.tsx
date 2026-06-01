import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/api/conversations";
import { MessageList } from "../MessageList";

const messages: ChatMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Hello there" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "**Hi!** How can I help?" }],
  },
];

describe("MessageList", () => {
  it("renders user and assistant messages in document order", () => {
    render(
      <MessageList
        messages={messages}
        agentId="agent-1"
        agentName="Acme Agent"
      />,
    );
    const user = screen.getByText("Hello there");
    const assistant = screen.getByText("Hi!");
    expect(user).toBeInTheDocument();
    expect(assistant).toBeInTheDocument();
    // User turn precedes the assistant turn in the DOM.
    expect(
      user.compareDocumentPosition(assistant) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows the agent avatar on assistant messages", () => {
    render(
      <MessageList
        messages={messages}
        agentId="agent-1"
        agentName="Acme Agent"
      />,
    );
    expect(screen.getByRole("img", { name: "Acme Agent" })).toBeInTheDocument();
  });

  it("renders assistant text as markdown (bold → <strong>)", () => {
    render(
      <MessageList
        messages={messages}
        agentId="agent-1"
        agentName="Acme Agent"
      />,
    );
    expect(screen.getByText("Hi!").tagName).toBe("STRONG");
  });

  it("shows the typing indicator while streaming", () => {
    render(
      <MessageList
        messages={messages}
        status="streaming"
        agentId="agent-1"
        agentName="Acme Agent"
      />,
    );
    expect(screen.getByLabelText("Assistant is typing")).toBeInTheDocument();
  });

  it("hides the typing indicator when not streaming", () => {
    render(
      <MessageList
        messages={messages}
        status="ready"
        agentId="agent-1"
        agentName="Acme Agent"
      />,
    );
    expect(screen.queryByLabelText("Assistant is typing")).toBeNull();
  });
});
