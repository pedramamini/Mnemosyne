import { describe, expect, it } from "vitest";
import {
  type ConsolidationOp,
  type NoteInput,
  planConsolidation,
} from "../src/memory/consolidation.ts";

// Planning is pure (no FS/DO/git) - these run in the Workers pool but touch no
// bindings, like memory-layout.test.ts. They pin the deterministic, non-LLM
// scaffolding MNEMO-10 ships: merge near-duplicates, relink now-resolvable
// danglers, and stay idempotent (a re-plan after applying yields no change).
// Applying a plan against a real sandbox/git is the manual checkpoint.

/** The single op of a given type, asserting exactly one was proposed. */
function onlyOp(
  notes: NoteInput[],
  type: ConsolidationOp["type"],
): ConsolidationOp {
  const ops = planConsolidation(notes).ops.filter((o) => o.type === type);
  expect(ops).toHaveLength(1);
  return ops[0];
}

describe("planConsolidation - merge near-duplicates", () => {
  it("proposes a merge for two notes sharing a title, with correct before/after", () => {
    const notes: NoteInput[] = [
      { slug: "acme", content: "# Acme Corp\n\nFounded 2020." },
      { slug: "acme-dup", content: "# Acme Corp\n\nHQ in Austin." },
    ];
    const op = onlyOp(notes, "merge");

    // Survivor is the lexicographically-smallest slug; the other is removed.
    expect(op.target).toBe("acme");
    expect(op.removeSlug).toBe("acme-dup");

    // before is the survivor verbatim; after folds in the duplicate's new line.
    expect(op.before).toBe("# Acme Corp\n\nFounded 2020.");
    expect(op.after).toContain("Founded 2020.");
    expect(op.after).toContain("HQ in Austin.");
    expect(op.after).not.toBe(op.before);

    // The removed note's content is captured so its deletion is diffable.
    expect(op.removeBefore).toBe("# Acme Corp\n\nHQ in Austin.");
  });
});

describe("planConsolidation - relink now-resolvable danglers", () => {
  it("repairs a format-only dangling link to the canonical note title", () => {
    // `[[Acme-Corp]]` slugifies to "acme-corp" (slugifyTarget folds case +
    // whitespace, NOT punctuation), so it dangles against the note titled
    // "Acme Corp" - but a looser key resolves it, so it's relinkable.
    const notes: NoteInput[] = [
      { slug: "memo", content: "See [[Acme-Corp]] for details." },
      { slug: "acme", content: "# Acme Corp\n\nThe vendor." },
    ];
    const op = onlyOp(notes, "relink");

    expect(op.target).toBe("memo");
    expect(op.before).toBe("See [[Acme-Corp]] for details.");
    expect(op.after).toBe("See [[Acme Corp]] for details.");
  });

  it("leaves already-resolving links untouched (no relink op)", () => {
    const notes: NoteInput[] = [
      { slug: "memo", content: "See [[Acme Corp]] for details." },
      { slug: "acme", content: "# Acme Corp\n\nThe vendor." },
    ];
    expect(planConsolidation(notes).ops).toHaveLength(0);
  });
});

describe("planConsolidation - idempotent / clean brain", () => {
  it("produces an empty plan for a brain with no dupes or danglers", () => {
    const notes: NoteInput[] = [
      { slug: "x", content: "# X\n\nLinks to [[Y]]." },
      { slug: "y", content: "# Y\n\nStandalone." },
    ];
    expect(planConsolidation(notes).ops).toHaveLength(0);
  });

  it("running again on the applied result yields no second change (merge)", () => {
    const notes: NoteInput[] = [
      { slug: "acme", content: "# Acme Corp\n\nFounded 2020." },
      { slug: "acme-dup", content: "# Acme Corp\n\nHQ in Austin." },
    ];
    const op = onlyOp(notes, "merge");

    // Simulate applying the merge: survivor takes `after`, the duplicate is gone.
    const applied: NoteInput[] = [{ slug: op.target, content: op.after }];
    expect(planConsolidation(applied).ops).toHaveLength(0);
  });

  it("running again on the applied result yields no second change (relink)", () => {
    const notes: NoteInput[] = [
      { slug: "memo", content: "See [[Acme-Corp]] for details." },
      { slug: "acme", content: "# Acme Corp\n\nThe vendor." },
    ];
    const op = onlyOp(notes, "relink");

    const applied: NoteInput[] = [
      { slug: "memo", content: op.after },
      { slug: "acme", content: "# Acme Corp\n\nThe vendor." },
    ];
    expect(planConsolidation(applied).ops).toHaveLength(0);
  });
});

describe("planConsolidation - every op carries renderable before/after", () => {
  it("every proposed op has string before/after content (the diff source)", () => {
    const notes: NoteInput[] = [
      { slug: "acme", content: "# Acme Corp\n\nFounded 2020." },
      { slug: "acme-dup", content: "# Acme Corp\n\nHQ in Austin." },
      { slug: "memo", content: "See [[Acme-Corp]] for details." },
    ];
    const { ops } = planConsolidation(notes);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(typeof op.before).toBe("string");
      expect(typeof op.after).toBe("string");
      expect(op.before.length).toBeGreaterThan(0);
      expect(op.reason.length).toBeGreaterThan(0);
    }
  });
});
