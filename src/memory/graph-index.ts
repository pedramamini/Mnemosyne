/**
 * Neuron/synapse index maintenance over the DO SQL surface (PRD §4 / §6.2 / §7.4).
 *
 * Turns the brain's files into a real graph: each note is a *neuron* row, each
 * parsed `[[wikilink]]` a *synapse* edge. The index lives in DO SQLite so
 * search/traversal/brain-size work without waking the sandbox (PRD §7.4) — it is
 * metadata only (paths + the parsed graph), never note content.
 *
 * Depends only on the shared {@link SqlDriver} surface (the same one
 * `src/audit/store.ts` defines), so the exact same logic runs in the DO over
 * `ctx.storage.sql` and in a bare-Node node:sqlite test (`test/graph-index.test.ts`).
 * Schema creation lives in `src/memory/graph-schema.ts` (run via the single
 * `initAgentSchema` path) — this class assumes the tables already exist.
 *
 * Link resolution: a link's slugified target (`dst_slug`) resolves to a neuron's
 * `path` (`dst_path`) by matching `neurons.slug`. An unresolved link is still
 * recorded as a *dangling* synapse (`dst_path` NULL) so the graph can surface
 * "wanted but unwritten" notes. Re-indexing a neuron is idempotent: its outgoing
 * synapses are deleted then re-inserted, so repeated writes never duplicate edges.
 */
import type { SqlDriver } from "../audit/store.ts";
import { parseWikilinks, slugifyTarget } from "./wikilink.ts";

/** Neuron + synapse counts — the brain-size primitive MNEMO-09 surfaces. */
export interface GraphCounts {
  neurons: number;
  synapses: number;
}

/**
 * The index's view of a note (MNEMO-09 retrieval surface). A real neuron has a
 * non-null sandbox `path`; a *dangling* leaf — a `[[link]]` target with no note
 * written yet — has `path: null` and `dangling: true`, so the agent/UI can see
 * "wanted but unwritten" notes that {@link GraphIndex.traverse} surfaces.
 */
export interface NeuronRef {
  path: string | null;
  slug: string;
  title: string | null;
  updated_at: number;
  dangling?: boolean;
}

/** One synapse edge as returned by the retrieval queries (the raw row shape). */
export interface SynapseRef {
  src_path: string;
  dst_slug: string;
  dst_path: string | null;
  alias: string | null;
}

/** Reached subgraph from a traversal: the neurons hit and the edges walked. */
export interface Subgraph {
  nodes: NeuronRef[];
  edges: SynapseRef[];
}

/** Brain-size breakdown: total synapses plus the dangling (unresolved) subset. */
export interface BrainSize {
  neurons: number;
  synapses: number;
  dangling: number;
}

/** A neuron's path + the content hash stored at its last index (NULL = legacy/unknown). */
export interface IndexedHash {
  path: string;
  content_hash: string | null;
}

/** One note as seen on the FS for {@link GraphIndex.reconcile}: path, title, body, hash. */
export interface ReindexNote {
  path: string;
  title: string | null;
  content: string;
  hash: string;
}

/**
 * The decision a re-index sweep makes from a hash diff (see {@link planReindex}):
 * which note paths to (re)index, which to drop, and how many were untouched. Pure
 * data so the DO can read the FS lazily — it only reads the `toIndex` notes.
 */
export interface ReindexPlan {
  toIndex: string[];
  toRemove: string[];
  unchanged: number;
}

/** What {@link GraphIndex.reconcile} applied: counts of (re)indexed, skipped, removed. */
export interface ReindexResult {
  indexed: number;
  skipped: number;
  removed: number;
}

/** Edge direction to follow from a node: out-edges, in-edges, or both. */
export type Direction = "out" | "in" | "both";

/** Options for {@link GraphIndex.traverse}. All bounds are clamped to {@link GRAPH_CAPS}. */
export interface TraverseOpts {
  /** Max breadth-first depth from the start node (clamped, default small). */
  maxDepth?: number;
  /** Hard cap on reached nodes — the runaway-graph safety rail (clamped). */
  maxNodes?: number;
  /** Which edges to follow (default `"out"`). */
  direction?: Direction;
  /** Surface dangling link targets as flagged leaf refs (default `true`). */
  includeDangling?: boolean;
}

