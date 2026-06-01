#!/usr/bin/env node
/**
 * Merge backend line-coverage across the repo's TWO test runners into one honest
 * number.
 *
 * The backend is tested by two runtimes that cannot share a coverage pass:
 *   1. vitest + @cloudflare/vitest-pool-workers (workerd / Miniflare) - the bulk
 *      of the suite. Emits istanbul `coverage/lcov.info`.
 *   2. node:sqlite suites that CANNOT run in workerd (graph-index / graph-retrieval
 *      / audit-store), run via `node --test` - emit a V8 lcov.
 *
 * Files exclusively tested by runner #2 (e.g. src/memory/graph-index.ts) look
 * "uncovered" to runner #1, which understates the true coverage. This script
 * unions the two lcovs per source line: a line counts as COVERED when EITHER
 * runner executed it. Istanbul's line set is the canonical denominator (it scopes
 * `src/**`, including never-loaded files at 0%), so the merge can only ever RAISE
 * the istanbul number, never invent lines.
 *
 * Usage: node scripts/merge-coverage.mjs <istanbul-lcov> <node-lcov> [...more]
 * Prints per-file movers + the merged total, and exits non-zero if < 80%.
 */
import { readFileSync } from "node:fs";

const THRESHOLD = 80;

/** Parse an lcov file into Map<sourceFile, Map<lineNo, hitCount>>. */
function parseLcov(path) {
  const files = new Map();
  let cur = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      const sf = normalize(line.slice(3).trim());
      cur = files.get(sf) ?? new Map();
      files.set(sf, cur);
    } else if (line.startsWith("DA:") && cur) {
      const [no, hits] = line.slice(3).split(",");
      const n = Number(no);
      const h = Number(hits);
      cur.set(n, Math.max(cur.get(n) ?? 0, h));
    }
  }
  return files;
}

/** Normalize an lcov SF path to a repo-relative `src/...` key. */
function normalize(p) {
  const i = p.lastIndexOf("src/");
  return i >= 0 ? p.slice(i) : p;
}

const [istanbulPath, ...extraPaths] = process.argv.slice(2);
if (!istanbulPath) {
  console.error(
    "usage: node scripts/merge-coverage.mjs <istanbul-lcov> [node-lcov ...]",
  );
  process.exit(2);
}

const base = parseLcov(istanbulPath);
const extras = extraPaths.map(parseLcov);

let foundTotal = 0;
let hitTotal = 0;
const movers = [];

for (const [sf, baseLines] of base) {
  let found = 0;
  let hit = 0;
  let gained = 0;
  for (const [no, baseHits] of baseLines) {
    found += 1;
    let covered = baseHits > 0;
    if (!covered) {
      for (const ex of extras) {
        const exHits = ex.get(sf)?.get(no) ?? 0;
        if (exHits > 0) {
          covered = true;
          gained += 1;
          break;
        }
      }
    }
    if (covered) hit += 1;
  }
  foundTotal += found;
  hitTotal += hit;
  if (gained > 0) {
    movers.push({ sf, gained, pct: ((hit / found) * 100).toFixed(1) });
  }
}

movers.sort((a, b) => b.gained - a.gained);
if (movers.length) {
  console.log("Lines reclaimed from the node:sqlite runner:");
  for (const m of movers) {
    console.log(`  +${m.gained}\t${m.pct}%\t${m.sf}`);
  }
}

const pct = (hitTotal / foundTotal) * 100;
console.log(
  `\nMERGED backend line coverage: ${hitTotal}/${foundTotal} = ${pct.toFixed(2)}%`,
);
console.log(`Threshold: ${THRESHOLD}%  →  ${pct >= THRESHOLD ? "PASS" : "FAIL"}`);
process.exit(pct >= THRESHOLD ? 0 : 1);
