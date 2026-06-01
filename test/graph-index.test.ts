/**
 * Runnable here with zero install:
 *   node --experimental-sqlite --test test/graph-index.test.ts
 *
 * Exercises the neuron/synapse index's load-bearing logic (upsert, dangling
 * resolution, idempotent re-index, removal) against node:sqlite. The SAME
 * GraphIndex runs in the DO via ctx.storage.sql (adapted through `sqlDriver`).
 * Neuron + synapse counts are the brain-size primitive MNEMO-09 surfaces.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SqlDriver } from "../src/audit/store.ts";
import { GraphIndex, planReindex } from "../src/memory/graph-index.ts";
import { initGraphSchema } from "../src/memory/graph-schema.ts";
import { hashContent } from "../src/memory/hash.ts";

/** node:sqlite adapter - the test-side implementation of SqlDriver. */
class NodeDriver implements SqlDriver {
  private db = new DatabaseSync(":memory:");
  ddl(sql: string): void {
    this.db.prepare(sql).run();
  }
  all<T>(sql: string, params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }
}

const PATH_A = "/brain/notes/note-a.md";
const PATH_B = "/brain/notes/note-b.md";

interface SynapseRow {
  src_path: string;
  dst_slug: string;
  dst_path: string | null;
  alias: string | null;
}

function fresh(): { graph: GraphIndex; driver: NodeDriver } {
  const driver = new NodeDriver();
  initGraphSchema(driver);
  return { graph: new GraphIndex(driver), driver };
}

/** Outgoing synapses of a note, for asserting resolution/dangling state. */
function edgesFrom(driver: NodeDriver, srcPath: string): SynapseRow[] {
  return driver.all<SynapseRow>(
    "SELECT src_path, dst_slug, dst_path, alias FROM synapses WHERE src_path = ?",
    [srcPath],
  );
}

test("upsert A→B (B unwritten) records one dangling synapse to B's slug", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]].");

  assert.deepEqual(graph.counts(), { neurons: 1, synapses: 1 });
  const edges = edgesFrom(driver, PATH_A);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].dst_slug, "note b");
  assert.equal(edges[0].dst_path, null); // dangling - B doesn't exist yet
});

test("upserting B back-fills the dangling A→B edge (resolveDangling)", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]].");
  graph.upsertNeuron(PATH_B, "Note B", "B has no links.");

  assert.deepEqual(graph.counts(), { neurons: 2, synapses: 1 });
  const edge = edgesFrom(driver, PATH_A)[0];
  assert.equal(edge.dst_slug, "note b");
  assert.equal(edge.dst_path, PATH_B); // resolved
});

test("resolveDangling is callable directly and back-fills by slug", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]].");
  // Simulate a target that exists on the FS / in the index under its slug,
  // then reconcile danglers explicitly (the restore/reindex path).
  graph.resolveDangling("note b", PATH_B);
  assert.equal(edgesFrom(driver, PATH_A)[0].dst_path, PATH_B);
});

test("re-upserting A with the same link does not duplicate the edge", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]].");
  graph.upsertNeuron(PATH_B, "Note B", "B has no links.");
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]] still."); // re-index

  assert.deepEqual(graph.counts(), { neurons: 2, synapses: 1 });
  const edges = edgesFrom(driver, PATH_A);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].dst_path, PATH_B); // stays resolved, not duplicated
});

test("removeNeuron(B) deletes B and makes A→B dangling again", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links to [[Note B]].");
  graph.upsertNeuron(PATH_B, "Note B", "B has no links.");
  graph.removeNeuron(PATH_B);

  // A's edge survives (the link in A's text still stands), now dangling.
  assert.deepEqual(graph.counts(), { neurons: 1, synapses: 1 });
  const edge = edgesFrom(driver, PATH_A)[0];
  assert.equal(edge.dst_slug, "note b");
  assert.equal(edge.dst_path, null);
});

