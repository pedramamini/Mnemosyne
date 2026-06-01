/**
 * Runnable here with zero install:
 *   node --experimental-sqlite --test test/graph-retrieval.test.ts
 *
 * Exercises the MNEMO-09 retrieval surface (neighbors, traverse, searchNeurons,
 * brainSize) against node:sqlite - the SAME harness as `test/graph-index.test.ts`.
 * The identical GraphIndex runs in the DO over `ctx.storage.sql` (adapted through
 * `sqlDriver`), so these reads answer WITHOUT waking the sandbox (PRD §7.4).
 *
 * The fixture graph (built via `upsertNeuron`):
 *   Alpha → Beta, Alpha → Gamma, Beta → Gamma, plus a dangling Alpha → Delta
 *   (Delta is never written). Slugs: alpha, beta, gamma, delta.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SqlDriver } from "../src/audit/store.ts";
import { GraphIndex } from "../src/memory/graph-index.ts";
import { initGraphSchema } from "../src/memory/graph-schema.ts";

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

const PATH_A = "/brain/notes/alpha.md";
const PATH_B = "/brain/notes/beta.md";
const PATH_C = "/brain/notes/gamma.md";

function fresh(): GraphIndex {
  const driver = new NodeDriver();
  initGraphSchema(driver);
  return new GraphIndex(driver);
}

/** Build the fixture graph; Delta is deliberately never written (dangling). */
function buildGraph(graph: GraphIndex): void {
  graph.upsertNeuron(
    PATH_A,
    "Alpha",
    "Links [[Beta]], [[Gamma]] and [[Delta]].",
  );
  graph.upsertNeuron(PATH_B, "Beta", "Beta links [[Gamma]].");
  graph.upsertNeuron(PATH_C, "Gamma", "Gamma has no links.");
}

const slugs = (refs: { slug: string }[]): string[] =>
  refs.map((r) => r.slug).sort();

test("neighbors('alpha','out') returns the resolved targets B and C (plus dangling D)", () => {
  const graph = fresh();
  buildGraph(graph);

  const out = graph.neighbors("alpha", "out");
  // All three outgoing edges are present (dangling Delta included)…
  assert.deepEqual(out.map((e) => e.dst_slug).sort(), [
    "beta",
    "delta",
    "gamma",
  ]);
  // …but the *resolved* neighbors (a real note exists) are exactly B and C.
  const resolved = out
    .filter((e) => e.dst_path != null)
    .map((e) => e.dst_slug)
    .sort();
  assert.deepEqual(resolved, ["beta", "gamma"]);
});

test("neighbors('gamma','in') returns the incoming edges from A and B", () => {
  const graph = fresh();
  buildGraph(graph);

  const incoming = graph.neighbors("gamma", "in");
  assert.deepEqual(
    incoming.map((e) => e.src_path).sort(),
    [PATH_A, PATH_B].sort(),
  );
});

test("getNeuron resolves by slug (case/space-insensitive); listNeurons is bounded", () => {
  const graph = fresh();
  buildGraph(graph);

  assert.equal(graph.getNeuron("alpha")?.path, PATH_A);
  assert.equal(graph.getNeuron("  ALPHA  ")?.path, PATH_A); // forgiving lookup
  assert.equal(graph.getNeuron("nope"), null);

  assert.equal(graph.listNeurons().length, 3);
  assert.equal(graph.listNeurons({ limit: 2 }).length, 2); // bounded
});

test("traverse reaches A,B,C and surfaces dangling D as a flagged leaf", () => {
  const graph = fresh();
  buildGraph(graph);

  const { nodes } = graph.traverse("alpha", { maxDepth: 2 });
  assert.deepEqual(slugs(nodes), ["alpha", "beta", "delta", "gamma"]);

  const delta = nodes.find((n) => n.slug === "delta");
  assert.equal(delta?.dangling, true);
  assert.equal(delta?.path, null); // "wanted but unwritten"
});

test("traverse terminates on a cycle and respects the maxNodes hard cap", () => {
  const graph = fresh();
  buildGraph(graph);
  // Close a cycle: Gamma now links back to Alpha. Without a visited-set a deep
  // traversal would loop forever.
  graph.upsertNeuron(PATH_C, "Gamma", "Now links back: [[Alpha]].");

  // High depth + node budget: must return (no infinite loop) with each real
  // neuron visited once and the cycle edge (Gamma → Alpha) recorded.
  const full = graph.traverse("alpha", { maxDepth: 10, maxNodes: 100 });
  assert.deepEqual(slugs(full.nodes), ["alpha", "beta", "delta", "gamma"]);
  assert.ok(full.edges.some((e) => e.dst_slug === "alpha")); // the cycle edge

  // maxNodes is a hard cap regardless of how much graph remains.
  const capped = graph.traverse("alpha", { maxDepth: 10, maxNodes: 2 });
  assert.equal(capped.nodes.length, 2);
});

test("searchNeurons matches partial titles (case-insensitive) with a capped limit", () => {
  const graph = fresh();
  buildGraph(graph);

  assert.deepEqual(slugs(graph.searchNeurons("amma")), ["gamma"]);
  assert.equal(graph.searchNeurons("ALPHA").length, 1); // case-insensitive
  assert.ok(graph.searchNeurons("a", 1).length <= 1); // limit honored
});

test("brainSize returns exact counts; brainSizeScalar = neurons + synapses", () => {
  const graph = fresh();
  buildGraph(graph);

  // 3 neurons; 4 synapses (A→B, A→C, A→Delta, B→C); 1 dangling (Delta).
  assert.deepEqual(graph.brainSize(), { neurons: 3, synapses: 4, dangling: 1 });
  assert.equal(graph.brainSizeScalar(), 7);
});
