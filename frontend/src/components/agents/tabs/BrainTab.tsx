import { useParams } from "react-router-dom";
import { BrainExplorerTab } from "@/pages/agent/BrainExplorerTab";

/**
 * BrainTab (MNEMO-38) - the agent-detail "Brain" tab. Mirrors the other tabs:
 * a thin route adapter that pulls `agentId` from `/agents/:agentId/brain` and
 * hands it to the composed `BrainExplorerTab` explorer (file tree + editor +
 * create/delete + archive download).
 */
export function BrainTab() {
  const { agentId = "" } = useParams();
  return <BrainExplorerTab agentId={agentId} />;
}
