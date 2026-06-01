/**
 * Dashboard data hooks + the client-side filter/sort helper (MNEMO-42).
 *
 * Mirrors the plain-hook pattern MNEMO-32 settled on (no TanStack Query / global
 * cache - same precedent as `@/components/graph/useBrainGraph` and
 * `@/components/brain/useBrain`). The conceptual cache keys the spec calls for
 * (`["agents","list"]`, `["brain", agentId, "size"]`) are documented inline; each
 * hook fetches on mount and exposes a manual `refetch`, which is an effectively
 * infinite `staleTime` with explicit refresh - exactly what the dashboard wants:
 *
 *   - `useAgents()`        - wraps MNEMO-34's `listAgents()`; the grid's source list.
 *   - `useBrainSize(id)`   - per-agent brain-size, fetched INDEPENDENTLY and
 *                            tolerant of failure (NOT suspense): one card's metric
 *                            erroring never blocks the grid or its siblings.
 *   - `filterAndSortAgents`- a pure, React-free search/filter/sort over the list.
 *
 * Hooks + pure helper only - no UI.
 */
import { useCallback, useEffect, useState } from "react";
import { type Agent, type AgentTemplate, listAgents } from "@/api/agents";
import { type BrainSize, getBrainSize } from "@/api/graph";

// ─── useAgents (keyed conceptually ["agents","list"]) ───────────────────────

export interface UseAgentsResult {
  /** The account's agents - `null` until the first load resolves. */
  agents: Agent[] | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch the list from the registry. */
  refetch: () => void;
}

/**
 * Fetch the account's agents (reuses MNEMO-34's `listAgents()`). Loads once on
 * mount; `refetch` re-runs it. `agents` is `null` while the first fetch is in
 * flight so the page can distinguish "loading" from "loaded, but empty".
 */
export function useAgents(): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => setReloadToken((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` is the explicit re-run trigger (manual refetch), not a value read inside the effect.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setAgents([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return { agents, loading, error, refetch };
}

// ─── useBrainSize (keyed conceptually ["brain", agentId, "size"]) ───────────

export interface UseBrainSizeResult {
  /** The brain-size metric, or `undefined` while loading / on error. */
  data: BrainSize | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetch ONE agent's brain-size metric, independently of every other card. Errors
 * are captured (not thrown) and leave `data` undefined so the card renders "-"
 * rather than the grid blowing up - the "degrade gracefully, never block the whole
 * list on one agent's metric" rule from the phase brief.
 */
export function useBrainSize(agentId: string): UseBrainSizeResult {
  const [data, setData] = useState<BrainSize | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(undefined);
    getBrainSize(agentId)
      .then((size) => {
        if (cancelled) return;
        setData(size);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err as Error);
        setData(undefined);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return { data, loading, error };
}

// ─── filterAndSortAgents (pure) ─────────────────────────────────────────────

/** Filter value for the template control: a specific template or "all". */
export type TemplateFilter = "all" | AgentTemplate;

/** Filter value for the status control: a specific lifecycle status or "all". */
export type StatusFilter = string;

/** Sort order for the list. */
export type SortBy = "name" | "newest";

export interface FilterAndSortOptions {
  /** Free-text search over name + description (case-insensitive). */
  query: string;
  /** Template narrow, or "all". */
  template: TemplateFilter;
  /** Status narrow, or "all". */
  status: StatusFilter;
  /** Sort order. */
  sortBy: SortBy;
}

/**
 * Pure client-side search/filter/sort over a list of agents. Search matches name
 * and description (case-insensitive, trimmed); the template + status filters
 * narrow by exact value (with "all" as a passthrough); `sortBy: "newest"` orders
 * by `created_at` descending and `"name"` orders alphabetically (locale-aware,
 * case-insensitive). Returns a new array - never mutates the input.
 *
 * NB the wire field is `created_at` (snake_case per MNEMO-05's `AgentResponse`),
 * not the `createdAt` the spec sketch named.
 */
export function filterAndSortAgents(
  agents: Agent[],
  { query, template, status, sortBy }: FilterAndSortOptions,
): Agent[] {
  const q = query.trim().toLowerCase();

  const filtered = agents.filter((a) => {
    if (template !== "all" && a.template !== template) return false;
    if (status !== "all" && a.status !== status) return false;
    if (!q) return true;
    const haystack = `${a.name} ${a.description ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });

  const sorted = [...filtered];
  if (sortBy === "newest") {
    sorted.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  } else {
    sorted.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }
  return sorted;
}
