/**
 * Report body assembler (MNEMO-24).
 *
 * `buildReportMarkdown` composes a finished report document - Obsidian front matter
 * (`front-matter.ts`) + a markdown body with **embedded PNG charts** + `[[wikilink]]`
 * references back into the brain - and returns it together with the chart
 * {@link ChartAsset}s (path + bytes) so the orchestrator can persist and MNEMO-25
 * can embed/archive them. It is pure assembly over its inputs: it renders the charts
 * a caller asked for, it does NOT decide what to research (that is the loop/schedule).
 *
 * Chart rendering is INJECTED (a {@link CodeRunner} + {@link CtxHandle} + a brain-FS
 * {@link BrainFileWriter}), so this module is unit-testable with a mocked renderer -
 * no sandbox, no container. For each section that carries a `chart`, MNEMO-23's
 * `renderChartPng` produces the PNG (written under `/brain/reports/assets/`) and we
 * insert a RELATIVE markdown image reference (`![title](assets/<file>.png)`), so the
 * link resolves from the report at `/brain/reports/<slug>.md` to its sibling assets
 * dir - and one self-contained artifact works across web/email/SMS (PRD §6.4).
 */
import type { AuditEmitter } from "../audit/index.ts";
import { renderChartPng } from "./charts.ts";
import { findingsBlock } from "./findings.ts";
import { serializeFrontMatter } from "./front-matter.ts";
import type {
  BrainFileWriter,
  ChartAsset,
  CodeRunner,
  CtxHandle,
  ReportInput,
} from "./types.ts";

/**
 * Dependencies `buildReportMarkdown` injects. `interp`+`ctx` drive MNEMO-23's
 * chart→PNG render; `writer` is the brain-FS binary writer the PNGs land through;
 * `emitter` is the optional per-run audit emitter (forwarded to `renderChartPng`,
 * which fires `chart.rendered` per PNG). Kept structural so a test injects fakes.
 */
export interface BuildReportDeps {
  /** Persistent Python context runner (MNEMO-23 `CodeInterpreter`). */
  interp: CodeRunner;
  /** The agent's Python context handle (charting already bootstrapped). */
  ctx: CtxHandle;
  /** Brain-FS binary writer the chart PNGs are persisted through (MNEMO-06). */
  writer: BrainFileWriter;
  /** Optional per-run audit emitter (charts emit `chart.rendered`). */
  emitter?: AuditEmitter;
}

/**
 * Assemble the report markdown + its chart assets. The document is
 * `serializeFrontMatter(fm)` followed by a `# title` heading, one `## heading` +
 * body block per section (with an embedded chart image where a section carries
 * one), and a trailing `## Related` block of `[[wikilink]]`s when `related` is
 * supplied. Returns the markdown and the collected {@link ChartAsset}s (path +
 * bytes) for the orchestrator to persist / MNEMO-25 to embed.
 */
export async function buildReportMarkdown(
  input: ReportInput,
  deps: BuildReportDeps,
): Promise<{ markdown: string; assets: ChartAsset[] }> {
  const assets: ChartAsset[] = [];
  const parts: string[] = [
    serializeFrontMatter(input.frontMatter),
    `# ${input.frontMatter.title}`,
  ];

  for (const section of input.sections) {
    parts.push(`## ${section.heading}`, section.body);

    if (section.chart) {
      const { pngBytes, path } = await renderChartPng(
        deps.interp,
        deps.ctx,
        section.chart,
        { writer: deps.writer, emitter: deps.emitter },
      );
      // Reference the PNG by a path RELATIVE to the report (which sits in
      // /brain/reports/), so the asset resolves to /brain/reports/assets/<file>.
      const file = basename(path);
      parts.push(`![${section.chart.title}](assets/${file})`);
      assets.push({ path, bytes: pngBytes, title: section.chart.title });
    }
  }

  if (input.related && input.related.length > 0) {
    parts.push("## Related");
    parts.push(input.related.map((name) => `- [[${name}]]`).join("\n"));
  }

  // MNEMO-26: embed the structured findings as a fenced JSON block so the NEXT
  // scheduled run can diff against this report (the round-trip diff baseline). It
  // lands LAST, after the prose + Related, so it never disturbs the human-readable
  // body; `parseFindingsBlock` reads it back deterministically.
  if (input.findings) {
    parts.push("## Findings Data");
    parts.push(
      "<!-- MNEMO-26: machine-readable findings; the next report diffs against these. -->",
    );
    parts.push(findingsBlock(input.findings));
  }

  // Front matter already ends in a newline; join the rest with blank lines so the
  // body reads as well-formed markdown.
  const [front, ...body] = parts;
  const markdown = `${front}\n${body.join("\n\n")}\n`;
  return { markdown, assets };
}

/** The final path segment (filename) of an absolute brain-FS path. */
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}
