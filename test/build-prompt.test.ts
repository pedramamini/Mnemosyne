import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../src/agent/build/systemPrompt.ts";
import { getTemplate } from "../src/agent/build/template.ts";
import { defaultBuildStatus } from "../src/agent/build/types.ts";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";

// MNEMO-30: unit-test the PURE Build pieces - the system-prompt assembler, the
// template registry + fallback, and the default Build state. No sandbox, no
// model, no DO (these run in the workers pool but touch no bindings).

/** A finalized Discovery spec for the prompt assembler. */
const SPEC: DiscoverySpec = {
  name: "Acme Watcher",
  description: "Track Acme Corp's product and security news.",
  subject: "Acme Corp, the SaaS vendor",
  entityType: "other",
  sources: ["acme.example/blog", "security advisories"],
  cadence: "weekly on Mondays",
  outputFormat: "a short markdown brief, newest changes first",
  confidence: 0.92,
  facetNotes: {
    subject: "Acme Corp specifically.",
    entityType: "Generic.",
    sources: "Blog + advisories.",
    cadence: "Weekly.",
    outputFormat: "Brief, change-led.",
  },
  finalizedAt: "2026-05-25T00:00:00.000Z",
};

describe("assembleSystemPrompt", () => {
  it("includes the spec subject, the template fragment, and the /brain base persona", () => {
    const template = getTemplate(SPEC.entityType);
    const prompt = assembleSystemPrompt({ spec: SPEC, template });

    expect(prompt).toContain(SPEC.subject);
    expect(prompt).toContain(template.systemPromptFragment);
    // The base-persona reminder anchors the file-based brain (PRD §4/§6.2).
    expect(prompt).toContain("/brain");
    expect(prompt).toContain("[[wikilinks]]");
    // It also weaves in the user's own words - the sources + the report shape.
    expect(prompt).toContain("acme.example/blog");
    expect(prompt).toContain(SPEC.outputFormat);
  });
});

describe("getTemplate", () => {
  it("returns the minimal default for 'other'", () => {
    const t = getTemplate("other");
    expect(t.key).toBe("other");
    // Ships starter notes (scope + open-questions) that link to each other, so a
    // generic agent boots with a non-empty brain rather than "0 neurons".
    expect(t.seedNotes.length).toBeGreaterThan(0);
    expect(t.seedNotes.map((n) => n.path)).toContain(
      "/brain/notes/research-scope.md",
    );
    expect(
      t.seedNotes.some((n) => n.content.includes("[[Open Questions]]")),
    ).toBe(true);
    // A sane weekly cadence default (Monday 13:00 UTC).
    expect(t.defaultCadenceCron).toBe("0 13 * * 1");
  });

  it("returns the real template for a registered lens (MNEMO-31)", () => {
    // MNEMO-31 registered vendor/product/investor/founder; getTemplate now returns
    // each real lens (their own `key`), and the per-template invariants are
    // exercised in test/templates.test.ts.
    expect(getTemplate("vendor").key).toBe("vendor");
    expect(getTemplate("founder").key).toBe("founder");
  });

  it("still falls back to 'other' for an unregistered lens (never throws)", () => {
    const unknown = "not-a-lens" as Parameters<typeof getTemplate>[0];
    expect(() => getTemplate(unknown)).not.toThrow();
    expect(getTemplate(unknown).key).toBe("other");
  });
});

describe("defaultBuildStatus", () => {
  it("is not_started with no completed steps and no error", () => {
    const s = defaultBuildStatus();
    expect(s.phase).toBe("not_started");
    expect(s.completed).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.builtAt).toBeNull();
  });
});
