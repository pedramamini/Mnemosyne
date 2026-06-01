import { useParams } from "react-router-dom";
import { GlassCockpit } from "@/components/audit/GlassCockpit";

/**
 * AuditTab - the agent-detail Audit tab. MNEMO-37 fills in the MNEMO-36 stub with
 * the "glass cockpit": a live, filterable, searchable audit stream anchored by the
 * altitude toggle. The agent id comes from the `/agents/:agentId/audit` route.
 */
export function AuditTab() {
  const { agentId = "" } = useParams();
  return <GlassCockpit agentId={agentId} />;
}
