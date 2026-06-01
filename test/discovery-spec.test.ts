import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { DISCOVERY_FACETS } from "../src/agent/discovery/facets.ts";
import { buildDiscoverySystemPrompt } from "../src/agent/discovery/prompt.ts";
import { makeDiscoveryTools } from "../src/agent/discovery/tools.ts";
import {
  DiscoverySpec,
  defaultDiscoveryState,
} from "../src/agent/discovery/types.ts";

// MNEMO-29: unit-test the PURE pieces of Discovery - no model calls, no DO. The
// confidence gate is a terminator-style `finalize_discovery` tool whose
// inputSchema IS the DiscoverySpec, so a finalized Discovery is always a
// well-formed spec; these tests pin that contract.

/** A complete, valid Discovery spec (the shape the terminator emits). */
const VALID_SPEC: DiscoverySpec = {
  name: "Acme Watcher",
  description: "Track Acme Corp's product and security news.",
  subject: "Acme Corp, the SaaS vendor",
  entityType: "vendor",
  sources: ["acme.example/blog", "security advisories", "tech press"],
  cadence: "weekly on Mondays",
  outputFormat: "a short markdown brief, newest changes first",
  confidence: 0.92,
  facetNotes: {
    subject: "Acme Corp specifically, not the whole category.",
    entityType: "A vendor - track releases, pricing, advisories.",
    sources: "Official blog + advisories + tech press.",
    cadence: "Weekly cadence is enough.",
    outputFormat: "Brief, scannable, change-led.",
  },
  finalizedAt: "2026-05-25T00:00:00.000Z",
};

/** Invoke a tool's execute with a minimal options object (unused by Discovery). */
function invoke(t: Tool, input: unknown): Promise<unknown> {
  const execute = t.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("DiscoverySpec schema", () => {
  it("accepts a full valid spec", () => {
    expect(DiscoverySpec.safeParse(VALID_SPEC).success).toBe(true);
  });

  it("rejects a spec missing subject", () => {
    const { subject: _omitted, ...missing } = VALID_SPEC;
    expect(DiscoverySpec.safeParse(missing).success).toBe(false);
  });

  it("rejects a spec missing entityType", () => {
    const { entityType: _omitted, ...missing } = VALID_SPEC;
    expect(DiscoverySpec.safeParse(missing).success).toBe(false);
  });

  it("rejects an unknown entityType", () => {
    expect(
      DiscoverySpec.safeParse({ ...VALID_SPEC, entityType: "spaceship" })
        .success,
    ).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(
      DiscoverySpec.safeParse({ ...VALID_SPEC, confidence: 1.5 }).success,
    ).toBe(false);
    expect(
      DiscoverySpec.safeParse({ ...VALID_SPEC, confidence: -0.1 }).success,
    ).toBe(false);
  });
});

describe("defaultDiscoveryState", () => {
  it("starts in_progress with no spec, zero turns, and no progress", () => {
    expect(defaultDiscoveryState()).toEqual({
      status: "in_progress",
      spec: null,
      turns: 0,
      progress: null,
    });
  });
});

describe("buildDiscoverySystemPrompt", () => {
  it("includes the agent name, description, and a line for every facet", () => {
    const prompt = buildDiscoverySystemPrompt({
      name: "Acme Watcher",
      description: "Track Acme Corp's product and security news.",
    });

    expect(prompt).toContain("Acme Watcher");
    expect(prompt).toContain("Track Acme Corp's product and security news.");
    for (const facet of DISCOVERY_FACETS) {
      expect(prompt).toContain(facet.label);
    }
  });

  it("names the finalize_discovery tool as the only way to finish", () => {
    const prompt = buildDiscoverySystemPrompt({
      name: "X",
      description: "Y",
    });
    expect(prompt).toContain("finalize_discovery");
  });

  it("instructs a multi-turn interview, note_progress, and plain-prose replies", () => {
    const prompt = buildDiscoverySystemPrompt({ name: "X", description: "Y" });
    expect(prompt).toContain("note_progress");
    // Probes the two facets the user cares most about.
    expect(prompt.toLowerCase()).toContain("sources");
    // Forbids machine-readable markup leaking into the human-facing reply.
    expect(prompt.toLowerCase()).toMatch(
      /plain.*prose|never put|machine-readable/,
    );
    // No longer licenses an instant one-message finalize.
    expect(prompt).not.toContain("finalize right away");
  });
});

/** A valid running self-assessment (what the note_progress tool ingests). */
const VALID_PROGRESS = {
  facetNotes: {
    subject: "Acme Corp specifically.",
    entityType: "A vendor.",
    sources: "",
    cadence: "",
    outputFormat: "",
  },
  confidence: 0.4,
};

describe("makeDiscoveryTools - finalize_discovery", () => {
  it("calls onFinalize with the parsed spec and returns a confirmation when the floor is met", async () => {
    const onFinalize = vi.fn();
    const tools = makeDiscoveryTools({
      canFinalize: true,
      onProgress: vi.fn(),
      onFinalize,
    });

    const result = await invoke(tools.finalize_discovery, VALID_SPEC);

    expect(onFinalize).toHaveBeenCalledTimes(1);
    expect(onFinalize).toHaveBeenCalledWith(VALID_SPEC);
    expect(String(result)).toContain("Acme Watcher");
  });

  it("refuses to finalize below the interview floor without calling onFinalize", async () => {
    const onFinalize = vi.fn();
    const tools = makeDiscoveryTools({
      canFinalize: false,
      onProgress: vi.fn(),
      onFinalize,
    });

    const result = await invoke(tools.finalize_discovery, VALID_SPEC);

    expect(onFinalize).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/too early|keep|another/i);
  });

  it("uses the DiscoverySpec schema as its inputSchema", () => {
    const tools = makeDiscoveryTools({
      canFinalize: true,
      onProgress: vi.fn(),
      onFinalize: vi.fn(),
    });
    expect(tools.finalize_discovery.inputSchema).toBe(DiscoverySpec);
  });

  it("rejects an invalid spec without calling onFinalize", async () => {
    const onFinalize = vi.fn();
    const tools = makeDiscoveryTools({
      canFinalize: true,
      onProgress: vi.fn(),
      onFinalize,
    });
    const { subject: _omitted, ...invalid } = VALID_SPEC;

    await expect(invoke(tools.finalize_discovery, invalid)).rejects.toThrow();
    expect(onFinalize).not.toHaveBeenCalled();
  });
});

describe("makeDiscoveryTools - note_progress", () => {
  it("forwards the parsed running self-assessment and never finalizes", async () => {
    const onProgress = vi.fn();
    const onFinalize = vi.fn();
    const tools = makeDiscoveryTools({
      canFinalize: true,
      onProgress,
      onFinalize,
    });

    const result = await invoke(tools.note_progress, VALID_PROGRESS);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(VALID_PROGRESS);
    expect(onFinalize).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/progress/i);
  });

  it("rejects progress with out-of-range confidence", async () => {
    const tools = makeDiscoveryTools({
      canFinalize: true,
      onProgress: vi.fn(),
      onFinalize: vi.fn(),
    });
    await expect(
      invoke(tools.note_progress, { ...VALID_PROGRESS, confidence: 1.5 }),
    ).rejects.toThrow();
  });
});
