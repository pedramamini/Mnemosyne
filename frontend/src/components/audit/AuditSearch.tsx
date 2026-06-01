import { useEffect, useRef, useState } from "react";
import { type AuditEvent, searchAudit } from "@/api/audit";
import { SearchInput, Stack, Text } from "@/components/ui";
import styles from "./AuditSearch.module.css";

/**
 * AuditSearch (MNEMO-37) - a debounced FTS search over the human `summary`
 * (MNEMO-22 `/search`). While a query is present it switches the cockpit into
 * "search results" mode (the parent pauses the live tail and lists the results
 * via `AuditEventRow`); clearing the query returns to the live stream. Reports
 * its state up via `onSearchChange` so the parent owns the view switch. Search
 * spans every altitude - the active altitude only governs each row's detail.
 */
export interface AuditSearchState {
  /** True while a non-empty query is active (the cockpit shows results, not live). */
  active: boolean;
  query: string;
  results: AuditEvent[];
  loading: boolean;
}

export interface AuditSearchProps {
  agentId: string;
  onSearchChange: (state: AuditSearchState) => void;
}

const DEBOUNCE_MS = 300;

export function AuditSearch({ agentId, onSearchChange }: AuditSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  // Latest-request guard so a slow earlier query can't clobber a newer one.
  const reqRef = useRef(0);
  // Stable handle to the latest callback so the report effect needn't depend on it.
  const reportRef = useRef(onSearchChange);
  reportRef.current = onSearchChange;

  const trimmed = query.trim();

  // Debounced search whenever the query changes.
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqRef.current;
    const timer = setTimeout(() => {
      searchAudit(agentId, trimmed)
        .then((hits) => {
          if (reqRef.current !== id) return;
          setResults(hits);
          setLoading(false);
        })
        .catch(() => {
          if (reqRef.current !== id) return;
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [agentId, trimmed]);

  // Surface the current search state to the parent (which owns the view switch).
  useEffect(() => {
    reportRef.current({ active: trimmed.length > 0, query, results, loading });
  }, [trimmed, query, results, loading]);

  return (
    <Stack gap="1" className={styles.root}>
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery("")}
        placeholder="Search the audit log…"
        aria-label="Search audit log"
      />
      {trimmed.length > 0 && (
        <Text size="sm" color="text-muted" role="status">
          {loading
            ? "Searching…"
            : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </Text>
      )}
    </Stack>
  );
}
