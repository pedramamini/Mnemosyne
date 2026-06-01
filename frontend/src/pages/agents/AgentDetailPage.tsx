import { useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { type Agent, getAgent } from "@/api/agents";
import { ApiError } from "@/api/client";
import { OnboardingProgress } from "@/components/agents/OnboardingProgress";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAgentAvatars } from "@/components/layout/useAgentAvatars";
import {
  Avatar,
  Badge,
  type BadgeVariant,
  Banner,
  Button,
  EmptyState,
  Heading,
  Inline,
  Page,
  RoutedTabs,
  Spinner,
  Stack,
  Text,
} from "@/components/ui";
import styles from "./AgentDetailPage.module.css";

/** Outlet context shared with every tab panel rendered under the detail shell. */
export interface AgentDetailContext {
  agent: Agent;
  /** Called by the Settings tab after a successful save to refresh the shell. */
  onAgentUpdated: (agent: Agent) => void;
}

/** Tab panels read the loaded agent + the update callback from the shell. */
export function useAgentDetail(): AgentDetailContext {
  return useOutletContext<AgentDetailContext>();
}

/** Map a free-form lifecycle status to a Badge variant. */
function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "building":
      return "primary";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

const TABS = [
  { label: "Chat", to: "chat" },
  { label: "Messaging", to: "messaging" },
  { label: "Reports", to: "reports" },
  { label: "Brain", to: "brain" },
  { label: "Graph", to: "graph" },
  { label: "Audit", to: "audit" },
  { label: "Settings", to: "settings" },
  { label: "Metadata", to: "metadata" },
];

type LoadState = "loading" | "ready" | "not-found" | "error";

/**
 * AgentDetailPage (MNEMO-36), mounted at `/agents/:agentId/*` under
 * `<RequireAuth>`. Fetches the agent, renders the header (avatar + name +
 * template + status) and the routed `RoutedTabs` strip, and hosts the per-tab
 * panels via the nested `<Outlet/>`. A bare `/agents/:agentId` redirects to the
 * Chat tab (the index route in `App.tsx`); a 404 shows a "not found" empty state.
 */
export function AgentDetailPage() {
  const { agentId = "" } = useParams();
  const navigate = useNavigate();
  const { avatarOf } = useAgentAvatars();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setAgent(null);
    getAgent(agentId)
      .then((loaded) => {
        if (cancelled) return;
        setAgent(loaded);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setState(
          err instanceof ApiError && err.status === 404 ? "not-found" : "error",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (state === "loading") {
    return (
      <AppLayout>
        <div className={styles.center}>
          <Spinner size="lg" label="Loading agent" />
        </div>
      </AppLayout>
    );
  }

  if (state === "not-found" || !agent) {
    return (
      <AppLayout>
        <Page style={{ paddingBlock: "var(--space-7)" }}>
          {state === "error" ? (
            <Banner variant="danger" title="Something went wrong">
              Couldn't load this agent. Please try again.
            </Banner>
          ) : (
            <EmptyState
              title="Agent not found"
              description="This agent doesn't exist or you don't have access to it."
              action={
                <Button variant="secondary" onClick={() => navigate("/agents")}>
                  Back to agents
                </Button>
              }
            />
          )}
        </Page>
      </AppLayout>
    );
  }

  const context: AgentDetailContext = { agent, onAgentUpdated: setAgent };

  return (
    <AppLayout>
      <Page style={{ paddingBlock: "var(--space-6)" }}>
        <Stack gap="5">
          <Inline gap="3" align="center" className={styles.header}>
            <Avatar name={agent.name} src={avatarOf(agent.id)} size="lg" />
            <Stack gap="1" className={styles.headerText}>
              <Heading level={2}>{agent.name}</Heading>
              <Inline gap="2" align="center">
                {agent.template && (
                  <Badge variant="primary" appearance="subtle">
                    {agent.template}
                  </Badge>
                )}
                <Badge variant={statusVariant(agent.status)}>
                  {agent.status}
                </Badge>
              </Inline>
            </Stack>
          </Inline>

          {agent.description && (
            <Text color="text-muted">{agent.description}</Text>
          )}

          {/* Shown only while a freshly-built agent runs its initial deep dive
              (self-collapses once the dive settles). */}
          <OnboardingProgress agentId={agent.id} />

          <RoutedTabs
            label={`${agent.name} sections`}
            tabs={TABS}
            outletContext={context}
          />
        </Stack>
      </Page>
    </AppLayout>
  );
}
