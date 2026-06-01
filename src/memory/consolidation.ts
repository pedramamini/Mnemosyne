/**
 * Consolidation - the planning half (PRD §6.2, MNEMO-10).
 *
 * Consolidation is the agent's "sleep": it re-reads its own notes and proposes
 * merges, relinks, splits, and rewrites. The PRD requires this be *versioned +
 * diffed before commit* (it can corrupt the brain otherwise), so the design is
 * deliberately split into two halves:
 *
 *   - THIS module (pure, testable): turn a set of notes into a {@link
 *     ConsolidationPlan} - a list of proposed ops, each carrying the BEFORE and
 *     AFTER content so a diff can be rendered. It applies NOTHING.
 *   - src/memory/consolidation-apply.ts: assert a clean tree, diff every op,
 *     apply through the write pipeline, and make ONE commit (the safety net).
 *
 * This phase ships the deterministic, non-LLM scaffolding: detect duplicate
 * notes (by normalized-content hash and by shared title slug) and detect
 * dangling links that a small format fix would resolve to an existing note.
 * The richer, model-driven proposals arrive with the agent loop:
 *
 *   // MNEMO-15/16: LLM proposes richer merges (semantic dedup, summarization,
 *   // splits, rewrites). Those proposals slot in as additional ConsolidationOps
 *   // with the same before/after contract this scaffolding already produces.
 *
 * Pure: NO filesystem, NO Durable Object, NO git. Same discipline as wikilink.ts
 * so it is unit-testable on bare Node / in the Workers pool with zero bindings.
 */
import { slugifyTarget } from "./wikilink.ts";

/** The op kinds a plan can carry. Only `merge`/`relink` are emitted this phase. */
export type ConsolidationOpType = "merge" | "relink" | "split" | "rewrite";

/**
 * One proposed change. Every op rewrites `target`'s content from `before` →
 * `after` (the diff source). A `merge` additionally folds a duplicate into the
 * target and removes it - `removeSlug`/`removeBefore` carry the removed note so
 * its deletion is diffable too. Slugs are filename stems (notePath-resolvable).
 */
export interface ConsolidationOp {
  type: ConsolidationOpType;
  /** Human-readable rationale - shown in the diff header / audit (MNEMO-21). */
  reason: string;
  /** Note rewritten by this op; its new content is `after`. */
  target: string;
  /** `target`'s current content (the diff's left side). */
  before: string;
  /** `target`'s proposed content (the diff's right side). */
  after: string;
  /** merge only: duplicate folded into `target`, then deleted. */
  removeSlug?: string;
  /** merge only: the removed note's content (so its removal is renderable). */
  removeBefore?: string;
}

/** A consolidation proposal: data only, applies nothing. */
export interface ConsolidationPlan {
  ops: ConsolidationOp[];
}

/** A note as the planner sees it: its filename-stem slug and raw content. */
export interface NoteInput {
  slug: string;
  content: string;
}

/**
 * Plan a consolidation pass over `notes`. Deterministic and idempotent: running
 * it again on the result of applying the plan yields an empty plan (no second
 * change). Emits `merge` ops for duplicate notes and `relink` ops for danglers a
 * format fix resolves; richer proposals are the MNEMO-15/16 seam above.
 */
export function planConsolidation(notes: NoteInput[]): ConsolidationPlan {
  return { ops: [...planMerges(notes), ...planRelinks(notes)] };
}

// ─── Merge detection ────────────────────────────────────────────────────────
// A note is a duplicate of another when it shares either (a) a normalized
// content fingerprint or (b) a title slug. Survivor = the lexicographically
// smallest slug in the group (stable); the rest fold into it and are removed.
// Each note is removed at most once even if it lands in several groups.

function planMerges(notes: NoteInput[]): ConsolidationOp[] {
  const bySlug = new Map(notes.map((n) => [n.slug, n]));
  const groups = [
    ...groupBy(notes, (n) => normalizeContent(n.content)).values(),
    ...groupBy(notes, (n) => titleSlug(n.content)).values(),
  ].filter((g) => g.length > 1);

  const ops: ConsolidationOp[] = [];
  const removed = new Set<string>();
  const merged = new Set<string>(); // survivor|dup pairs already proposed

  for (const group of groups) {
    const slugs = group.map((n) => n.slug).sort();
    const survivorSlug = slugs[0];
    const survivor = bySlug.get(survivorSlug);
    if (!survivor) continue;

    for (const dupSlug of slugs.slice(1)) {
      if (removed.has(dupSlug) || dupSlug === survivorSlug) continue;
      const pair = `${survivorSlug}|${dupSlug}`;
      if (merged.has(pair)) continue;
      const dup = bySlug.get(dupSlug);
      if (!dup) continue;

      removed.add(dupSlug);
      merged.add(pair);
      ops.push({
        type: "merge",
        reason: `near-duplicate of ${survivorSlug}`,
        target: survivorSlug,
        before: survivor.content,
        after: mergeContent(survivor.content, dup.content),
        removeSlug: dupSlug,
        removeBefore: dup.content,
      });
    }
  }
  return ops;
}

