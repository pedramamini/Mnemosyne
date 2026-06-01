import { useParams, useSearchParams } from "react-router-dom";
import { ReportsTab as ReportsTabView } from "@/pages/agent/ReportsTab";

/**
 * ReportsTab (MNEMO-41) - the agent-detail "Reports" tab. A thin route adapter
 * (like the Brain/Graph tabs) that pulls `agentId` from `/agents/:agentId/reports`
 * and hands it to the composed report viewer + full-text search screen. Also reads
 * the optional `?report=<id>` deep-link (set by the glass-cockpit "View report"
 * link) so arriving from an audit event opens that report. Replaces the MNEMO-36
 * placeholder panel.
 */
export function ReportsTab() {
  const { agentId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const initialReportId = searchParams.get("report") ?? undefined;
  return <ReportsTabView agentId={agentId} initialReportId={initialReportId} />;
}
