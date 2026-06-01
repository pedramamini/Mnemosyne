import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/api/conversations";
import { MessageBubble } from "./MessageBubble";
import styles from "./MessageList.module.css";
import type { ChatStatus } from "./useAgentChat";

export interface MessageListProps {
  messages: ChatMessage[];
  /** Streaming lifecycle status; drives the in-progress typing indicator. */
  status?: ChatStatus;
  /** Owning agent - scopes the (auth-guarded) artifact iframe URLs in bubbles. */
  agentId: string;
  agentName: string;
  agentAvatarUrl?: string;
}

/** Treat the view as "at bottom" within this many px of the end. */
const BOTTOM_THRESHOLD = 48;

/**
 * MessageList (MNEMO-35) - the ordered transcript. Auto-scrolls to the newest
 * content as it streams, but ONLY when the user is already pinned to the bottom
 * (scrolling up to read history is never yanked away). A trailing typing
 * indicator bubble appears when a turn is in flight before the assistant's
 * message has begun streaming.
 */
export function MessageList({
  messages,
  status,
  agentId,
  agentName,
  agentAvatarUrl,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distance <= BOTTOM_THRESHOLD;
  }

  // Stick to the bottom on new content/streaming ticks, unless scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin on transcript/stream changes.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const streaming = status === "streaming" || status === "submitted";
  const last = messages.at(-1);
  // A pending assistant turn: we're streaming but the assistant bubble hasn't
  // been appended yet (the last message is still the user's).
  const showPendingAssistant = streaming && (!last || last.role === "user");

  return (
    <div
      ref={listRef}
      className={styles.list}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-label="Conversation transcript"
    >
      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          agentId={agentId}
          agentName={agentName}
          agentAvatarUrl={agentAvatarUrl}
          streaming={
            streaming &&
            message.role === "assistant" &&
            index === messages.length - 1
          }
        />
      ))}
      {showPendingAssistant && (
        <MessageBubble
          message={{ id: "pending", role: "assistant", parts: [] }}
          agentId={agentId}
          agentName={agentName}
          agentAvatarUrl={agentAvatarUrl}
          streaming
        />
      )}
    </div>
  );
}
