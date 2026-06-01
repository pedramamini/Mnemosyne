import { describe, expect, it } from "vitest";
import {
  diffFindings,
  normalizeValue,
  summarizeDelta,
} from "../src/reports/delta.ts";
import type { Fact, Findings } from "../src/reports/findings.ts";

// MNEMO-26: exhaustive, pure unit tests of the findings diff engine. `diffFindings`
// has no IO, so every branch - added/removed/changed/unchanged, value normalization,
// and key-based identity - is exercised directly. `summarizeDelta` is tested for the
// empty + non-empty headline and the exact `isEmpty` semantics.

/** Build a fact with sensible defaults so each test states only what it varies. */
function fact(key: string, value: string, extra: Partial<Fact> = {}): Fact {
  return { key, label: extra.label ?? key, value, ...extra };
}

/** Wrap facts as a Findings value. */
function findings(...facts: Fact[]): Findings {
  return { facts };
}

describe("normalizeValue", () => {
  it("collapses whitespace + case so cosmetic differences are equal", () => {
    expect(normalizeValue("$10M")).toBe(normalizeValue("$10 M"));
    expect(normalizeValue("  $10 m ")).toBe(normalizeValue("$10M"));
    expect(normalizeValue("Series A")).toBe(normalizeValue("series  a"));
  });

  it("keeps materially different values distinct", () => {
    expect(normalizeValue("$10M")).not.toBe(normalizeValue("$11M"));
    expect(normalizeValue("Series A")).not.toBe(normalizeValue("Series B"));
  });
});

describe("diffFindings", () => {
  it("identical findings → all unchanged, empty added/removed/changed", () => {
    const a = findings(
      fact("funding.last_round", "$10M"),
      fact("team.size", "12"),
    );
    const delta = diffFindings(a, a);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(delta.unchangedCount).toBe(2);
  });

  it("a new fact → added", () => {
    const prior = findings(fact("funding.last_round", "$10M"));
    const current = findings(
      fact("funding.last_round", "$10M"),
      fact("team.size", "12"),
    );
    const delta = diffFindings(prior, current);
    expect(delta.added.map((f) => f.key)).toEqual(["team.size"]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(delta.unchangedCount).toBe(1);
  });

  it("a dropped fact → removed", () => {
    const prior = findings(
      fact("funding.last_round", "$10M"),
      fact("team.size", "12"),
    );
    const current = findings(fact("funding.last_round", "$10M"));
    const delta = diffFindings(prior, current);
    expect(delta.removed.map((f) => f.key)).toEqual(["team.size"]);
    expect(delta.added).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(delta.unchangedCount).toBe(1);
  });

  it("a changed value → changed with correct from/to", () => {
    const prior = findings(fact("funding.last_round", "$10M"));
    const current = findings(fact("funding.last_round", "$25M"));
    const delta = diffFindings(prior, current);
    expect(delta.changed).toEqual([
      {
        key: "funding.last_round",
        label: "funding.last_round",
        from: "$10M",
        to: "$25M",
      },
    ]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.unchangedCount).toBe(0);
  });

  it("value normalization → '$10M' vs '$10 M' is NOT a change", () => {
    const prior = findings(fact("funding.last_round", "$10M"));
    const current = findings(fact("funding.last_round", "$10 M"));
    const delta = diffFindings(prior, current);
    expect(delta.changed).toEqual([]);
    expect(delta.unchangedCount).toBe(1);
  });

  it("identity is the key, not position: reordering is unchanged", () => {
    const prior = findings(fact("a.x", "1"), fact("b.y", "2"));
    const current = findings(fact("b.y", "2"), fact("a.x", "1"));
    const delta = diffFindings(prior, current);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(delta.unchangedCount).toBe(2);
  });

  it("a mixed delta classifies each fact independently + orders by key", () => {
    const prior = findings(
      fact("a.keep", "same"),
      fact("b.change", "$10M"),
      fact("c.drop", "gone"),
    );
    const current = findings(
      fact("a.keep", "same"),
      fact("b.change", "$25M"),
      fact("d.add", "new"),
    );
    const delta = diffFindings(prior, current);
    expect(delta.added.map((f) => f.key)).toEqual(["d.add"]);
    expect(delta.removed.map((f) => f.key)).toEqual(["c.drop"]);
    expect(delta.changed.map((c) => c.key)).toEqual(["b.change"]);
    expect(delta.unchangedCount).toBe(1);
  });

  it("does not mutate its inputs", () => {
    const prior = findings(fact("a.x", "1"));
    const current = findings(fact("a.x", "2"), fact("b.y", "3"));
    diffFindings(prior, current);
    expect(prior.facts).toHaveLength(1);
    expect(current.facts).toHaveLength(2);
  });
});

describe("summarizeDelta", () => {
  it("empty delta → 'No material changes' + isEmpty true", () => {
    const delta = diffFindings(
      findings(fact("a.x", "1")),
      findings(fact("a.x", "1")),
    );
    const { headline, isEmpty } = summarizeDelta(delta);
    expect(isEmpty).toBe(true);
    expect(headline).toBe("No material changes since last report");
  });

  it("non-empty delta → counted headline + isEmpty false", () => {
    const prior = findings(fact("a.x", "1"), fact("c.z", "drop"));
    const current = findings(
      fact("a.x", "2"), // changed
      fact("b.y", "new1"), // added
      fact("e.w", "new2"), // added
    );
    const delta = diffFindings(prior, current);
    const { headline, isEmpty } = summarizeDelta(delta);
    expect(isEmpty).toBe(false);
    expect(headline).toBe(
      "2 new facts, 1 changed, 1 removed since last report",
    );
  });

  it("singular 'fact' for exactly one addition", () => {
    const delta = diffFindings(findings(), findings(fact("a.x", "1")));
    expect(summarizeDelta(delta).headline).toBe(
      "1 new fact, 0 changed, 0 removed since last report",
    );
  });

  it("isEmpty is true ONLY when added/removed/changed are all empty", () => {
    // Lots of unchanged facts but zero deltas is still empty (no churn report).
    const same = findings(fact("a.x", "1"), fact("b.y", "2"), fact("c.z", "3"));
    expect(summarizeDelta(diffFindings(same, same)).isEmpty).toBe(true);

    // A single change flips it to non-empty.
    const changed = findings(
      fact("a.x", "9"),
      fact("b.y", "2"),
      fact("c.z", "3"),
    );
    expect(summarizeDelta(diffFindings(same, changed)).isEmpty).toBe(false);
  });
});
