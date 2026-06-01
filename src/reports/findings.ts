/**
 * Structured findings model + extractors (MNEMO-26).
 *
 * A **finding** is one typed `Fact` - a stable, machine-comparable claim the agent
 * has established (e.g. `funding.last_round = "$10M Series A"`). The set of facts a
 * report or a brain is reduced to is a {@link Findings} value. This is the
 * representation MNEMO-26's delta engine (`delta.ts`) diffs over: the diff is
 * *semantic* (added/removed/changed facts keyed by a stable `key`), NOT a line diff
 * of two markdown blobs - which is the whole point of "delta-aware" reporting
 * (PRD §6.4: "because the agent remembers prior state, scheduled reports surface
 * *what changed*").
 *
 * Two complementary sources reduce to {@link Findings}:
 *   - {@link findingsFromReport} - the findings PERSISTED with a prior report. A
 *     report embeds its findings as a fenced ` ```mnemosyne-findings ` JSON block
 *     (written by the MNEMO-24 markdown assembler when MNEMO-26 hands it findings),
 *     so a report round-trips: this run reads last run's block to diff against.
 *   - {@link findingsFromMemory} - the CURRENT findings derived from the agent's
 *     neurons (MNEMO-09/10). Notes carry the same fenced fact block; we read the
 *     relevant notes through an injectable {@link FindingsSource} (the sandbox by
 *     default) and merge their facts.
 *
 * **Determinism is load-bearing.** Two runs over unchanged state MUST produce a
 * byte-identical {@link Findings} (and thus an empty delta) - otherwise a scheduled
 * report would fire on noise. So extraction sorts facts by `key`, de-dupes by `key`
 * (last write wins), and {@link serializeFindings} emits keys in a fixed order.
 */

import { z } from "zod";
import type { Env } from "../env.ts";
import { shQuote } from "../memory/git.ts";
import { NOTES_DIR } from "../memory/layout.ts";
import { getSandbox, type SandboxClient } from "../sandbox/client.ts";
import type { ReportFrontMatter } from "./front-matter.ts";

/**
 * One typed fact. `key` is the STABLE, namespaced id the delta engine compares on
 * (e.g. `funding.last_round`, `team.headcount`) - it must not wobble run-to-run for
 * the same underlying claim. `value` is always a STRING (numbers are stringified at
 * authoring time) so comparison + normalization are uniform; the chart layer parses
 * it back to a number where it can. `section` is a display-grouping hint (defaults
 * to the dotted `key` prefix); `unit`/`source`/`asOf` are optional provenance.
 */
export const Fact = z.object({
  key: z
    .string()
    .min(1)
    .describe("Stable namespaced id, e.g. 'funding.last_round'. Diff key."),
  label: z.string().min(1).describe("Human label for the fact."),
  value: z
    .string()
    .describe("The fact's value as a string (numbers stringified)."),
  unit: z.string().optional().describe("Optional unit, e.g. 'USD', '%'."),
  source: z.string().optional().describe("Optional source URL/citation."),
  asOf: z
    .string()
    .optional()
    .describe("Optional as-of date the fact reflects."),
  section: z
    .string()
    .optional()
    .describe(
      "Display-grouping section (defaults to the key's dotted prefix).",
    ),
});
export type Fact = z.infer<typeof Fact>;

/**
 * The set of facts a report / brain is reduced to. A flat, `key`-unique list (the
 * delta engine maps by `key`); {@link groupBySection} reconstructs the by-section
 * view for display. Kept a plain object (not a bare array) so the schema can grow
 * provenance later without breaking the embedded JSON contract.
 */
export const Findings = z.object({
  facts: z.array(Fact).describe("Flat list of facts, unique by `key`."),
});
export type Findings = z.infer<typeof Findings>;

/** Scope passed to {@link findingsFromMemory}: which neurons/facts to derive. */
export interface FindingsScope {
  /** Restrict to facts whose `section` (or key prefix) equals this, if set. */
  section?: string;
  /** Restrict to these absolute note paths; otherwise all notes under NOTES_DIR. */
  notePaths?: string[];
}

/**
 * The fenced-block info string a report/note uses to carry its findings JSON. A
 * dedicated, unlikely-to-collide tag so {@link parseFindingsBlock} can find OUR
 * block and never a stray ` ```json ` code sample in the prose.
 */
export const FINDINGS_FENCE = "mnemosyne-findings";

/** Fixed field order for a serialized fact (determinism - see module note). */
const FACT_KEY_ORDER: (keyof Fact)[] = [
  "key",
  "label",
  "value",
  "unit",
  "source",
  "asOf",
  "section",
];

/**
 * Sort + de-dupe facts into the canonical form: unique by `key` (last occurrence
 * wins, so a later note overrides an earlier one), ordered by `key`. The single
 * normalization point both extractors and {@link serializeFindings} run through, so
 * unchanged state always yields the identical value.
 */
