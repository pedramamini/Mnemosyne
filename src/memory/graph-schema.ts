/**
 * DO-SQLite graph DDL - the neuron/synapse index schema (PRD §4 / §7.4).
 *
 * The memory *index* lives in DO SQLite so search, traversal, and brain-size
 * work WITHOUT waking the sandbox container (PRD §7.4). Neurons reference a
 * `path` on the sandbox FS - this index is metadata only; note CONTENT stays in
 * the brain (the sandbox git repo), the DO holds the graph.
 *
 * Mirrors the one-statement-per-entry `SCHEMA: string[]` pattern from
 * `src/audit/store.ts` so each DDL statement runs individually on either backend
 * (node:sqlite in tests, `ctx.storage.sql` in the DO). `initGraphSchema` runs the
 * DDL through the shared {@link SqlDriver}; it is invoked from the single
 * `initAgentSchema` chokepoint (`src/agent/sql.ts`) - there is NO second
 * schema-init entry point.
 */
import type { SqlDriver } from "../audit/store.ts";

/** One statement per entry so each runs individually (see src/audit/store.ts). */
export const GRAPH_SCHEMA: string[] = [
  // Neurons: one row per note file. `path` is the sandbox FS location (PK), `slug`
  // is the comparable title key links resolve against, `title` is the display
  // name (nullable), `updated_at` is the last re-index time (epoch ms),
  // `content_hash` is the SHA-256 of the note bytes at last index (nullable for
  // pre-incremental rows) so a re-index sweep can skip notes that haven't changed.
  `CREATE TABLE IF NOT EXISTS neurons (
     path         TEXT PRIMARY KEY,
     slug         TEXT NOT NULL,
     title        TEXT,
     updated_at   INTEGER NOT NULL,
     content_hash TEXT
   )`,
  // Resolve `[[links]]` to neurons, and surface "wanted but unwritten" notes.
  `CREATE INDEX IF NOT EXISTS neurons_slug ON neurons(slug)`,
  // Synapses: one row per parsed `[[wikilink]]`. `src_path` is the linking note,
  // `dst_slug` the link's slugified target, `dst_path` the resolved neuron path
  // (NULL = dangling: the target note doesn't exist yet), `alias` the display
  // text from `[[Target|Alias]]` (nullable).
  `CREATE TABLE IF NOT EXISTS synapses (
     src_path TEXT NOT NULL,
     dst_slug TEXT NOT NULL,
     dst_path TEXT,
     alias    TEXT
   )`,
  // src_path: list/replace a neuron's outgoing edges (idempotent re-index).
  `CREATE INDEX IF NOT EXISTS synapses_src ON synapses(src_path)`,
  // dst_slug: resolve/back-fill danglers when a target neuron appears.
  `CREATE INDEX IF NOT EXISTS synapses_dst ON synapses(dst_slug)`,
];

/** Create the graph tables/indexes if absent. Idempotent - safe on every wake. */
export function initGraphSchema(db: SqlDriver): void {
  for (const stmt of GRAPH_SCHEMA) db.ddl(stmt);
  ensureNeuronContentHash(db);
}

/**
 * Add the `content_hash` column to a `neurons` table created before incremental
 * re-index existed. `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`, so the add
 * is gated on `PRAGMA table_info`; this keeps `initGraphSchema` idempotent on both
 * fresh DBs (the column is in the CREATE above) and pre-existing ones. Pre-existing
 * rows get a NULL hash and are treated as "changed" on the next sweep - re-indexed
 * once, then skipped thereafter. Self-healing, no data migration needed.
 */
function ensureNeuronContentHash(db: SqlDriver): void {
  const cols = db.all<{ name: string }>(`PRAGMA table_info(neurons)`, []);
  if (cols.some((c) => c.name === "content_hash")) return;
  db.ddl(`ALTER TABLE neurons ADD COLUMN content_hash TEXT`);
}
