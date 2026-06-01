import { useEffect, useState } from "react";
import { ResponsiveMasterDetail, useIsMobile } from "@/components/layout";
import {
  ReportList,
  type ReportListItem,
} from "@/components/reports/ReportList";
import { ReportSearchBox } from "@/components/reports/ReportSearchBox";
import { ReportViewer } from "@/components/reports/ReportViewer";
import {
  useReport,
  useReportSearch,
  useReports,
} from "@/components/reports/useReports";
import { Banner, Inline, Panel, Spinner, Stack, Text } from "@/components/ui";
import styles from "./ReportsTab.module.css";

export interface ReportsTabProps {
  agentId: string;
  /**
   * Report to preselect on mount / when the deep-link param changes - set from the
   * `?report=<id>` query (e.g. following a glass-cockpit "View report" link).
   */
  initialReportId?: string;
}

/**
 * ReportsTab (MNEMO-41, PRD §6.4) - the agent-detail "Reports" tab: a report
 * archive viewer with full-text search. The left pane is a `ReportSearchBox` over
 * a `ReportList` that shows the full report list (from `useReports`) or, once a
 * query is present, the search hits (from `useReportSearch`); the right pane is a
 * `ReportViewer` for the selected report (from `useReport`), rendering its
 * Obsidian front matter + markdown body + embedded PNG charts. Owns the selected-
 * report + query state and handles loading/empty/error states. Replaces the
 * MNEMO-36 placeholder.
 */
export function ReportsTab({ agentId, initialReportId }: ReportsTabProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialReportId ?? null,
  );
  const isMobile = useIsMobile();

  // Follow the deep-link param: selecting a report from the cockpit (or arriving
  // via a shared `?report=` URL) preselects it, even if the tab is already open.
  useEffect(() => {
    if (initialReportId) setSelectedId(initialReportId);
  }, [initialReportId]);

  const isSearching = query.trim().length > 0;
  const {
    reports,
    loading: listLoading,
    error: listError,
  } = useReports(agentId);
  const {
    hits,
    loading: searchLoading,
    error: searchError,
  } = useReportSearch(agentId, query);
  const {
    report,
    loading: reportLoading,
    error: reportError,
  } = useReport(agentId, selectedId);

  const items: ReportListItem[] = isSearching
    ? hits.map((h) => ({
        id: h.id,
        title: h.title,
        createdAt: h.createdAt,
        snippet: h.snippet,
      }))
    : reports.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
      }));

  const loading = isSearching ? searchLoading : listLoading;
  const error = isSearching ? searchError : listError;

  const list = (
    <Panel padding="3" className={styles.listPane}>
      <Stack gap="3">
        <ReportSearchBox value={query} onQueryChange={setQuery} />

        {error ? (
          <Banner variant="danger" title="Couldn't load reports">
            {error.message}
          </Banner>
        ) : loading ? (
          <Inline gap="2" align="center">
            <Spinner label="Loading reports" />
            <Text color="text-muted">
              {isSearching ? "Searching…" : "Loading reports…"}
            </Text>
          </Inline>
        ) : (
          <ReportList
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            isSearchResults={isSearching}
            query={query.trim()}
          />
        )}
      </Stack>
    </Panel>
  );

  const viewer = (
    <div className={styles.viewerPane}>
      {reportError ? (
        <Panel padding="4">
          <Banner variant="danger" title="Couldn't load this report">
            {reportError.message}
          </Banner>
        </Panel>
      ) : (
        <ReportViewer
          report={report}
          isLoading={Boolean(selectedId) && reportLoading}
          // On mobile the master/detail back control owns the return-to-list
          // affordance; on desktop the viewer keeps its own deselect "Back".
          onClose={
            !isMobile && selectedId ? () => setSelectedId(null) : undefined
          }
        />
      )}
    </div>
  );

  // Master/detail: on mobile the report list shows first; selecting a report
  // pushes the viewer over it with a back control (selection drives `showDetail`).
  return (
    <ResponsiveMasterDetail
      master={list}
      detail={viewer}
      showDetail={selectedId !== null}
      onBack={() => setSelectedId(null)}
      backLabel="Back to reports"
      masterWidth="22rem"
    />
  );
}
