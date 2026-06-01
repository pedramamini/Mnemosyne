import { RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { GraphNode } from "@/api/graph";
import { BrainGraphCanvas } from "@/components/graph/BrainGraphCanvas";
import { BrainSizeBadge } from "@/components/graph/BrainSizeBadge";
import { useBrainGraph } from "@/components/graph/useBrainGraph";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  Inline,
  Panel,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./BrainGraphTab.module.css";

export interface BrainGraphTabProps {
  agentId: string;
  /**
   * Optional start neuron slug to seed the bounded map (MNEMO-09 traverses from a
   * start). Omitted on the default tab view; the brain-size badge always shows
   * true whole-brain totals regardless (see `@/api/graph`).
   */
  start?: string;
}

/**
 * BrainGraphTab (MNEMO-40, PRD §6.2 / §4) - the composed "Graph" tab. Fetches the
 * brain graph via `useBrainGraph`, renders the brain-size badge + a Refresh
 * control (so users watch the map grow as the agent works), and the force-directed
 * `BrainGraphCanvas`. Clicking a neuron deep-links into the Brain explorer
 * (MNEMO-38) focused on that neuron's path. Handles loading / error / empty-brain
 * states. Presentational composition only - data lives in the hook.
 */
export function BrainGraphTab({ agentId, start }: BrainGraphTabProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useBrainGraph(agentId, { start });

  function handleNodeClick(node: GraphNode): void {
    // Deep-link into the Brain explorer (MNEMO-38) focused on this neuron's path.
    // Dangling (pathless) nodes have no file to open, so they're a no-op.
    if (!node.path) return;
    navigate(
      `/agents/${encodeURIComponent(agentId)}/brain?path=${encodeURIComponent(
        node.path,
      )}`,
    );
  }

  function body() {
    if (loading) {
      return (
        <div className={styles.center}>
          <Inline gap="2" align="center">
            <Spinner label="Loading brain graph" />
            <Text color="text-muted">Loading the brain map…</Text>
          </Inline>
        </div>
      );
    }
    if (error) {
      return (
        <div className={styles.center}>
          <Banner variant="danger" title="Couldn't load the brain graph">
            {error.message}
          </Banner>
        </div>
      );
    }
    if (data.brainSize.neurons === 0) {
      return (
        <div className={styles.center}>
          <EmptyState
            title="No neurons yet"
            description="This brain has no neurons to map yet. It fills in as the agent writes notes and links them with [[wikilinks]]."
          />
        </div>
      );
    }
    if (data.nodes.length === 0) {
      return (
        <div className={styles.center}>
          <EmptyState
            title="Nothing to explore here yet"
            description="Open a neuron from the Brain tab to map its connections."
          />
        </div>
      );
    }
    return (
      <BrainGraphCanvas
        nodes={data.nodes}
        links={data.links}
        onNodeClick={handleNodeClick}
      />
    );
  }

  return (
    <Stack gap="4">
      <Inline gap="3" justify="between" align="center" wrap>
        {!loading && !error && data.brainSize.neurons > 0 ? (
          <BrainSizeBadge
            neurons={data.brainSize.neurons}
            synapses={data.brainSize.synapses}
          />
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Icon icon={RefreshCw} size="sm" />}
          onClick={refetch}
          disabled={loading}
        >
          Refresh
        </Button>
      </Inline>

      <Panel padding="2" className={styles.canvasPanel}>
        {body()}
      </Panel>
    </Stack>
  );
}
