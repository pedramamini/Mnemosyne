import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MessagingSession } from "@/api/messaging";
import { SessionList } from "../SessionList";

const sessions: MessagingSession[] = [
  {
    id: "s1",
    counterparty: "+14155551212",
    threadId: null,
    channel: "sms",
    kind: "1to1",
    day: "2026-05-25",
    createdAt: 1,
    messageCount: 3,
  },
  {
    id: "s2",
    counterparty: "thread-9",
    threadId: "thread-9",
    channel: "sms",
    kind: "group",
    day: null,
    createdAt: 2,
    messageCount: 7,
  },
];

describe("SessionList", () => {
  it("renders a row per session with a group marker", () => {
    render(
      <SessionList
        sessions={sessions}
        loading={false}
        error={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("+14155551212")).toBeInTheDocument();
    expect(screen.getByText("Group thread")).toBeInTheDocument();
    expect(screen.getByText("3 messages")).toBeInTheDocument();
  });

  it("calls onSelect with the clicked session id", async () => {
    const onSelect = vi.fn();
    render(
      <SessionList
        sessions={sessions}
        loading={false}
        error={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByText("+14155551212"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("shows the empty state when there are no sessions", () => {
    render(
      <SessionList
        sessions={[]}
        loading={false}
        error={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
  });
});
