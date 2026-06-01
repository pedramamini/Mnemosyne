import { useParams } from "react-router-dom";
import { BrainGraphTab } from "@/pages/agent/BrainGraphTab";

/**
 * GraphTab (MNEMO-40) - the agent-detail "Graph" tab. A thin route adapter (like
 * the other tabs) that pulls `agentId` from `/agents/:agentId/graph` and hands it
 * to the composed `BrainGraphTab` (brain-size badge + force-directed brain map).
 */
export function GraphTab() {
  const { agentId = "" } = useParams();
  return <BrainGraphTab agentId={agentId} />;
}
