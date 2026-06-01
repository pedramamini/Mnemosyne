import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Agent } from "@/api/agents";
import { AgentCard } from "@/components/dashboard/AgentCard";
import { AgentFilters } from "@/components/dashboard/AgentFilters";
import {
  filterAndSortAgents,
  type SortBy,
  type StatusFilter,
  type TemplateFilter,
  useAgents,
  useBrainSize,
} from "@/components/dashboard/useAgentMetrics";
import { useIsMobile } from "@/components/layout";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAgentAvatars } from "@/components/layout/useAgentAvatars";
import {
  Banner,
  Button,
  EmptyState,
  Grid,
  Heading,
  Icon,
  Inline,
  Page,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import { resizeImageToDataUrl } from "@/lib/resizeImage";

/**
 * One grid cell: fetches its agent's brain-size INDEPENDENTLY (so metrics stream
 * in per card without blocking the grid) and renders the presentational card.
 * Each instance owns its own `useBrainSize` hook - a failing metric degrades to
 * "-" on that one card alone.
 */
function MetricAgentCard({
  agent,
  onOpen,
  avatarSrc,
  onAvatarSelect,
}: {
  agent: Agent;
  onOpen: () => void;
  avatarSrc?: string;
  onAvatarSelect: (file: File) => void;
}) {
  const { data, loading } = useBrainSize(agent.id);
  return (
    <AgentCard
      agent={agent}
      brainSize={
        data ? { neurons: data.neurons, synapses: data.synapses } : undefined
      }
      brainSizeLoading={loading}
      onOpen={onOpen}
      avatarSrc={avatarSrc}
      onAvatarSelect={onAvatarSelect}
    />
  );
}

/**
 * DashboardPage (MNEMO-42, mounted at `/agents`) - the agent management & metrics
 * dashboard. Fetches the account's agents, holds the search/filter/sort state, and
 * renders `AgentFilters` above a responsive grid of metric cards. Per PRD §6.6:
 * list/filter/search agents, each card showing key metadata plus the brain-size
 * metric (neurons + synapses) streamed in per card. Supersedes the bare MNEMO-34
 * list as the management view; the "New agent" action reuses the MNEMO-34 wizard.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const { agents, loading, error } = useAgents();
  const { avatarOf, setAvatar } = useAgentAvatars();
  const isMobile = useIsMobile();

  // Resize the picked image to a small data URL and persist it per agent.
  // The picker already filters to images; unreadable files are ignored.
  const onAvatarSelect = useCallback(
    async (agentId: string, file: File) => {
      try {
        setAvatar(agentId, await resizeImageToDataUrl(file));
      } catch {
        // Unsupported/corrupt image - leave the existing avatar untouched.
      }
    },
    [setAvatar],
  );

  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState<TemplateFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("name");

  const visible = useMemo(
    () =>
      agents
        ? filterAndSortAgents(agents, { query, template, status, sortBy })
        : [],
    [agents, query, template, status, sortBy],
  );

  const newAgentButton = (
    <Button
      leftIcon={<Icon icon={Plus} size="sm" />}
      onClick={() => navigate("/agents/new")}
    >
      New agent
    </Button>
  );

  const total = agents?.length ?? 0;

  return (
    <AppLayout>
      <Page style={{ paddingBlock: "var(--space-6)" }}>
        <Stack gap="6">
          {error && (
            <Banner variant="danger" title="Something went wrong">
              Couldn't load your agents. Please try again.
            </Banner>
          )}

          <Inline justify="between" align="center" gap="3" wrap>
            <Inline gap="2" align="baseline">
              <Heading level={1} variant="display">
                Agents
              </Heading>
              {agents && (
                <Text size="sm" color="text-muted">
                  {total} {total === 1 ? "agent" : "agents"}
                </Text>
              )}
            </Inline>
            {newAgentButton}
          </Inline>

          <AgentFilters
            query={query}
            template={template}
            status={status}
            sortBy={sortBy}
            onQueryChange={setQuery}
            onTemplateChange={setTemplate}
            onStatusChange={setStatus}
            onSortByChange={setSortBy}
          />

          {loading ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                paddingBlock: "var(--space-10)",
              }}
            >
              <Spinner size="lg" label="Loading agents" />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={
                total === 0
                  ? "No agents yet - create your first"
                  : "No agents match your filters"
              }
              description={
                total === 0
                  ? "Spin up a research agent and it'll start watching what matters to you."
                  : "Try a different search term, template, or status filter."
              }
            />
          ) : (
            <Grid
              // Single column on mobile; an auto-fit responsive grid on desktop.
              columns={1}
              minColumnWidth={isMobile ? undefined : "18rem"}
              gap="4"
              data-testid="agent-grid"
            >
              {visible.map((agent) => (
                <MetricAgentCard
                  key={agent.id}
                  agent={agent}
                  onOpen={() => navigate(`/agents/${agent.id}`)}
                  avatarSrc={avatarOf(agent.id)}
                  onAvatarSelect={(file) => onAvatarSelect(agent.id, file)}
                />
              ))}
            </Grid>
          )}
        </Stack>
      </Page>
    </AppLayout>
  );
}
