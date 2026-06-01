/**
 * Report query hooks (MNEMO-41) - thin lifecycle wrappers over `@/api/reports`.
 *
 * The frontend has no global query cache (MNEMO-32 settled on plain hooks over
 * `apiFetch`, not TanStack Query - see `@/components/brain/useBrain`), so the
 * cache keys the spec calls for are modelled conceptually:
 *
 *   - `useReports(agentId)`               - list query,   key `["reports", agentId, "list"]`.
 *   - `useReport(agentId, reportId)`      - read query,   key `["reports", agentId, reportId]`,
 *                                           enabled only when `reportId` is set.
 *   - `useReportSearch(agentId, query)`   - search query, key `["reports", agentId, "search", query]`,
 *                                           enabled only when `query` is non-empty (the search box
 *                                           debounces upstream).
 *
 * Reports are immutable archives (MNEMO-25), so unlike `useBrain` there is no
 * mutation/invalidation bus - each hook just loads, with proper cancellation so a
 * fast selection/typing sequence never lands a stale result. Hooks only - no UI.
 */
import { useEffect, useState } from "react";
import {
  getReport,
  listReports,
  type Report,
  type ReportMeta,
  type ReportSearchHit,
  searchReports,
} from "@/api/reports";

export interface UseReportsResult {
  reports: ReportMeta[];
  loading: boolean;
  error: Error | null;
}

/** List the agent's reports. Key `["reports", agentId, "list"]`. */
export function useReports(agentId: string): UseReportsResult {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listReports(agentId)
      .then((list) => {
        if (cancelled) return;
        setReports(list);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { reports, loading, error };
}

export interface UseReportResult {
  report: Report | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Read one report. Disabled (returns `null`, no fetch) until `reportId` is set.
 * Key `["reports", agentId, reportId]`.
 */
export function useReport(
  agentId: string,
  reportId: string | null,
): UseReportResult {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!reportId) {
      setReport(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReport(null);
    getReport(agentId, reportId)
      .then((loaded) => {
        if (cancelled) return;
        setReport(loaded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, reportId]);

  return { report, loading, error };
}

export interface UseReportSearchResult {
  hits: ReportSearchHit[];
  loading: boolean;
  error: Error | null;
}

/**
 * Full-text search the agent's reports. Disabled (returns no hits, no fetch)
 * until `query` is non-empty - the `ReportSearchBox` debounces before flipping
 * the query, so this fires once per settled query. Key
 * `["reports", agentId, "search", query]`.
 */
export function useReportSearch(
  agentId: string,
  query: string,
): UseReportSearchResult {
  const [hits, setHits] = useState<ReportSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    searchReports(agentId, q)
      .then((found) => {
        if (cancelled) return;
        setHits(found);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, query]);

  return { hits, loading, error };
}
