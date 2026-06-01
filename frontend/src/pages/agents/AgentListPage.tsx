import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AGENT_TEMPLATES, type Agent, listAgents } from "@/api/agents";
import { AgentGrid } from "@/components/agents/AgentGrid";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  Banner,
  Button,
  EmptyState,
  Heading,
  Icon,
  Inline,
  Page,
  SearchInput,
  Select,
  Spinner,
  Stack,
} from "@/components/ui";
import styles from "./AgentListPage.module.css";

/** Filter value: a specific template or "all". */
type TemplateFilter = "all" | (typeof AGENT_TEMPLATES)[number];

const TEMPLATE_OPTIONS = [
  { label: "All templates", value: "all" },
  ...AGENT_TEMPLATES.map((t) => ({
    label: t.charAt(0).toUpperCase() + t.slice(1),
    value: t,
  })),
];

/**
 * AgentListPage (MNEMO-34, mounted at `/agents`) - the home of the app. Fetches
 * the account's agents on mount and renders a responsive grid, with client-side
 * search (name/description) and a template filter (§6.6). Search/filter are
 * client-side over the fetched list (the registry is small per account). A
 * prominent "New agent" action heads to the create wizard.
 */
export function AgentListPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState<TemplateFilter>("all");

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setAgents(null);
    listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Couldn't load your agents. Please try again.");
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!agents) return [];
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (template !== "all" && a.template !== template) return false;
      if (!q) return true;
      const haystack = `${a.name} ${a.description ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [agents, query, template]);

  const newAgentButton = (
    <Button
      leftIcon={<Icon icon={Plus} size="sm" />}
      onClick={() => navigate("/agents/new")}
    >
      New agent
    </Button>
  );

  return (
    <AppLayout>
      <Page style={{ paddingBlock: "var(--space-6)" }}>
        <Stack gap="6">
          {error && (
            <Banner variant="danger" title="Something went wrong">
              {error}
            </Banner>
          )}

          <Inline justify="between" align="center" gap="3" wrap>
            <Heading level={1} variant="display">
              Agents
            </Heading>
            {newAgentButton}
          </Inline>

          <Inline gap="3" align="center" className={styles.toolbar}>
            <div className={styles.search}>
              <SearchInput
                aria-label="Search agents"
                placeholder="Search agents…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery("")}
              />
            </div>
            <div className={styles.filter}>
              <Select
                aria-label="Filter by template"
                value={template}
                options={TEMPLATE_OPTIONS}
                onChange={(e) => setTemplate(e.target.value as TemplateFilter)}
              />
            </div>
          </Inline>

          {agents === null ? (
            <div className={styles.center}>
              <Spinner size="lg" label="Loading agents" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={
                agents.length === 0
                  ? "No agents yet - create your first"
                  : "No agents match your filters"
              }
              description={
                agents.length === 0
                  ? "Spin up a research agent and it'll start watching what matters to you."
                  : "Try a different search term or template filter."
              }
            />
          ) : (
            <AgentGrid agents={filtered} />
          )}
        </Stack>
      </Page>
    </AppLayout>
  );
}
