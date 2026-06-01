import type { Agent } from "@/api/agents";
import { statusVariant } from "@/components/agents/AgentCard";
import { BrainSizeBadge } from "@/components/graph/BrainSizeBadge";
import {
  Avatar,
  Badge,
  Button,
  Inline,
  Panel,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./AgentCard.module.css";
import { EditableAgentAvatar } from "./EditableAgentAvatar";

/** The brain-size metric a card renders ("N neurons · M synapses"). */
export interface BrainSizeMetric {
  neurons: number;
  synapses: number;
}

export interface AgentCardProps {
  agent: Agent;
  /** Brain-size metric for this agent, or `undefined` while loading / on error. */
  brainSize: BrainSizeMetric | undefined;
  /** True while this card's brain-size is still in flight. */
  brainSizeLoading: boolean;
  /** Open the agent's detail page. The card owns no route knowledge. */
  onOpen: () => void;
  /** Current custom avatar (data URL); falls back to initials when absent. */
  avatarSrc?: string;
  /**
   * Handle a picked avatar image. When provided, the avatar becomes a
   * click-to-change upload trigger; when omitted, it renders read-only.
   */
  onAvatarSelect?: (file: File) => void;
}

/** Format an ISO timestamp as a short date; falls back to the raw value. */
function formatCreated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * Dashboard AgentCard (MNEMO-42) - a presentational metrics card for one agent:
 * avatar + name, a template badge, a status badge, a two-line-clamped description,
 * the created date, and the brain-size badge ("N neurons · M synapses", reused
 * from MNEMO-40). The brain-size renders "-" while `brainSizeLoading` or when
 * `brainSize` is undefined (graceful degradation - one card's metric never blocks
 * the grid). Built exclusively from the shared UI library; navigation is delegated
 * to `onOpen` so the card stays route-agnostic. Presentational only.
 */
export function AgentCard({
  agent,
  brainSize,
  brainSizeLoading,
  onOpen,
  avatarSrc,
  onAvatarSelect,
}: AgentCardProps) {
  const showMetric = !brainSizeLoading && brainSize !== undefined;
  return (
    <Panel className={styles.card} padding="4">
      <Stack gap="3" style={{ height: "100%" }}>
        <Inline gap="3" align="start" justify="between" wrap={false}>
          <Inline
            gap="3"
            align="center"
            wrap={false}
            className={styles.identity}
          >
            {onAvatarSelect ? (
              <EditableAgentAvatar
                name={agent.name}
                src={avatarSrc}
                size="md"
                onSelect={onAvatarSelect}
              />
            ) : (
              <Avatar name={agent.name} src={avatarSrc} size="md" />
            )}
            {/* The name opens the agent (same as the Open action); route
                knowledge stays with the parent via onOpen. */}
            <Button
              variant="link"
              onClick={onOpen}
              className={styles.name}
              title={agent.name}
            >
              <Text weight="semibold" truncate>
                {agent.name}
              </Text>
            </Button>
          </Inline>
          <Badge variant={statusVariant(agent.status)} appearance="subtle">
            {agent.status}
          </Badge>
        </Inline>

        <Text
          size="sm"
          color="text-muted"
          className={styles.description}
          as="p"
        >
          {agent.description?.trim() || "No description yet."}
        </Text>

        <Inline gap="2" align="center">
          {agent.template && <Badge variant="primary">{agent.template}</Badge>}
          <Text size="sm" color="text-muted">
            Created {formatCreated(agent.created_at)}
          </Text>
        </Inline>

        <Inline
          gap="3"
          align="center"
          justify="between"
          wrap={false}
          className={styles.footer}
        >
          {showMetric ? (
            <BrainSizeBadge
              neurons={brainSize.neurons}
              synapses={brainSize.synapses}
            />
          ) : (
            <Badge
              variant="neutral"
              appearance="subtle"
              aria-label="Brain size: not available yet"
            >
              -
            </Badge>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpen}
            aria-label={`Open ${agent.name}`}
          >
            Open
          </Button>
        </Inline>
      </Stack>
    </Panel>
  );
}
