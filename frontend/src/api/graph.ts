/**
 * Brain graph API (MNEMO-40) - a typed client over the MNEMO-09 retrieval routes,
 * built on the MNEMO-32 `apiFetch` transport. Pure functions, no React; the
 * session cookie rides along via `credentials: "include"` (see `client.ts`).
 *
 * shapes mirror MNEMO-09 (src/memory/graph-index.ts + the routes in src/index.ts):
 *
 *   getBrainSize(agentId)                  → GET /agents/:id/brain/size              → BrainSize
 *   getBrainSubgraph(agentId, start, …)    → GET /agents/:id/brain/graph?start&depth → Subgraph
 *   searchNeurons(agentId, q, limit?)      → GET /agents/:id/brain/search?q&limit    → RawNeuron[]
 *
 * NB - MNEMO-09 has NO single whole-graph dump endpoint. The live backend exposes
 * THREE separate read routes (brain size, a bounded BFS subgraph that REQUIRES a
 * `start` slug, and a title/slug index search), not the unified `GET /agents/:id/
 * graph` sketched in the MNEMO-40 spec. Same precedent as `src/api/brain.ts`:
 * mirror the REAL backend, not the spec stub. So this module exposes those three
 * helpers AND a composed `getBrainGraph` that the UI consumes:
 *   - it always reads the WHOLE-brain size from `/brain/size`, so the brain-size
 *     badge shows true totals even when the rendered map is a bounded subgraph; and
 *   - when given a `start` slug it reads the bounded BFS subgraph and normalizes
 *     the raw neuron/synapse rows into the renderer-friendly `{ nodes, edges }`
 *     shape (force-graph node ids + `source`/`target` edges + computed `degree`).
 *   The map therefore "grows" as the brain grows (counts climb on every refetch)
 *   and as the user explores outward from a start neuron (PRD §4 / §6.2).
 */
import { get } from "./client";

// ─── Raw MNEMO-09 shapes (the exact wire types) ─────────────────────────────

/**
 * One neuron as the retrieval queries return it (src/memory/graph-index.ts
 * `NeuronRef`). A real neuron has a non-null sandbox `path`; a *dangling* leaf - a
 * `[[link]]` target with no note written yet - has `path: null` + `dangling: true`.
 */
export interface RawNeuron {
  path: string | null;
  slug: string;
  title: string | null;
  updated_at: number;
  dangling?: boolean;
}

/** One synapse edge (src/memory/graph-index.ts `SynapseRef`). `dst_path` is null when dangling. */
export interface RawSynapse {
  src_path: string;
  dst_slug: string;
  dst_path: string | null;
  alias: string | null;
}

/** A bounded-BFS subgraph (src/memory/graph-index.ts `Subgraph`). */
export interface Subgraph {
  nodes: RawNeuron[];
  edges: RawSynapse[];
}

/**
 * Brain-size breakdown (src/memory/graph-index.ts `BrainSize`): neuron + synapse
 * counts, with `dangling` the unresolved-link subset of synapses.
 */
export interface BrainSize {
  neurons: number;
  synapses: number;
  dangling: number;
}

// ─── Renderer-facing shapes (what the graph UI consumes) ────────────────────

/** Coarse neuron kind, derived from a neuron's brain path - drives node color. */
export type NeuronType = "note" | "tool" | "report" | "dangling" | "other";

/** A graph node ready for the force-graph renderer (the MNEMO-40 spec node shape). */
export interface GraphNode {
  /** Stable node id: the neuron's brain path, or `dangling:<slug>` for an unwritten target. */
  id: string;
  /** Sandbox FS path under `/brain` (empty string for a dangling, pathless node). */
  path: string;
  /** Display label (note title, else the file basename, else the slug). */
  title?: string;
  /** Coarse kind for coloring. */
  neuronType?: NeuronType;
  /** Incident-edge count - more-connected neurons render larger. */
  degree?: number;
}

/** A directed edge between two {@link GraphNode} ids (force-graph `source`/`target`). */
export interface GraphEdge {
  source: string;
  target: string;
}

/** The brain-size metric the badge renders (the PRD §4 neuron/synapse counts). */
export interface BrainSizeMetric {
  neurons: number;
  synapses: number;
}

/** The composed graph the UI reads: normalized nodes/edges + whole-brain size. */
export interface BrainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  brainSize: BrainSizeMetric;
}

