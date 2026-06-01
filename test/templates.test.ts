import { describe, expect, it } from "vitest";
import { assembleSystemPrompt } from "../src/agent/build/systemPrompt.ts";
import { getTemplate } from "../src/agent/build/template.ts";
import VENDOR_TEMPLATE from "../src/agent/build/templates/vendor.ts";
import type {
  DiscoveryEntityType,
  DiscoverySpec,
} from "../src/agent/discovery/types.ts";

// MNEMO-31: the four real entity templates (vendor/product/investor/founder)
// behind MNEMO-30's `EntityTemplate` interface. Pure data + registry wiring, so
// these run in the workers pool but touch no bindings.

/** The four real lenses MNEMO-31 ships (the fifth key, `"other"`, is the fallback). */
const REAL_KEYS = ["vendor", "product", "investor", "founder"] as const;

/** A loose 5-field cron check: five whitespace-separated non-empty fields. */
const FIVE_FIELD_CRON = /^\s*\S+(\s+\S+){4}\s*$/;

describe.each(REAL_KEYS)("entity template: %s", (key: DiscoveryEntityType) => {
  const template = getTemplate(key);

  it("resolves to its own key (not the fallback)", () => {
    expect(template.key).toBe(key);
  });

  it("has a non-empty system-prompt fragment and report-shape hint", () => {
    expect(template.systemPromptFragment.trim().length).toBeGreaterThan(0);
    expect(template.reportShapeHint.trim().length).toBeGreaterThan(0);
  });

  it("seeds at least one default source", () => {
    expect(template.defaultSources.length).toBeGreaterThan(0);
  });

  it("declares a valid 5-field cron cadence", () => {
    expect(template.defaultCadenceCron).toMatch(FIVE_FIELD_CRON);
  });

  it("keeps every seed note inside /brain/", () => {
    // The four templates each ship a profile stub; if a future edit drops them,
    // the path invariant still must hold for whatever remains.
    for (const note of template.seedNotes) {
      expect(note.path.startsWith("/brain/")).toBe(true);
    }
  });
});

describe("getTemplate fallback", () => {
  it("returns the 'other' default for the 'other' key", () => {
    expect(getTemplate("other").key).toBe("other");
  });

  it("falls back to 'other' for an unknown key without throwing", () => {
    // A key outside the enum can't occur via the typed path, but getTemplate must
    // still degrade gracefully (never throw) if one slips through at runtime.
    const unknown = "totally-not-a-lens" as DiscoveryEntityType;
    expect(() => getTemplate(unknown)).not.toThrow();
    expect(getTemplate(unknown).key).toBe("other");
  });
});

describe("template composes into the operating prompt", () => {
  it("includes the vendor fragment when assembled (MNEMO-30 assembleSystemPrompt)", () => {
    const spec: DiscoverySpec = {
      name: "Acme Watcher",
      description: "Track Acme Corp as a vendor.",
      subject: "Acme Corp, a SaaS vendor",
      entityType: "vendor",
      sources: [],
      cadence: "weekly",
      outputFormat: "a short markdown brief",
      confidence: 0.9,
      facetNotes: {
        subject: "Acme.",
        entityType: "Vendor lens.",
        sources: "Defaults.",
        cadence: "Weekly.",
        outputFormat: "Brief.",
      },
      finalizedAt: "2026-05-25T00:00:00.000Z",
    };

    const prompt = assembleSystemPrompt({
      spec,
      template: getTemplate("vendor"),
    });
    expect(prompt).toContain(VENDOR_TEMPLATE.systemPromptFragment);
    // The vendor lens's distinctive language must survive composition.
    expect(prompt).toContain("Lens - vendor / supplier");
  });
});
