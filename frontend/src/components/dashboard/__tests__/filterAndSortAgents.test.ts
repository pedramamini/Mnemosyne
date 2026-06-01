import { describe, expect, it } from "vitest";
import type { Agent } from "@/api/agents";
import { filterAndSortAgents } from "../useAgentMetrics";

/** Build an agent row with sensible defaults; override only what a test cares about. */
function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    description: null,
    template: "vendor",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const agents: Agent[] = [
  agent({
    id: "a",
    name: "Acme Watch",
    description: "Tracks Acme launches",
    template: "vendor",
    status: "active",
    created_at: "2026-05-01T00:00:00.000Z",
  }),
  agent({
    id: "b",
    name: "Globex Tracker",
    description: "Watches the GLOBEX roadmap",
    template: "product",
    status: "building",
    created_at: "2026-05-10T00:00:00.000Z",
  }),
  agent({
    id: "c",
    name: "Initech Radar",
    description: "Founder intel on Initech",
    template: "founder",
    status: "active",
    created_at: "2026-05-05T00:00:00.000Z",
  }),
];

const ALL = {
  query: "",
  template: "all" as const,
  status: "all" as const,
  sortBy: "name" as const,
};

describe("filterAndSortAgents", () => {
  it("matches the search query against the name (case-insensitive)", () => {
    const result = filterAndSortAgents(agents, { ...ALL, query: "ACME" });
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });

  it("matches the search query against the description (case-insensitive)", () => {
    const result = filterAndSortAgents(agents, { ...ALL, query: "globex" });
    expect(result.map((a) => a.id)).toEqual(["b"]);
  });

  it("narrows by template", () => {
    const result = filterAndSortAgents(agents, { ...ALL, template: "founder" });
    expect(result.map((a) => a.id)).toEqual(["c"]);
  });

  it("narrows by status", () => {
    const result = filterAndSortAgents(agents, { ...ALL, status: "active" });
    expect(result.map((a) => a.id).sort()).toEqual(["a", "c"]);
  });

  it("sorts by name alphabetically", () => {
    const result = filterAndSortAgents(agents, { ...ALL, sortBy: "name" });
    expect(result.map((a) => a.name)).toEqual([
      "Acme Watch",
      "Globex Tracker",
      "Initech Radar",
    ]);
  });

  it("sorts by newest (created_at descending)", () => {
    const result = filterAndSortAgents(agents, { ...ALL, sortBy: "newest" });
    expect(result.map((a) => a.id)).toEqual(["b", "c", "a"]);
  });

  it("composes search + template + status + sort", () => {
    const mixed: Agent[] = [
      ...agents,
      agent({
        id: "d",
        name: "Acme Beta",
        description: "Another Acme vendor watcher",
        template: "vendor",
        status: "active",
        created_at: "2026-05-20T00:00:00.000Z",
      }),
      agent({
        id: "e",
        name: "Acme Paused",
        description: "Acme vendor, paused",
        template: "vendor",
        status: "paused",
        created_at: "2026-05-25T00:00:00.000Z",
      }),
    ];
    // query "acme" → a, d, e ; template vendor → a, d, e ; status active → a, d ;
    // newest → d (05-20) before a (05-01).
    const result = filterAndSortAgents(mixed, {
      query: "acme",
      template: "vendor",
      status: "active",
      sortBy: "newest",
    });
    expect(result.map((a) => a.id)).toEqual(["d", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [...agents];
    const snapshot = input.map((a) => a.id);
    filterAndSortAgents(input, { ...ALL, sortBy: "newest" });
    expect(input.map((a) => a.id)).toEqual(snapshot);
  });
});