/**
 * Safety caps for the bounded retrieval methods — the same `MAX_LIMIT` discipline
 * `src/audit/store.ts` uses, so a pathological graph or a hostile query string
 * can't run away. Exported so the API layer (`src/index.ts`) clamps `depth`/
 * `limit` to the SAME numbers server-side rather than trusting the caller.
 */
export const GRAPH_CAPS = {
  defaultMaxDepth: 2,
  maxDepth: 6,
  defaultMaxNodes: 256,
  maxNodes: 2000,
  defaultSearchLimit: 50,
  maxSearchLimit: 200,
  defaultListLimit: 100,
  maxListLimit: 1000,
} as const;

/** Clamp `n` into `[lo, hi]` (used to enforce the {@link GRAPH_CAPS} rails). */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export class GraphIndex {
  // Explicit field (not a constructor parameter property) so the class runs
  // under Node's strip-only TS mode in `test/graph-index.test.ts` — same reason
  // `AuditStore` assigns its fields by hand.
  private readonly db: SqlDriver;

  constructor(db: SqlDriver) {
    this.db = db;
  }

  /**
   * Index (or re-index) one note. Slugifies the note, parses its wikilinks,
   * upserts the neuron row, replaces its outgoing synapses (delete-then-insert,
   * so re-indexing is idempotent), resolving each link's `dst_path` from the
   * `neurons` table by slug (NULL when the target doesn't exist yet — dangling).
   * Finally back-fills any *incoming* danglers now that this neuron's slug exists.
   *
   * `contentHash` (when supplied) is stored so a later {@link planReindex} sweep
   * can tell whether this neuron's note changed without re-reading + re-parsing it.
   * Omitting it stores NULL, which simply forces a re-index on the next sweep.
   */
  upsertNeuron(
    path: string,
    title: string | null,
    content: string,
    contentHash: string | null = null,
  ): void {
    const slug = deriveSlug(path, title);

    this.db.all(
      `INSERT OR REPLACE INTO neurons (path, slug, title, updated_at, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [path, slug, title ?? null, Date.now(), contentHash],
    );

    // Replace this neuron's outgoing edges so a re-index never duplicates them.
    this.db.all(`DELETE FROM synapses WHERE src_path = ?`, [path]);

    for (const link of parseWikilinks(content)) {
      const dstPath = this.pathForSlug(link.target);
      this.db.all(
        `INSERT INTO synapses (src_path, dst_slug, dst_path, alias)
         VALUES (?, ?, ?, ?)`,
        [path, link.target, dstPath, link.alias ?? null],
      );
    }

    // This neuron may be the target other notes were waiting on — resolve them.
    this.resolveDangling(slug, path);
  }

  /**
   * Remove a neuron and its outgoing synapses, and null out any *incoming*
   * synapses' `dst_path` so links that pointed at it become dangling again
   * (the target was deleted, but the link in the source note still stands).
   */
  removeNeuron(path: string): void {
    this.db.all(`DELETE FROM synapses WHERE src_path = ?`, [path]);
    this.db.all(`UPDATE synapses SET dst_path = NULL WHERE dst_path = ?`, [
      path,
    ]);
    this.db.all(`DELETE FROM neurons WHERE path = ?`, [path]);
  }

  /**
   * Back-fill `dst_path` on dangling synapses that pointed at `slug`, now that a
   * neuron with that slug exists at `path`. Called automatically by
   * {@link upsertNeuron}; exposed so the restore/reindex path can reconcile too.
   */
  resolveDangling(slug: string, path: string): void {
    this.db.all(
      `UPDATE synapses SET dst_path = ? WHERE dst_slug = ? AND dst_path IS NULL`,
      [path, slug],
    );
  }

  /** Current neuron + synapse counts (brain size). */
  counts(): GraphCounts {
    const n = this.db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM neurons`,
      [],
    );
    const s = this.db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM synapses`,
      [],
    );
    return { neurons: n[0]?.c ?? 0, synapses: s[0]?.c ?? 0 };
  }

  // ─── Incremental re-index (llm-wiki-compiler change-detection pattern) ─────
  // The brain's write tools (the generic sandbox `writeFile`) skip the per-write
  // reindex hook, so the DO sweeps the whole note tree after every research/
  // deep-dive phase. Hashing lets that sweep touch only what actually changed.

  /** Every indexed neuron's path + stored content hash — the left side of a sweep diff. */
  indexedHashes(): IndexedHash[] {
    return this.db.all<IndexedHash>(
      `SELECT path, content_hash FROM neurons`,
      [],
    );
  }

  /**
   * Reconcile the index against a fully-materialized set of FS notes: upsert the
   * new/changed ones, drop neurons whose files are gone, and leave unchanged notes
   * (same hash) untouched — so their `updated_at` and synapses are preserved rather
   * than churned every sweep. Convenience for callers that already hold all note
   * content in memory (and the tests); the DO uses {@link planReindex} directly so
   * it can read only the changed notes from the sandbox.
   */
  reconcile(notes: ReadonlyArray<ReindexNote>): ReindexResult {
    const fsHashes = new Map(notes.map((n) => [n.path, n.hash]));
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const plan = planReindex(fsHashes, this.indexedHashes());
    for (const path of plan.toIndex) {
      const note = byPath.get(path);
      if (note)
        this.upsertNeuron(note.path, note.title, note.content, note.hash);
    }
    for (const path of plan.toRemove) this.removeNeuron(path);
    return {
      indexed: plan.toIndex.length,
      skipped: plan.unchanged,
      removed: plan.toRemove.length,
    };
  }

  // ─── Retrieval (MNEMO-09) ────────────────────────────────────────────────
  // Read-only queries over the MNEMO-08 tables. They serve the agent's graph
  // *retrieval tool* (PRD §6.2) and the brain-size metric the UI surfaces (PRD
  // §4/§6.6) straight from DO SQLite — so search/traversal/brain-size answer
  // WITHOUT waking the sandbox container (PRD §7.4). Every query is parameterized
  // and bounded (explicit LIMIT / depth + node caps), matching the audit store's
  // MAX_LIMIT discipline. Full-text search over note *bodies* is a SEPARATE
  // sandbox `grep` tool (Track C, MNEMO-17) — the searches here are over the
  // index (titles/slugs/links) only; the two retrieval modes are not conflated.

  /** Fetch one neuron by slug (slug-normalized, forgiving of case/spacing), or null. */
  getNeuron(slug: string): NeuronRef | null {
    const rows = this.db.all<NeuronRef>(
      `SELECT path, slug, title, updated_at FROM neurons WHERE slug = ? LIMIT 1`,
      [slugifyTarget(slug)],
    );
    return rows.length ? rows[0] : null;
  }

  /** Paged neurons, newest-updated first, with a bounded limit (runaway rail). */
  listNeurons(opts: { limit?: number } = {}): NeuronRef[] {
    const limit = clamp(
      opts.limit ?? GRAPH_CAPS.defaultListLimit,
      1,
      GRAPH_CAPS.maxListLimit,
    );
    return this.db.all<NeuronRef>(
      `SELECT path, slug, title, updated_at FROM neurons
       ORDER BY updated_at DESC LIMIT ?`,
      [limit],
    );
  }

  /**
   * Edges touching a neuron: outgoing (synapses whose `src` resolves to this
   * neuron's path) and/or incoming (synapses with `dst_slug = slug`), per
   * `direction`. Returns the raw edges (dangling out-edges included — their
   * `dst_path` is NULL); resolving the far node is the caller's / traversal's job.
   */
  neighbors(slug: string, direction: Direction = "out"): SynapseRef[] {
    const key = slugifyTarget(slug);
    const edges: SynapseRef[] = [];
    if (direction === "out" || direction === "both") {
      const neuron = this.getNeuron(key);
      if (neuron?.path != null) edges.push(...this.outgoingEdges(neuron.path));
    }
    if (direction === "in" || direction === "both") {
      edges.push(...this.incomingEdges(key));
    }
    return edges;
  }

  /**
   * Breadth-first traversal from `startSlug` up to `maxDepth` / `maxNodes`,
   * following synapses in the requested direction(s). Returns the reached
   * subgraph (`{ nodes, edges }`). A visited-set keyed on slug guarantees cycles
   * terminate; `maxDepth` and `maxNodes` are the runaway-graph safety rail (both
   * clamped to {@link GRAPH_CAPS}). Dangling out-edge targets are surfaced once as
   * leaf {@link NeuronRef}s flagged `dangling: true` and are never expanded.
   */
  traverse(startSlug: string, opts: TraverseOpts = {}): Subgraph {
    const maxDepth = clamp(
      opts.maxDepth ?? GRAPH_CAPS.defaultMaxDepth,
      1,
      GRAPH_CAPS.maxDepth,
    );
    const maxNodes = clamp(
      opts.maxNodes ?? GRAPH_CAPS.defaultMaxNodes,
      1,
      GRAPH_CAPS.maxNodes,
    );
    const direction = opts.direction ?? "out";
    const includeDangling = opts.includeDangling ?? true;

    const nodes: NeuronRef[] = [];
    const edges: SynapseRef[] = [];
    const start = this.getNeuron(startSlug);
    if (!start) return { nodes, edges };

    const visited = new Set<string>([start.slug]);
    const danglingSeen = new Set<string>();
    const edgeSeen = new Set<string>();
    const queue: Array<{ node: NeuronRef; depth: number }> = [
      { node: start, depth: 0 },
    ];
    nodes.push(start);

    // Record an edge at most once (key on its identity) so a re-walk — e.g.
    // direction "both", where A→B is A's out-edge and B's in-edge — can't double it.
    const pushEdge = (e: SynapseRef): void => {
      const k = `${e.src_path} ${e.dst_slug} ${e.alias ?? ""}`;
      if (edgeSeen.has(k)) return;
      edgeSeen.add(k);
      edges.push(e);
    };
    const tryEnqueue = (node: NeuronRef, depth: number): void => {
      if (visited.has(node.slug) || nodes.length >= maxNodes) return;
      visited.add(node.slug);
      nodes.push(node);
      queue.push({ node, depth });
    };

    while (queue.length > 0) {
      const { node, depth } = queue.shift() as {
        node: NeuronRef;
        depth: number;
      };
      // Node is kept but not expanded once it sits at the depth cap; a dangling
      // leaf (path null) is never expanded regardless.
      if (depth >= maxDepth || node.path == null) continue;

      if (direction === "out" || direction === "both") {
        for (const edge of this.outgoingEdges(node.path)) {
          pushEdge(edge);
          if (edge.dst_path == null) {
            if (
              includeDangling &&
              !danglingSeen.has(edge.dst_slug) &&
              !visited.has(edge.dst_slug) &&
              nodes.length < maxNodes
            ) {
              danglingSeen.add(edge.dst_slug);
              nodes.push({
                path: null,
                slug: edge.dst_slug,
                title: null,
                updated_at: 0,
                dangling: true,
              });
            }
            continue;
          }
          const target = this.getNeuron(edge.dst_slug);
          if (target) tryEnqueue(target, depth + 1);
        }
      }
      if (direction === "in" || direction === "both") {
        for (const edge of this.incomingEdges(node.slug)) {
          pushEdge(edge);
          const src = this.neuronByPath(edge.src_path);
          if (src) tryEnqueue(src, depth + 1);
        }
      }
    }
    return { nodes, edges };
  }

  /**
   * Bounded, case-insensitive search over neuron `title`/`slug` (INSTR over the
   * lowercased index — parameterized, so user punctuation/wildcards are inert),
   * newest-updated first, capped limit. This searches the INDEX (titles/links)
   * only; full-text search over note *bodies* is a separate sandbox `grep` tool
   * (Track C, MNEMO-17) — keep the two retrieval modes distinct.
   */
  searchNeurons(
    query: string,
    limit: number = GRAPH_CAPS.defaultSearchLimit,
  ): NeuronRef[] {
    const needle = query.toLowerCase();
    const capped = clamp(limit, 1, GRAPH_CAPS.maxSearchLimit);
    return this.db.all<NeuronRef>(
      `SELECT path, slug, title, updated_at FROM neurons
       WHERE INSTR(LOWER(slug), ?) > 0 OR INSTR(LOWER(IFNULL(title, '')), ?) > 0
       ORDER BY updated_at DESC LIMIT ?`,
      [needle, needle, capped],
    );
  }

  /**
   * Brain size (PRD §4/§6.6): neuron + synapse counts via `COUNT(*)`, with
   * synapses split into resolved vs `dangling` (`dst_path IS NULL`). This is the
   * canonical brain-size primitive the UI/metrics read.
   */
  brainSize(): BrainSize {
    const count = (sql: string): number =>
      this.db.all<{ c: number }>(sql, [])[0]?.c ?? 0;
    return {
      neurons: count(`SELECT COUNT(*) AS c FROM neurons`),
      synapses: count(`SELECT COUNT(*) AS c FROM synapses`),
      dangling: count(
        `SELECT COUNT(*) AS c FROM synapses WHERE dst_path IS NULL`,
      ),
    };
  }

  /**
   * The single brain-size *number* the PRD §4 definition names
   * (neurons + synapses) — so the UI and metrics share one source of truth.
   */
  brainSizeScalar(): number {
    const b = this.brainSize();
    return b.neurons + b.synapses;
  }

  /** Outgoing synapses of the neuron at `path` (the linking note's edges). */
  private outgoingEdges(path: string): SynapseRef[] {
    return this.db.all<SynapseRef>(
      `SELECT src_path, dst_slug, dst_path, alias FROM synapses WHERE src_path = ?`,
      [path],
    );
  }

  /** Incoming synapses pointing at `slug` (resolved or still dangling). */
  private incomingEdges(slug: string): SynapseRef[] {
    return this.db.all<SynapseRef>(
      `SELECT src_path, dst_slug, dst_path, alias FROM synapses WHERE dst_slug = ?`,
      [slug],
    );
  }

  /** Fetch a neuron by its FS path (the source side of an incoming edge), or null. */
  private neuronByPath(path: string): NeuronRef | null {
    const rows = this.db.all<NeuronRef>(
      `SELECT path, slug, title, updated_at FROM neurons WHERE path = ? LIMIT 1`,
      [path],
    );
    return rows.length ? rows[0] : null;
  }

  /** Resolve a slug to a neuron path, or null if no neuron has that slug. */
  private pathForSlug(slug: string): string | null {
    const rows = this.db.all<{ path: string }>(
      `SELECT path FROM neurons WHERE slug = ? LIMIT 1`,
      [slug],
    );
    return rows.length ? rows[0].path : null;
  }
}

/**
 * Derive a neuron's slug. Prefer the note's title (how it's referenced —
 * `[[Acme Corp]]`); fall back to the filename stem when no title is supplied,
 * so an untitled note still gets a stable key. Uses the SAME {@link slugifyTarget}
 * links use, so a link and the note it names resolve to an identical slug.
 */
function deriveSlug(path: string, title: string | null): string {
  const fromTitle = title ? slugifyTarget(title) : "";
  if (fromTitle !== "") return fromTitle;
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return slugifyTarget(stem);
}

/**
 * Diff the brain's current FS state (`fsHashes`: path → SHA-256) against the
 * index's stored hashes to decide what a re-index sweep must do:
 *
 *   - `toIndex`  — paths whose hash differs from the index (new note, or changed
 *                  body), plus pre-incremental rows whose stored hash is NULL.
 *   - `toRemove` — indexed paths with no file on the FS any more (deleted notes).
 *   - `unchanged`— count of paths whose hash matches; the sweep never touches them.
 *
 * Pure, so the caller (the DO) can run it against a cheap batched FS hash and then
 * read ONLY the `toIndex` notes from the sandbox — the whole point of incremental
 * re-index. The matching test lives in `test/graph-index.test.ts`.
 */
export function planReindex(
  fsHashes: ReadonlyMap<string, string>,
  indexed: Iterable<IndexedHash>,
): ReindexPlan {
  const indexedMap = new Map<string, string | null>();
  for (const row of indexed) indexedMap.set(row.path, row.content_hash);

  const toIndex: string[] = [];
  let unchanged = 0;
  for (const [path, hash] of fsHashes) {
    // A present-and-identical hash is the only skip; absent (undefined) or a
    // NULL legacy hash both fall through to a re-index.
    if (indexedMap.get(path) === hash) unchanged += 1;
    else toIndex.push(path);
  }

  const toRemove: string[] = [];
  for (const path of indexedMap.keys()) {
    if (!fsHashes.has(path)) toRemove.push(path);
  }

  return { toIndex, toRemove, unchanged };
}
