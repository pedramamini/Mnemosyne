/**
 * fuzzyMatch - a tiny subsequence fuzzy matcher for command-palette / typeahead
 * filtering. It answers two questions in one pass: does `query` match `target`
 * as an (in-order, gap-tolerant) subsequence, and how *good* is that match - so
 * results can be ranked and the matched characters highlighted.
 *
 * Matching is case-insensitive and greedy (first viable position per query
 * char), which is plenty for short command labels. Scoring rewards matches that
 * feel intentional: consecutive runs, hits at word boundaries (start of string,
 * after a separator, or a camelCase hump), and a match on the very first
 * character; longer targets are nudged down so a tight match on a short label
 * beats a scattered one on a long string. Returns `null` when the query is not
 * a subsequence of the target.
 */

export interface FuzzyResult {
  /** Higher is a better match. Only meaningful relative to other results. */
  score: number;
  /** Half-open `[start, end)` index ranges of matched chars in `target`. */
  ranges: Array<[number, number]>;
}

const SEPARATOR = /[\s\-_/.:]/;

/** Whether index `i` in `target` begins a "word" (boundary-aware highlighting). */
function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  const cur = target[i];
  if (SEPARATOR.test(prev)) return true;
  // camelCase / PascalCase hump: lower→upper transition.
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}

/**
 * Match `query` against `target`. An empty/whitespace-only query matches
 * everything with a neutral score and no highlight ranges.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { score: 0, ranges: [] };

  const t = target;
  const tl = target.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let qi = 0;
  let score = 0;
  let prevMatch = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (tl[ti] !== q[qi]) continue;

    let charScore = 1;
    const consecutive = ti === prevMatch + 1;
    if (consecutive) charScore += 4;
    if (isBoundary(t, ti)) charScore += 3;
    if (ti === 0) charScore += 2;
    score += charScore;

    // Merge adjacent matches into one highlight range; else open a new one.
    const last = ranges[ranges.length - 1];
    if (consecutive && last) last[1] = ti + 1;
    else ranges.push([ti, ti + 1]);

    prevMatch = ti;
    qi += 1;
  }

  if (qi < q.length) return null;

  // Gently prefer shorter targets so exact-ish short labels outrank long ones.
  score -= t.length * 0.05;
  return { score, ranges };
}