/** Per-agent base path for every brain route. */
function brainBase(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/brain`;
}

// brain-size per PRD §6.6 / MNEMO-09 - the focused metric helper the dashboard
// (MNEMO-42) reads per agent: a thin call to the dedicated lightweight `/brain/size`
// endpoint (DO index, no sandbox warm). The returned `BrainSize` is a superset of the
// `{ neurons, synapses }` the badge needs (it also carries the `dangling` subset), so
// callers wanting just the metric destructure those two fields.
/** Whole-brain size (neurons/synapses/dangling). Reads the DO index; no sandbox warm. */
export function getBrainSize(agentId: string): Promise<BrainSize> {
  return get<BrainSize>(`${brainBase(agentId)}/size`);
}

/** Options for {@link getBrainSubgraph} / {@link getBrainGraph}. */
export interface BrainGraphOpts {
  /** Start neuron slug for the bounded BFS (required for any non-empty map). */
  start?: string;
  /** Max BFS depth; the backend clamps to its own `GRAPH_CAPS` rail. */
  depth?: number;
}

/**
 * Bounded BFS subgraph from `start` (the `/brain/graph` route). `start` is a
 * neuron slug; an unknown slug yields an empty subgraph. `depth` is clamped
 * server-side, so callers may pass any positive integer.
 */
export function getBrainSubgraph(
  agentId: string,
  start: string,
  opts: { depth?: number } = {},
): Promise<Subgraph> {
  const params = new URLSearchParams({ start });
  if (opts.depth != null) params.set("depth", String(opts.depth));
  return get<Subgraph>(`${brainBase(agentId)}/graph?${params.toString()}`);
}

/** Bounded title/slug index search (the `/brain/search` route). `q` must be non-empty. */
export function searchNeurons(
  agentId: string,
  q: string,
  limit?: number,
): Promise<RawNeuron[]> {
  const params = new URLSearchParams({ q });
  if (limit != null) params.set("limit", String(limit));
  return get<RawNeuron[]>(`${brainBase(agentId)}/search?${params.toString()}`);
}

/** Basename of a brain path, minus the `.md` extension (the note's display stem). */
function basename(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** Coarse neuron kind from its brain path (`/brain/notes|tools|reports/…`). */
function neuronTypeOf(n: RawNeuron): NeuronType {
  if (n.dangling || n.path == null) return "dangling";
  if (n.path.includes("/tools/")) return "tool";
  if (n.path.includes("/reports/")) return "report";
  if (n.path.includes("/notes/")) return "note";
  return "other";
}

/** A node's display label: its title, else the file basename, else the slug. */
function titleOf(n: RawNeuron): string {
  if (n.title) return n.title;
  return n.path ? basename(n.path) : n.slug;
}

/** The id a node is keyed by: its brain path, or `dangling:<slug>` when pathless. */
function nodeIdOf(n: RawNeuron): string {
  return n.path ?? `dangling:${n.slug}`;
}

/**
 * Normalize a raw MNEMO-09 {@link Subgraph} into the renderer's `{ nodes, edges }`
 * shape: map each synapse to a `source`/`target` edge (dangling targets keyed
 * `dangling:<slug>` so they line up with the dangling leaf nodes), compute each
 * node's `degree` from its incident edges, and derive `neuronType`/`title`/`id`.
 * Exported so it can be unit-tested without a network round-trip.
 */
export function normalizeSubgraph(sub: Subgraph): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const edges: GraphEdge[] = sub.edges.map((e) => ({
    source: e.src_path,
    target: e.dst_path ?? `dangling:${e.dst_slug}`,
  }));

  // Degree = number of edges incident to a node id (in + out).
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = sub.nodes.map((n) => {
    const id = nodeIdOf(n);
    return {
      id,
      path: n.path ?? "",
      title: titleOf(n),
      neuronType: neuronTypeOf(n),
      degree: degree.get(id) ?? 0,
    };
  });

  return { nodes, edges };
}

/**
 * The composed graph the UI consumes. Always fetches whole-brain size (so the
 * badge is accurate even for a bounded map); with a `start` slug it also fetches
 * and normalizes the bounded BFS subgraph. Without a `start`, returns an
 * empty map alongside the true brain-size totals (see the module header for why
 * the backend has no whole-graph dump).
 */
export async function getBrainGraph(
  agentId: string,
  opts: BrainGraphOpts = {},
): Promise<BrainGraph> {
  const size = await getBrainSize(agentId);
  const brainSize: BrainSizeMetric = {
    neurons: size.neurons,
    synapses: size.synapses,
  };

  const start = opts.start?.trim();
  if (!start) return { nodes: [], edges: [], brainSize };

  const sub = await getBrainSubgraph(agentId, start, { depth: opts.depth });
  return { ...normalizeSubgraph(sub), brainSize };
}
