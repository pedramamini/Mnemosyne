/**
 * Findings diff engine (MNEMO-26).
 *
 * `diffFindings` is the heart of delta-aware reporting (PRD §6.4): given the agent's
 * *remembered* prior findings and its current findings, it computes a typed
 * {@link FindingsDelta} - what was added, removed, and changed since last time -
 * keyed by each {@link Fact.key}. A scheduled report is then driven off the delta
 * ("here's what's new/changed") instead of re-summarizing the whole brain.
 *
 * The function is PURE (no IO) so it is exhaustively unit-testable. Two design
 * choices keep it honest:
 *   - **Compare by stable `key`.** A fact's identity is its `key` (`funding.last_round`),
 *     not its position or label - so reordering or relabeling never reads as a change.
 *   - **Normalize values before comparing.** `"$10M"` and `"$10 M"` are the *same*
 *     fact unchanged; {@link normalizeValue} defines exactly what "the same" means so
 *     a scheduled report doesn't fire on cosmetic churn.
 */
import type { Fact, Findings } from "./findings.ts";

/** A single value change of an existing fact (same `key`, different value). */
export interface FactChange {
  /** The fact's stable key (unchanged across the change). */
  key: string;
  /** The fact's human label (taken from the current side). */
  label: string;
  /** The prior value (verbatim, not normalized - for display). */
  from: string;
  /** The current value (verbatim). */
  to: string;
}

/**
 * The typed result of {@link diffFindings}. `added`/`removed` carry the full facts;
 * `changed` carries the key + before/after values; `unchangedCount` is a COUNT only
 * (the unchanged facts are never echoed - a delta-aware report surfaces change, not
 * the steady state). All lists are ordered by `key` for deterministic output.
 */
export interface FindingsDelta {
  /** Facts present now but not before. */
  added: Fact[];
  /** Facts present before but gone now. */
  removed: Fact[];
  /** Facts whose normalized value changed. */
  changed: FactChange[];
  /** How many facts were present in both with an unchanged (normalized) value. */
  unchangedCount: number;
}

/**
 * Normalize a value for *equality* comparison (NOT for display). Trims, lowercases,
 * and strips all internal whitespace, so `"$10M"` ≡ `"$10 M"` ≡ `"  $10 m "` - the
 * cosmetic differences that should NOT register as a material change. Display always
 * uses the verbatim value (see {@link FactChange.from}/`to`); only the comparison
 * runs through here.
 */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Diff prior vs current findings into a typed {@link FindingsDelta}, keyed by
 * {@link Fact.key}. A key only in `current` → `added`; only in `prior` → `removed`;
 * in both with a differing {@link normalizeValue} → `changed`; in both with an equal
 * normalized value → counted in `unchangedCount`. Pure + deterministic: inputs are
 * not mutated and every output list is ordered by `key`.
 */
export function diffFindings(
  prior: Findings,
  current: Findings,
): FindingsDelta {
  const priorByKey = new Map(prior.facts.map((f) => [f.key, f]));
  const currentByKey = new Map(current.facts.map((f) => [f.key, f]));

  const added: Fact[] = [];
  const changed: FactChange[] = [];
  let unchangedCount = 0;

  for (const fact of sortByKey([...currentByKey.values()])) {
    const before = priorByKey.get(fact.key);
    if (!before) {
      added.push(fact);
    } else if (normalizeValue(before.value) !== normalizeValue(fact.value)) {
      changed.push({
        key: fact.key,
        label: fact.label,
        from: before.value,
        to: fact.value,
      });
    } else {
      unchangedCount++;
    }
  }

  const removed = sortByKey(
    [...priorByKey.values()].filter((f) => !currentByKey.has(f.key)),
  );

  return { added, removed, changed, unchangedCount };
}

/**
 * Reduce a {@link FindingsDelta} to a one-line human headline + an `isEmpty` flag.
 * The headline feeds the `report.generated` audit event and the report intro
 * ("3 new facts, 1 changed, 0 removed since last report"); `isEmpty` is true ONLY
 * when nothing material changed (no adds, removes, or changes), which is what the
 * scheduled-run skip (`opts.skipWhenUnchanged`) keys off - `unchangedCount` does NOT
 * affect emptiness (a report with 100 steady facts and zero changes is still empty).
 */
export function summarizeDelta(delta: FindingsDelta): {
  headline: string;
  isEmpty: boolean;
} {
  const isEmpty =
    delta.added.length === 0 &&
    delta.removed.length === 0 &&
    delta.changed.length === 0;
  if (isEmpty) {
    return { headline: "No material changes since last report", isEmpty: true };
  }
  const facts = delta.added.length === 1 ? "fact" : "facts";
  const headline =
    `${delta.added.length} new ${facts}, ` +
    `${delta.changed.length} changed, ` +
    `${delta.removed.length} removed since last report`;
  return { headline, isEmpty: false };
}

/** Order facts by stable `key` (deterministic output, no input mutation). */
function sortByKey(facts: Fact[]): Fact[] {
  return [...facts].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}
