/**
 * Brain graph query hook + renderer selector (MNEMO-40) - a thin lifecycle
 * wrapper over `@/api/graph`, mirroring the plain-hook pattern MNEMO-32 settled
 * on (no global query cache / TanStack Query - see `@/components/brain/useBrain`).
 *
 *   - `useBrainGraph(agentId, opts?)` - the graph query, keyed conceptually
 *     `["brain", agentId, "graph", start, depth]`, exposing a manual `refetch`.
 *   - `selectGraphData(graph)` - the API→renderer transform: force-graph libs use
 *     `links` (not `edges`), so this renames `edges`→`links` preserving
 *     `source`/`target`, passes the `degree`/`neuronType`-bearing nodes through,
 *     and passes `brainSize` through unchanged.
 *
 * On staleTime: without a query cache there's nothing to expire - the hook fetches
 * once on mount (and on `agentId`/`start`/`depth` change) and otherwise holds its
 * data until `refetch` is called. That is effectively an infinite staleTime with
 * an explicit refresh, which is exactly the intent here: the map should NOT
 * re-poll on its own, but the user can `refetch` to watch the brain grow (PRD §6.2).
 *
 * Hook + transform only - no UI.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BrainGraph,
  type BrainSizeMetric,
  type GraphNode,
  getBrainGraph,
} from "@/api/graph";

/** A force-graph link (libs use `links`, not `edges`; same `source`/`target`). */
export interface GraphLink {
  source: string;
  target: string;
}

/** The shape the renderer + badge consume: nodes, links, and brain-size totals. */
export interface GraphRenderData {
  nodes: GraphNode[];
  links: GraphLink[];
  brainSize: BrainSizeMetric;
}

/**
 * The API→renderer transform. Renames `edges`→`links` (force-graph naming),
 * carries `degree`/`neuronType` through on nodes, and passes `brainSize` through
 * unchanged. Pure - unit-tested directly, no canvas.
 */
export function selectGraphData(graph: BrainGraph): GraphRenderData {
  return {
    nodes: graph.nodes,
    links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
    brainSize: graph.brainSize,
  };
}

/**
 * Drop isolated (degree-0) neurons - the "Hide unconnected" view. A node with
 * degree 0 has no incident links, so removing it can never orphan a link (every
 * link's endpoints have degree ≥ 1); `links` therefore pass through untouched.
 * `brainSize` is the whole-brain total and is preserved (the badge still shows
 * true totals even when the canvas hides isolated nodes). Pure - no React.
 */
export function filterConnected(data: GraphRenderData): GraphRenderData {
  return {
    ...data,
    nodes: data.nodes.filter((n) => (n.degree ?? 0) > 0),
  };
}

/** Options forwarded to {@link getBrainGraph} (start slug + BFS depth). */
export interface UseBrainGraphOpts {
  start?: string;
  depth?: number;
}

export interface UseBrainGraphResult {
  /** Transformed render data - empty (no nodes/links, zero size) until loaded. */
  data: GraphRenderData;
  loading: boolean;
  error: Error | null;
  /** Re-fetch from the backend (so the map can be refreshed to show growth). */
  refetch: () => void;
}

const EMPTY_GRAPH: BrainGraph = {
  nodes: [],
  edges: [],
  brainSize: { neurons: 0, synapses: 0 },
};

/**
 * Fetch the agent's brain graph. Re-runs on `agentId`/`start`/`depth` change and
 * on manual `refetch`; selects the render-ready `{ nodes, links, brainSize }`.
 */
export function useBrainGraph(
  agentId: string,
  opts: UseBrainGraphOpts = {},
): UseBrainGraphResult {
  const { start, depth } = opts;
  const [graph, setGraph] = useState<BrainGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => setReloadToken((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadToken` is the explicit re-run trigger (manual refetch), not a value read inside the effect.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBrainGraph(agentId, { start, depth })
      .then((loaded) => {
        if (cancelled) return;
        setGraph(loaded);
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
  }, [agentId, start, depth, reloadToken]);

  const data = useMemo(() => selectGraphData(graph), [graph]);

  return { data, loading, error, refetch };
}
