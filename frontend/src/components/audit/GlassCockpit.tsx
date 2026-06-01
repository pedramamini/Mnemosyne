import { useCallback, useMemo, useState } from "react";
import type { AuditAltitude, AuditFilters } from "@/api/audit";
import { EmptyState, Panel, Spinner, Stack } from "@/components/ui";
import { AltitudeToggle } from "./AltitudeToggle";
import { AuditEventRow } from "./AuditEventRow";
import { AuditFilterBar } from "./AuditFilterBar";
import { AuditSearch, type AuditSearchState } from "./AuditSearch";
import { AuditStream } from "./AuditStream";
import styles from "./GlassCockpit.module.css";
import { useAuditStream } from "./useAuditStream";

/**
 * GlassCockpit (MNEMO-37) - the §6.7 "glass cockpit". Composes the altitude
 * toggle + FTS search + type/session/time filter bar (a sticky header) over the
 * live `AuditStream`, wired to `useAuditStream(agentId, filters, altitude)`.
 *
 * Default altitude is "Milestones" so a first-time, non-technical user lands on
 * the calm narrated stream with zero configuration; flipping to "Show the work"
 * reveals the raw command/code/reasoning/output. An active search swaps the live
 * tail for a results list (still honoring the altitude); clearing it resumes live.
 */
export interface GlassCockpitProps {
  agentId: string;
}

const EMPTY_SEARCH: AuditSearchState = {
  active: false,
  query: "",
  results: [],
  loading: false,
};

export function GlassCockpit({ agentId }: GlassCockpitProps) {
  const [altitude, setAltitude] = useState<AuditAltitude>("milestone");
  const [filters, setFilters] = useState<AuditFilters>({});
  const [search, setSearch] = useState<AuditSearchState>(EMPTY_SEARCH);

  const { events, status, loadOlder, hasOlder, loadingOlder } = useAuditStream(
    agentId,
    filters,
    altitude,
  );

  // Offer the sessions actually seen in the stream as the session-filter options.
  const sessions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) if (e.sessionId) set.add(e.sessionId);
    return [...set];
  }, [events]);

  const handleSearch = useCallback((s: AuditSearchState) => setSearch(s), []);
  const showDetail = altitude === "all";

  return (
    <Stack gap="4" className={styles.cockpit}>
      <Panel padding="4" className={styles.header}>
        <Stack gap="4">
          <div className={styles.headerTop}>
            <AltitudeToggle value={altitude} onChange={setAltitude} />
            <div className={styles.search}>
              <AuditSearch agentId={agentId} onSearchChange={handleSearch} />
            </div>
          </div>
          <AuditFilterBar
            filters={filters}
            onChange={setFilters}
            sessions={sessions}
          />
        </Stack>
      </Panel>

      <div className={styles.streamArea}>
        {search.active ? (
          <SearchResults
            state={search}
            agentId={agentId}
            showDetail={showDetail}
          />
        ) : (
          <AuditStream
            events={events}
            status={status}
            agentId={agentId}
            showDetail={showDetail}
            hasOlder={hasOlder}
            loadOlder={loadOlder}
            loadingOlder={loadingOlder}
          />
        )}
      </div>
    </Stack>
  );
}

/** The search-results view (newest-first), shown while a query is active. */
function SearchResults({
  state,
  agentId,
  showDetail,
}: {
  state: AuditSearchState;
  agentId: string;
  showDetail: boolean;
}) {
  if (state.loading) {
    return (
      <div className={styles.center}>
        <Spinner size="md" label="Searching" />
      </div>
    );
  }
  if (state.results.length === 0) {
    return (
      <EmptyState
        title="No matches"
        description={`No audit events match “${state.query}”.`}
      />
    );
  }
  return (
    <div className={styles.results}>
      {state.results.map((event) => (
        <AuditEventRow
          key={event.seq}
          event={event}
          agentId={agentId}
          showDetail={showDetail}
        />
      ))}
    </div>
  );
}
