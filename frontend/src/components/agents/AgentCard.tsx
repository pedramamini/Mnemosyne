import { Link } from "react-router-dom";
import type { Agent } from "@/api/agents";
import {
  Avatar,
  Badge,
  type BadgeVariant,
  Inline,
  Panel,
  Stack,
  Text,
} from "@/components/ui";
import { cx } from "@/components/ui/utils";
import styles from "./AgentCard.module.css";

export interface AgentCardProps {
  agent: Agent;
}

/** Map a free-form lifecycle status onto a status-dot color role. */
export function statusVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case "active":
    case "live":
    case "running":
      return "success";
    case "error":
    case "failed":
      return "danger";
    case "draft":
    case "building":
    case "discovering":
    case "paused":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * AgentCard - a presentational card for one agent: avatar, name, truncated
 * description, template badge, and a status dot. The whole card is a router
 * `<Link>` to `/agents/:id` (the only interactive element, so it stays a11y-clean
 * and supports cmd-click; raw `<a>` is banned outside the UI library - `<Link>`
 * routes through react-router per the lint rule).
 */
export function AgentCard({ agent }: AgentCardProps) {
  const variant = statusVariant(agent.status);
  return (
    <Link
      to={`/agents/${agent.id}`}
      className={styles.link}
      aria-label={`Open ${agent.name}`}
    >
      <Panel className={styles.card} padding="4">
        <Stack gap="3">
          <Inline gap="3" align="start" justify="between" wrap={false}>
            <Inline
              gap="3"
              align="center"
              wrap={false}
              className={styles.identity}
            >
              <Avatar name={agent.name} size="md" />
              <Text weight="semibold" truncate title={agent.name}>
                {agent.name}
              </Text>
            </Inline>
            <span
              role="img"
              className={cx(styles.statusDot, styles[`status_${variant}`])}
              aria-label={`Status: ${agent.status}`}
              title={agent.status}
            />
          </Inline>

          <Text
            size="sm"
            color="text-muted"
            className={styles.description}
            as="p"
          >
            {agent.description?.trim() || "No description yet."}
          </Text>

          {agent.template && (
            <Inline gap="2">
              <Badge variant="primary">{agent.template}</Badge>
            </Inline>
          )}
        </Stack>
      </Panel>
    </Link>
  );
}