/**
 * Fold `dup` into `survivor`: keep the survivor verbatim and append any lines
 * the duplicate adds that the survivor doesn't already contain. For an exact
 * duplicate this is a no-op on content (`after === before`) and the merge's only
 * effect is the removal; when the duplicate carries extra detail, `after` grows.
 */
function mergeContent(survivor: string, dup: string): string {
  const have = new Set(survivor.split(/\r?\n/).map((l) => l.trim()));
  const extra = dup
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !have.has(l.trim()));
  if (extra.length === 0) return survivor;
  return `${survivor.replace(/\n+$/, "")}\n\n${extra.join("\n")}\n`;
}

// ─── Relink detection ─────────────────────────────────────────────────────────
// A `[[link]]` is dangling when its slug matches no note's resolve-key (the
// title slug, or the filename slug when untitled). It is *now-resolvable* when a
// looser key - hyphens/underscores/punctuation folded to spaces - matches
// exactly one note. We then rewrite the link to that note's canonical display so
// it resolves exactly. (slugifyTarget folds case+whitespace but NOT punctuation,
// so `[[Acme-Corp]]` genuinely dangles against a note titled "Acme Corp".)

/** Captures `[[target]]` / `[[target|alias]]` (no nested brackets in the body). */
const LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g;

function planRelinks(notes: NoteInput[]): ConsolidationOp[] {
  // Resolution surface: how a note can be named by a link, and its canonical
  // display + a fuzzy key for near-miss matching.
  const resolveKeys = new Set<string>();
  const byLoose = new Map<string, { display: string; resolveKey: string }[]>();
  for (const n of notes) {
    const display = titleOf(n.content) ?? n.slug;
    const resolveKey = slugifyTarget(display);
    resolveKeys.add(resolveKey);
    const loose = looseKey(display);
    (byLoose.get(loose) ?? byLoose.set(loose, []).get(loose))?.push({
      display,
      resolveKey,
    });
  }

  const ops: ConsolidationOp[] = [];
  for (const n of notes) {
    const rewritten = n.content.replace(
      LINK_RE,
      (whole, rawTarget: string, alias?: string) => {
        const targetKey = slugifyTarget(rawTarget);
        if (resolveKeys.has(targetKey)) return whole; // already resolves
        const candidates = byLoose.get(looseKey(rawTarget)) ?? [];
        // Exactly one near-miss, and it isn't already this exact target.
        const match = candidates.length === 1 ? candidates[0] : null;
        if (!match || match.resolveKey === targetKey) return whole;
        return alias != null
          ? `[[${match.display}|${alias}]]`
          : `[[${match.display}]]`;
      },
    );
    if (rewritten !== n.content) {
      ops.push({
        type: "relink",
        reason: "repair dangling link to a resolvable note",
        target: n.slug,
        before: n.content,
        after: rewritten,
      });
    }
  }
  return ops;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Group items by a derived key; keys that compute to "" are skipped. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === "") continue;
    (map.get(k) ?? map.set(k, []).get(k))?.push(item);
  }
  return map;
}

/** Normalized content fingerprint: lowercased, whitespace collapsed, trimmed. */
function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Best-effort note title - front-matter `title:`, else the first `# H1`, else
 * null. Mirrors the read-side heuristic in MnemosyneAgent (titleFromContent);
 * kept local so this module stays pure (no import from the DO module).
 */
function titleOf(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const t = fm[1].match(/^title:\s*(.+?)\s*$/m);
    if (t) return t[1].replace(/^["']|["']$/g, "").trim() || null;
  }
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].trim() || null : null;
}

/** Title slug for merge grouping - the title run through the shared slugifier. */
function titleSlug(content: string): string {
  const t = titleOf(content);
  return t ? slugifyTarget(t) : "";
}

/**
 * Fuzzy match key: fold hyphens/underscores to spaces, drop other punctuation,
 * lowercase, collapse whitespace. This is intentionally looser than
 * slugifyTarget so format-only differences (`Acme-Corp` vs `Acme Corp`) collapse
 * to one key and become relink candidates.
 */
function looseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
