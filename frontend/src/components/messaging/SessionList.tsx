import { Users } from "lucide-react";
import type { MessagingSession } from "@/api/messaging";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Icon,
  Inline,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./SessionList.module.css";

export interface SessionListProps {
  sessions: MessagingSession[] | null;
  loading: boolean;
  error: Error | null;
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
}

/** A friendly label for a session's counterparty (group threads have no number). */
function sessionTitle(session: MessagingSession): string {
  return session.kind === "group" ? "Group thread" : session.counterparty;
}

/**
 * SessionList - the messaging conversation rail (PRD §9.5): every text thread
 * (newest first) with a channel badge, a group marker, message count, and day.
 * Selecting one is a local action (the tab owns the active id), so rows are
 * Buttons, not links.
 */
export function SessionList({
  sessions,
  loading,
  error,
  activeSessionId,
  onSelect,
}: SessionListProps) {
  if (loading) {
    return (
      <div className={styles.state}>
        <Spinner size="sm" label="Loading conversations" />
      </div>
    );
  }
  if (error) {
    return (
      <Banner variant="danger" title="Couldn't load conversations">
        Please try again.
      </Banner>
    );
  }
  if (!sessions || sessions.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Text threads with this agent will appear here."
      />
    );
  }

  return (
    <Stack gap="1">
      {sessions.map((session) => (
        <Button
          key={session.id}
          variant="ghost"
          fullWidth
          className={styles.row}
          data-active={session.id === activeSessionId || undefined}
          onClick={() => onSelect(session.id)}
        >
          <Stack gap="1" className={styles.rowInner}>
            <Inline gap="2" align="center" wrap={false}>
              {session.kind === "group" && <Icon icon={Users} size="sm" />}
              <Text weight="medium" truncate title={sessionTitle(session)}>
                {sessionTitle(session)}
              </Text>
            </Inline>
            <Inline gap="2" align="center" wrap>
              <Badge variant="neutral" appearance="subtle" size="sm">
                {session.channel}
              </Badge>
              {session.day && (
                <Text size="xs" color="text-muted">
                  {session.day}
                </Text>
              )}
              <Text size="xs" color="text-muted">
                {session.messageCount}{" "}
                {session.messageCount === 1 ? "message" : "messages"}
              </Text>
            </Inline>
          </Stack>
        </Button>
      ))}
    </Stack>
  );
}