test("aliased link preserves its display alias; slug ignores capitalization", () => {
  const { graph, driver } = fresh();
  graph.upsertNeuron(
    PATH_A,
    "Note A",
    "Backed by [[note B|Big B]] (lowercased link).",
  );
  const edge = edgesFrom(driver, PATH_A)[0];
  assert.equal(edge.dst_slug, "note b"); // case-folded
  assert.equal(edge.alias, "Big B");

  // The lowercased link still resolves to B once B is written.
  graph.upsertNeuron(PATH_B, "Note B", "no links");
  assert.equal(edgesFrom(driver, PATH_A)[0].dst_path, PATH_B);
});

// ─── Incremental re-index (hash-based change detection) ──────────────────────

test("hashContent matches the canonical SHA-256 of the empty string", async () => {
  // The known vector also equals `printf '' | sha256sum`, so the in-process hash
  // and the container's FS-side hash agree on "unchanged".
  assert.equal(
    await hashContent(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("indexedHashes round-trips the stored content_hash (NULL when omitted)", () => {
  const { graph } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "body", "deadbeef");
  graph.upsertNeuron(PATH_B, "Note B", "body"); // no hash supplied → NULL

  const byPath = new Map(
    graph.indexedHashes().map((r) => [r.path, r.content_hash]),
  );
  assert.equal(byPath.get(PATH_A), "deadbeef");
  assert.equal(byPath.get(PATH_B), null);
});

test("planReindex skips unchanged, flags new/changed/NULL, removes deleted", () => {
  const { graph } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "body", "h-a"); // unchanged on FS
  graph.upsertNeuron(PATH_B, "Note B", "body", "h-b-old"); // changed on FS
  graph.upsertNeuron("/brain/notes/legacy.md", "Legacy", "body"); // NULL hash
  graph.upsertNeuron("/brain/notes/gone.md", "Gone", "body", "h-gone"); // deleted

  const fs = new Map([
    [PATH_A, "h-a"], // same hash → skip
    [PATH_B, "h-b-new"], // differs → reindex
    ["/brain/notes/legacy.md", "h-legacy"], // NULL stored → reindex
    ["/brain/notes/new.md", "h-new"], // absent from index → reindex
  ]);

  const plan = planReindex(fs, graph.indexedHashes());
  assert.deepEqual(plan.toIndex.sort(), [
    "/brain/notes/legacy.md",
    "/brain/notes/new.md",
    PATH_B,
  ]);
  assert.deepEqual(plan.toRemove, ["/brain/notes/gone.md"]);
  assert.equal(plan.unchanged, 1); // only PATH_A
});

test("reconcile applies the plan: unchanged note keeps its updated_at, deleted drops", async () => {
  const { graph } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "A links [[Note B]].", "h-a");
  graph.upsertNeuron(PATH_B, "Note B", "B body", "h-b");
  const stableUpdatedAt = graph.getNeuron("note a")?.updated_at;
  assert.ok(typeof stableUpdatedAt === "number");

  // A unchanged (same hash), B changed, C new, and the now-absent B-less set drops.
  await new Promise((r) => setTimeout(r, 2)); // let the clock advance
  const result = graph.reconcile([
    {
      path: PATH_A,
      title: "Note A",
      content: "A links [[Note B]].",
      hash: "h-a",
    },
    { path: PATH_B, title: "Note B", content: "B body v2", hash: "h-b-v2" },
    {
      path: "/brain/notes/c.md",
      title: "Note C",
      content: "C body",
      hash: "h-c",
    },
  ]);

  assert.deepEqual(result, { indexed: 2, skipped: 1, removed: 0 });
  assert.equal(graph.counts().neurons, 3);
  // A was skipped, so its updated_at is preserved (not churned by the sweep).
  assert.equal(graph.getNeuron("note a")?.updated_at, stableUpdatedAt);
});

test("reconcile removes neurons whose files vanished", () => {
  const { graph } = fresh();
  graph.upsertNeuron(PATH_A, "Note A", "body", "h-a");
  graph.upsertNeuron(PATH_B, "Note B", "body", "h-b");

  const result = graph.reconcile([
    { path: PATH_A, title: "Note A", content: "body", hash: "h-a" },
  ]);

  assert.deepEqual(result, { indexed: 0, skipped: 1, removed: 1 });
  assert.equal(graph.getNeuron("note b"), null);
  assert.equal(graph.counts().neurons, 1);
});