export function canonicalizeFindings(findings: Findings): Findings {
  const byKey = new Map<string, Fact>();
  for (const fact of findings.facts) byKey.set(fact.key, fact);
  const facts = [...byKey.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  return { facts };
}

/**
 * Serialize {@link Findings} to deterministic JSON: facts canonicalized (sorted +
 * de-duped), each fact's keys emitted in {@link FACT_KEY_ORDER} with absent
 * optionals omitted. Byte-identical for identical state - what the diff baseline
 * relies on.
 */
export function serializeFindings(findings: Findings): string {
  const canon = canonicalizeFindings(findings);
  const facts = canon.facts.map((fact) => {
    const out: Record<string, string> = {};
    for (const key of FACT_KEY_ORDER) {
      const value = fact[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  });
  return JSON.stringify({ facts }, null, 2);
}

/** Render the findings as a fenced ` ```mnemosyne-findings ` JSON block. */
export function findingsBlock(findings: Findings): string {
  return `\`\`\`${FINDINGS_FENCE}\n${serializeFindings(findings)}\n\`\`\``;
}

/**
 * Extract the embedded findings JSON from a markdown body. Matches the FIRST
 * ` ```mnemosyne-findings ... ``` ` fence, parses it, and validates against
 * {@link Findings}. Any miss - no fence, malformed JSON, schema mismatch - yields
 * empty findings rather than throwing: a report whose block is absent/corrupt is
 * simply treated as "no prior state" (a full baseline next run), never a crash.
 */
export function parseFindingsBlock(markdown: string): Findings {
  const fence = new RegExp(
    `\`\`\`${FINDINGS_FENCE}\\s*\\n([\\s\\S]*?)\\n\`\`\``,
  );
  const match = fence.exec(markdown);
  if (!match) return { facts: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { facts: [] };
  }
  const parsed = Findings.safeParse(raw);
  return parsed.success ? canonicalizeFindings(parsed.data) : { facts: [] };
}

/**
 * Reduce a PRIOR report to its findings. `source` is either the report markdown
 * (the embedded ` ```mnemosyne-findings ` block is extracted) or an
 * already-structured {@link Findings} block (validated directly) - supporting both
 * the "read it back from R2 markdown" and "carried in memory" paths. `frontMatter`
 * is accepted for symmetry with {@link findingsFromMemory} and future provenance
 * stamping; the findings themselves live in the body block, not the front matter
 * (the dependency-light YAML serializer only handles scalars/string-lists).
 */
export function findingsFromReport(
  _frontMatter: ReportFrontMatter | null,
  source: string | Findings,
): Findings {
  if (typeof source === "string") return parseFindingsBlock(source);
  const parsed = Findings.safeParse(source);
  return parsed.success ? canonicalizeFindings(parsed.data) : { facts: [] };
}

/**
 * The note-reading surface {@link findingsFromMemory} consumes. Declared
 * structurally (not as the concrete sandbox) so the derivation is unit-testable
 * with an in-memory fake and so the default sandbox-backed reader stays the ONE
 * place that touches the container. `listNotePaths` returns the notes in scope;
 * `readNote` returns a note's content (empty string for a missing note).
 */
export interface FindingsSource {
  listNotePaths(scope: FindingsScope): Promise<string[]>;
  readNote(path: string): Promise<string>;
}

/** Injectable deps for {@link findingsFromMemory} (source defaults to the sandbox). */
export interface FindingsFromMemoryDeps {
  source?: FindingsSource;
}

/**
 * Derive the agent's CURRENT findings from its neurons (MNEMO-09/10). Lists the
 * notes in `scope`, reads each, extracts its embedded ` ```mnemosyne-findings `
 * block, and merges every fact into one canonical {@link Findings}. Notes are read
 * in sorted-path order and facts are de-duped by `key` (last wins), so the result is
 * deterministic for unchanged state. `scope.section` filters to one display section.
 *
 * The default {@link FindingsSource} reads through the per-agent sandbox; a test (or
 * the delta-report orchestrator) injects a fake or mocks this function wholesale.
 */
export async function findingsFromMemory(
  env: Env,
  agentId: string,
  scope: FindingsScope = {},
  deps: FindingsFromMemoryDeps = {},
): Promise<Findings> {
  const source =
    deps.source ?? new SandboxFindingsSource(getSandbox(env, agentId));
  const paths = [...(await source.listNotePaths(scope))].sort();
  const merged: Fact[] = [];
  for (const path of paths) {
    const content = await source.readNote(path);
    const { facts } = parseFindingsBlock(content);
    for (const fact of facts) {
      if (
        scope.section &&
        (fact.section ?? sectionOf(fact.key)) !== scope.section
      ) {
        continue;
      }
      merged.push(fact);
    }
  }
  return canonicalizeFindings({ facts: merged });
}

/** Group findings by their display section (the `section` field or key prefix). */
export function groupBySection(findings: Findings): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of canonicalizeFindings(findings).facts) {
    const section = fact.section ?? sectionOf(fact.key);
    const bucket = groups.get(section);
    if (bucket) bucket.push(fact);
    else groups.set(section, [fact]);
  }
  return groups;
}

/** The dotted prefix of a key (`funding.last_round` → `funding`), else the key. */
function sectionOf(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * The default {@link FindingsSource}: reads notes through the MNEMO-06 sandbox
 * client. `listNotePaths` honors an explicit `scope.notePaths` (no container call),
 * otherwise enumerates `*.md` under {@link NOTES_DIR} with one `find` (the dir is a
 * constant but is shell-quoted via `shQuote`, mirroring the explorer's run-pattern).
 * A missing / unreadable note degrades to empty content (never throws) so one bad
 * note can't sink the whole derivation.
 */
export class SandboxFindingsSource implements FindingsSource {
  constructor(private readonly sandbox: SandboxClient) {}

  async listNotePaths(scope: FindingsScope): Promise<string[]> {
    if (scope.notePaths) return scope.notePaths;
    const { stdout, exitCode } = await this.sandbox.run(
      `find ${shQuote(NOTES_DIR)} -type f -name '*.md' 2>/dev/null || true`,
    );
    if (exitCode !== 0) return [];
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async readNote(path: string): Promise<string> {
    try {
      return await this.sandbox.readFile(path);
    } catch {
      return "";
    }
  }
}
