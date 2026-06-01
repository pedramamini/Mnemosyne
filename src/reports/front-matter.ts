/**
 * Obsidian-style report front matter (MNEMO-24).
 *
 * A finished report is a self-contained markdown file: a `---`-fenced YAML block
 * (this module) + a markdown body (`markdown.ts`) + embedded PNG charts. The front
 * matter is the report's *neuron metadata* - title, the entity template lens it was
 * produced under, tags, and provenance (created, period/cadence, source count) - so
 * the artifact is a first-class citizen of both Obsidian and the brain graph
 * (PRD §6.2/§6.4).
 *
 * **Stable key order is load-bearing.** `serializeFrontMatter` emits keys in ONE
 * fixed order and skips absent optionals, so the same input is byte-identical
 * run-to-run. MNEMO-26 (report delta/diff) diffs two reports' front matter
 * textually; a key whose position wobbles run-to-run would show as a spurious
 * change. The serializer is a small, dependency-light, deterministic emitter (no
 * YAML lib in the tree, and we want full control over ordering/quoting) - NOT a
 * general YAML writer; it handles exactly the scalar/string-list shapes this schema
 * produces.
 */
import { z } from "zod";
import { AgentTemplate } from "../db/index.ts";

/**
 * The typed front matter of a report. `template` reuses the registry's
 * {@link AgentTemplate} enum (vendor/product/investor/founder) so the report's
 * entity lens stays in lockstep with the agent's D1 column - one source of truth,
 * no drift. Optional provenance fields (`period`/`cadence`/`source_count`) are
 * omitted from the YAML entirely when absent (see the stable-order note above).
 */
export const ReportFrontMatter = z.object({
  title: z.string().min(1).describe("Human title of the report."),
  type: z
    .literal("report")
    .default("report")
    .describe("Obsidian note type - always 'report' for a report artifact."),
  agentId: z.string().min(1).describe("The agent that produced the report."),
  /** The entity-template lens (vendor/product/investor/founder); optional. */
  template: AgentTemplate.optional(),
  tags: z
    .array(z.string())
    .default([])
    .describe("Obsidian tags for graph/search filtering."),
  created: z.string().describe("ISO-8601 timestamp the report was generated."),
  period: z
    .string()
    .optional()
    .describe("Reporting period covered, e.g. '2026-Q2'."),
  cadence: z
    .string()
    .optional()
    .describe("Schedule cadence, e.g. 'weekly', if produced on a schedule."),
  source_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of sources the findings were drawn from."),
});

/** The inferred (post-default) shape of {@link ReportFrontMatter}. */
export type ReportFrontMatter = z.infer<typeof ReportFrontMatter>;

/**
 * The fixed emission order for {@link serializeFrontMatter}. MNEMO-26 relies on
 * this being a single, stable list - append new keys to the END, never reorder,
 * or two otherwise-identical reports will diff on key position alone.
 */
const KEY_ORDER = [
  "title",
  "type",
  "agentId",
  "template",
  "tags",
  "created",
  "period",
  "cadence",
  "source_count",
] as const;

/**
 * Serialize front matter to a `---`-fenced YAML block (trailing newline included),
 * keys in the fixed {@link KEY_ORDER}, absent optionals omitted. The input is
 * parsed first so defaults (`type`, `tags`) are applied - the output is therefore
 * a pure function of the *meaningful* input, which is exactly the determinism
 * MNEMO-26's textual diff depends on. `tags` renders as a YAML block list (or `[]`
 * when empty); every string is quoted only when it would otherwise be ambiguous
 * YAML (see {@link needsQuoting}).
 */
export function serializeFrontMatter(
  fm: z.input<typeof ReportFrontMatter>,
): string {
  const parsed = ReportFrontMatter.parse(fm);
  const lines: string[] = ["---"];
  for (const key of KEY_ORDER) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue; // omit absent optionals (stable diff)
    if (Array.isArray(value)) {
      lines.push(...yamlList(key, value as string[]));
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/** Render `key: <list>` as a YAML block list, or `key: []` when empty. */
function yamlList(key: string, items: string[]): string[] {
  if (items.length === 0) return [`${key}: []`];
  return [`${key}:`, ...items.map((item) => `  - ${yamlScalar(item)}`)];
}

/** Render one scalar: numbers verbatim, strings plain or double-quoted as needed. */
function yamlScalar(value: unknown): string {
  if (typeof value === "number") return String(value);
  const s = String(value);
  return needsQuoting(s) ? doubleQuote(s) : s;
}

/**
 * Whether a string would be ambiguous as a bare YAML scalar and must be quoted.
 * Conservative on purpose - when in doubt we quote, so a title containing a colon
 * (`Acme: Q2 Review`), an ISO date (the `:` in the time), a leading indicator
 * character, or a number/bool-looking word never re-parses as the wrong type.
 */
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true; // leading/trailing whitespace
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s)) return true; // YAML special chars
  if (/[\n\t]/.test(s)) return true; // control chars
  if (/^[-?]/.test(s)) return true; // block/indicator start
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true; // bool/null-ish
  if (/^[+-]?(\d|\.\d)/.test(s)) return true; // number-ish start
  return false;
}

/** Double-quote a string with the minimal YAML escapes (`\`, `"`, newlines, tabs). */
function doubleQuote(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
