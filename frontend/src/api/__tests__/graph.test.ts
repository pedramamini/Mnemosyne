import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUrl, installFetchMock, jsonResponse } from "../../test/apiMock";
import type { RawNeuron, Subgraph } from "../graph";
import {
  getBrainGraph,
  getBrainSize,
  getBrainSubgraph,
  normalizeSubgraph,
  searchNeurons,
} from "../graph";

function neuron(over: Partial<RawNeuron> = {}): RawNeuron {
  return {
    path: "/brain/notes/a.md",
    slug: "a",
    title: null,
    updated_at: 0,
    ...over,
  };
}

describe("graph - normalizeSubgraph (pure)", () => {
  it("derives node ids, types, titles and degree from incident edges", () => {
    const sub: Subgraph = {
      nodes: [
        neuron({ path: "/brain/notes/a.md", slug: "a", title: "Note A" }),
        neuron({ path: "/brain/tools/t.md", slug: "t", title: null }),
        neuron({ path: "/brain/reports/r.md", slug: "r" }),
        neuron({ path: null, slug: "ghost", dangling: true }),
      ],
      edges: [
        {
          src_path: "/brain/notes/a.md",
          dst_slug: "t",
          dst_path: "/brain/tools/t.md",
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
    const { nodes, edges } = normalizeSubgraph(sub);

    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["/brain/notes/a.md"].title).toBe("Note A");
    expect(byId["/brain/notes/a.md"].neuronType).toBe("note");
    expect(byId["/brain/notes/a.md"].degree).toBe(2); // two outgoing edges
    expect(byId["/brain/notes/a.md"].group).toBe("notes"); // folder group
    expect(byId["/brain/tools/t.md"].neuronType).toBe("tool");
    expect(byId["/brain/tools/t.md"].title).toBe("t"); // basename, .md stripped
    expect(byId["/brain/tools/t.md"].group).toBe("tools");
    expect(byId["/brain/reports/r.md"].neuronType).toBe("report");
    // dangling target keyed `dangling:<slug>` so it lines up with the leaf node
    expect(byId["dangling:ghost"].neuronType).toBe("dangling");
    expect(byId["dangling:ghost"].path).toBe("");
    expect(byId["dangling:ghost"].group).toBe("dangling");
    expect(edges[1].target).toBe("dangling:ghost");
  });

  it("groups nested folders by their full relative dir, top-level notes as 'root'", () => {
    const { nodes } = normalizeSubgraph({
      nodes: [
        neuron({ path: "/brain/notes/people/acme.md", slug: "acme" }),
        neuron({ path: "/brain/top.md", slug: "top" }),
      ],
      edges: [],
    });
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["/brain/notes/people/acme.md"].group).toBe("notes/people");
    expect(byId["/brain/top.md"].group).toBe("root");
  });

  it("labels a path outside notes/tools/reports as 'other'", () => {
    const { nodes } = normalizeSubgraph({
      nodes: [neuron({ path: "/brain/misc/x.md", slug: "x" })],
      edges: [],
    });
    expect(nodes[0].neuronType).toBe("other");
    expect(nodes[0].degree).toBe(0);
  });
});

describe("graph - fetch-backed reads", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("getBrainSize hits /brain/size", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ neurons: 3, synapses: 4, dangling: 1 }),
    );
    expect(await getBrainSize("a1")).toEqual({
      neurons: 3,
      synapses: 4,
      dangling: 1,
    });
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/brain/size");
  });

  it("getBrainSubgraph passes start (+ optional depth)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nodes: [], edges: [] }));
    await getBrainSubgraph("a1", "root", { depth: 2 });
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/agents/a1/brain/graph?");
    expect(url).toContain("start=root");
    expect(url).toContain("depth=2");
  });

  it("searchNeurons passes q (+ optional limit)", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await searchNeurons("a1", "acme", 5);
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/agents/a1/brain/search?");
    expect(url).toContain("q=acme");
    expect(url).toContain("limit=5");
  });

  it("getBrainGraph fetches size + the WHOLE graph (no start param) when no start slug", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/brain/size")) {
        return Promise.resolve(
          jsonResponse({ neurons: 9, synapses: 9, dangling: 0 }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          nodes: [neuron({ path: "/brain/notes/a.md", slug: "a", title: "A" })],
          edges: [],
        }),
      );
    });
    const g = await getBrainGraph("a1", { start: "   " }); // blank trims to no start
    expect(g.brainSize).toEqual({ neurons: 9, synapses: 9 });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].title).toBe("A");
    // The graph fetch is the whole-brain mode: it carries NO `start` query param.
    const graphUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/brain/graph"));
    expect(graphUrl).toBeDefined();
    expect(graphUrl).not.toContain("start=");
    expect(fetchMock).toHaveBeenCalledTimes(2); // size + whole-graph fetch
  });

  it("getBrainGraph fetches size + subgraph and normalizes when given a start", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/brain/size")) {
        return Promise.resolve(
          jsonResponse({ neurons: 2, synapses: 1, dangling: 0 }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          nodes: [neuron({ path: "/brain/notes/a.md", slug: "a", title: "A" })],
          edges: [],
        }),
      );
    });
    const g = await getBrainGraph("a1", { start: "a", depth: 1 });
    expect(g.brainSize).toEqual({ neurons: 2, synapses: 1 });
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].title).toBe("A");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
