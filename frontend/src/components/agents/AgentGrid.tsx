import type { Agent } from "@/api/agents";
import { Grid } from "@/components/ui";
import { AgentCard } from "./AgentCard";

export interface AgentGridProps {
  agents: Agent[];
}

/**
 * AgentGrid - a responsive grid of `AgentCard`s. Built on the shared `Grid`
 * primitive's auto-fit mode (`minColumnWidth` → `minmax(min(width, 100%), 1fr)`),
 * which collapses to a single column on narrow viewports. Presentational only.
 */
export function AgentGrid({ agents }: AgentGridProps) {
  return (
    <Grid minColumnWidth="18rem" gap="4">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </Grid>
  );
}
