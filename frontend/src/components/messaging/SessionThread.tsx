import { useEffect, useState } from "react";
import { listSessionMessages, type MessagingMessage } from "@/api/messaging";
import { Badge, Banner, Spinner, Text } from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./SessionThread.module.css";

export interface SessionThreadProps {
  agentId: string;
  sessionId: string;
}

/** Short local time for a message timestamp (ms epoch). */
function formatTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * SessionThread - one text session's transcript (PRD §9.5). Outbound (agent)
 * turns align right; inbound (contact) turns align left. SMS bodies are plain
 * text, so no markdown rendering. Each bubble shows its sender + a channel badge.
 */
export function SessionThread({ agentId, sessionId }: SessionThreadProps) {
  const [messages, setMessages] = useState<MessagingMessage[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setError(null);
    listSessionMessages(agentId, sessionId)
      .then((loaded) => {
        if (!cancelled) setMessages(loaded);
      })
      .catch((err) => {
        if (!cancelled) setError(err as Error);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId]);

  if (error) {
    return (
      <Banner variant="danger" title="Couldn't load this thread">
        Please try again.
      </Banner>
    );
  }
  if (!messages) {
    return (
      <div className={styles.state}>
        <Spinner size="sm" label="Loading messages" />
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <Text size="sm" color="text-muted">
        No messages in this thread.
      </Text>
    );
  }

  return (
    <div className={styles.thread} role="log" aria-label="Message transcript">
      {messages.map((message) => {
        const outbound = message.direction === "out";
        const sender = outbound ? "Agent" : message.from;
        return (
          <div
            key={message.seq}
            className={cx(styles.row, outbound && styles.outbound)}
          >
            <div className={styles.meta}>
              <Text size="xs" weight="medium">
                {sender}
              </Text>
              <Badge variant="neutral" appearance="subtle" size="sm">
                {message.channel}
              </Badge>
              <Text size="xs" color="text-muted">
                {formatTime(message.ts)}
              </Text>
            </div>
            <div
              className={cx(
                styles.bubble,
                outbound ? styles.outBubble : styles.inBubble,
              )}
            >
              {message.body}
            </div>
          </div>
        );
      })}
    </div>
  );
}
