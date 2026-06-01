import { describe, expect, it } from "vitest";
import { type BrainGraph, normalizeSubgraph, type Subgraph } from "@/api/graph";
import { selectGraphData } from "../useBrainGraph";

// Plain unit test for the API→renderer transform (no canvas, no network). Covers
// both halves of the pipeline: `normalizeSubgraph` (raw MNEMO-09 rows → nodes/edges
// with computed degree/neuronType/id) and `selectGraphData` (edges → links).

describe("normalizeSubgraph", () => {
  const sub: Subgraph = {
    nodes: [
      { path: "/brain/notes/a.md", slug: "a", title: "Note A", updated_at: 1 },
      { path: "/brain/notes/b.md", slug: "b", title: null, updated_at: 2 },
      {
        path: "/brain/tools/run.py",
        slug: "run",
        title: "Runner",
        updated_at: 3,
      },
      { path: null, slug: "ghost", title: null, updated_at: 0, dangling: true },
    ],
    edges: [
      // a → b (resolved), a → ghost (dangling).
      {
        src_path: "/brain/notes/a.md",
        dst_slug: "b",
        dst_path: "/brain/notes/b.md",
        alias: null,
      },
      {
        src_path: "/brain/notes/a.md",
        dst_slug: "ghost",
        dst_path: null,
        alias: null,
      },
    ],
  };

  it("maps synapses to source/target edges, resolving dangling targets by slug", () => {
    const { edges } = normalizeSubgraph(sub);
    expect(edges).toEqual([
      { source: "/brain/notes/a.md", target: "/brain/notes/b.md" },
      { source: "/brain/notes/a.md", target: "dangling:ghost" },
    ]);
  });

  it("derives node id, neuronType, title, and incident-edge degree", () => {
    const { nodes } = normalizeSubgraph(sub);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

    // `a` has two outgoing edges → degree 2; note type; explicit title.
    expect(byId["/brain/notes/a.md"]).toMatchObject({
      id: "/brain/notes/a.md",
      path: "/brain/notes/a.md",
      title: "Note A",
      neuronType: "note",
      degree: 2,
    });
    // `b` falls back to the file basename for its title; one incident edge.
    expect(byId["/brain/notes/b.md"]).toMatchObject({
      title: "b",
      neuronType: "note",
      degree: 1,
    });
    // A tool path is typed accordingly.
    expect(byId["/brain/tools/run.py"]).toMatchObject({ neuronType: "tool" });
    // The dangling target gets a synthetic id + dangling type + slug title.
    expect(byId["dangling:ghost"]).toMatchObject({
      id: "dangling:ghost",
      path: "",
      title: "ghost",
      neuronType: "dangling",
      degree: 1,
    });
  });
});

describe("selectGraphData", () => {
  const graph: BrainGraph = {
    nodes: [
      {
        id: "n1",
        path: "/brain/notes/a.md",
        title: "A",
        neuronType: "note",
        degree: 1,
      },
      {
        id: "n2",
        path: "/brain/notes/b.md",
        title: "B",
        neuronType: "note",
        degree: 1,
      },
    ],
    edges: [{ source: "n1", target: "n2" }],
    brainSize: { neurons: 2, synapses: 1 },
  };

  it("renames edges → links, preserving source/target", () => {
    const { links } = selectGraphData(graph);
    expect(links).toEqual([{ source: "n1", target: "n2" }]);
  });

  it("carries degree and neuronType through onto nodes", () => {
    const { nodes } = selectGraphData(graph);
    expect(nodes[0]).toMatchObject({ neuronType: "note", degree: 1 });
    expect(nodes).toEqual(graph.nodes);
  });

  it("passes brainSize through unchanged", () => {
    expect(selectGraphData(graph).brainSize).toEqual({
      neurons: 2,
      synapses: 1,
    });
  });
});
