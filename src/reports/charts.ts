/**
 * Chart → PNG pipeline + SVG → PNG rasterization (MNEMO-23).
 *
 * Charts are rendered to **PNG** deliberately (PRD §6.4/§7.3): one artifact embeds
 * everywhere a report is delivered - web, email, AND SMS/MMS - where SVG cannot
 * render. So every path here converges on PNG bytes: `renderChartPng` builds a
 * chart from a {@link ChartSpec} and `svgToPng` rasterizes agent/tool-emitted SVG,
 * both returning the canonical PNG. PNG is the canonical artifact; SVG is only ever
 * an input.
 *
 * The PNG bytes are returned (for embedding) AND written to the brain FS under
 * `/brain/reports/assets/` via the MNEMO-06 binary write wrapper - never inlined
 * into the loop message array (§7.1: large blobs go to the FS, the loop gets a
 * path). The Python snippet generation is kept in pure, sandbox-free helpers
 * (`buildChartCode` / `buildSvgToPngCode`) so it is unit-testable.
 *
 * Injection safety: the {@link ChartSpec} and any SVG are passed into Python as a
 * base64 literal decoded with `base64.b64decode` - never string-interpolated into
 * the snippet - so a model-supplied title or SVG can't break out of the Python.
 */

import type { AuditEmitter } from "../audit/index.ts";
import { REPORT_ASSETS_DIR } from "../memory/layout.ts";
import { emitChartRendered } from "./audit.ts";
import { ensureCharting, ensureSvg } from "./python-env.ts";
import type { BrainFileWriter } from "./types.ts";
import {
  ChartSpec,
  type ChartSpecData,
  type CodeRunner,
  type CtxHandle,
} from "./types.ts";

/** Thrown when a render fails (Python error, or no PNG produced). */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

/** Dependencies `renderChartPng` injects: where to persist + (optional) audit. */
export interface ChartRenderDeps {
  /** Binary-safe brain-FS writer (MNEMO-06 `SandboxClient`). */
  writer: BrainFileWriter;
  /** Per-run audit emitter; optional so the renderer works outside a loop. */
  emitter?: AuditEmitter;
}

/**
 * Render a {@link ChartSpec} to a PNG: build the matplotlib snippet, run it in the
 * agent's persistent Python context, capture the `image/png` rich output, decode
 * to bytes, and persist to `/brain/reports/assets/<slug>-<ts>.png`. Returns the
 * bytes (for embedding) AND the saved path. On a successful render the optional
 * {@link AuditEmitter} receives one `chart.rendered` event (MNEMO-21 seam).
 */
export async function renderChartPng(
  interp: CodeRunner,
  ctx: CtxHandle,
  spec: ChartSpecData,
  deps: ChartRenderDeps,
): Promise<{ pngBytes: Uint8Array; path: string }> {
  // Validate at the boundary so a malformed spec fails clearly BEFORE we run any
  // Python (and so the embedded JSON is exactly the schema shape).
  const valid = ChartSpec.parse(spec);
  await ensureCharting(interp, ctx);

  const res = await interp.runCode(ctx, buildChartCode(valid));
  if (res.error) {
    throw new ReportError(
      `chart render failed: ${res.error.name}: ${res.error.message}`,
    );
  }
  const pngB64 = res.results.find((r) => r.png)?.png;
  if (!pngB64) {
    throw new ReportError("chart render produced no PNG output");
  }

  const pngBytes = base64ToBytes(pngB64);
  const filename = `${slugify(valid.title, "chart")}-${Date.now()}.png`;
  const path = `${REPORT_ASSETS_DIR}/${filename}`;
  // Ensure the assets dir exists (idempotent), then write the binary PNG.
  await deps.writer.mkdir?.(REPORT_ASSETS_DIR);
  await deps.writer.writeFileBytes(path, pngBytes);

  // MNEMO-21 chart.rendered seam - best-effort, injected, swallows its own errors.
  await emitChartRendered(deps.emitter, { title: valid.title, filename, path });

  return { pngBytes, path };
}

/**
 * Rasterize an SVG string to PNG bytes in the sandbox (PRD §6.4 "SVG→PNG"). For
 * charts a tool or the agent emits as SVG; PNG is the canonical embeddable form,
 * so this converges those onto the same PNG path. Dep readiness (cairosvg, else
 * svglib) is handled by {@link ensureSvg} in `python-env.ts`.
 */
export async function svgToPng(
  interp: CodeRunner,
  ctx: CtxHandle,
  svg: string,
): Promise<Uint8Array> {
  await ensureSvg(interp, ctx);
  const res = await interp.runCode(ctx, buildSvgToPngCode(svg));
  if (res.error) {
    throw new ReportError(
      `svg→png failed: ${res.error.name}: ${res.error.message}`,
    );
  }
  const pngB64 = res.results.find((r) => r.png)?.png;
  if (!pngB64) {
    throw new ReportError("svg→png produced no PNG output");
  }
  return base64ToBytes(pngB64);
}

// ─── Pure snippet builders (unit-testable without a sandbox) ──────────────────

/**
 * Build the matplotlib Python for `spec`. PURE: no sandbox, deterministic output,
 * so the snippet is unit-testable. The spec rides in as a base64-encoded JSON
 * literal (injection-safe); the kind selects the plotting call. The figure is
 * saved Agg-style to a `BytesIO` and emitted as an `image/png` rich result via
 * `IPython.display` (works with the headless `Agg` backend, which can't auto-show).
 */
export function buildChartCode(spec: ChartSpecData): string {
  const specB64 = utf8ToBase64(JSON.stringify(spec));
  return [
    "import json, base64, io",
    "from IPython.display import Image, display",
    `_spec = json.loads(base64.b64decode(${q(specB64)}).decode("utf-8"))`,
    '_series = _spec["series"]',
    '_labels = _spec.get("labels")',
    "fig, ax = plt.subplots()",
    plotBody(spec.kind),
    '_title = _spec["title"]',
    "ax.set_title(_title)",
    'if _spec.get("xLabel"): ax.set_xlabel(_spec["xLabel"])',
    'if _spec.get("yLabel"): ax.set_ylabel(_spec["yLabel"])',
    'if _spec["kind"] != "pie" and any(s.get("name") for s in _series): ax.legend()',
    "_buf = io.BytesIO()",
    // Agg-compatible save-to-buffer → base64 PNG rich output:
    'fig.savefig(_buf, format="png", bbox_inches="tight")',
    "plt.close(fig)",
    "_buf.seek(0)",
    'display(Image(data=_buf.getvalue(), format="png"))',
  ].join("\n");
}

/** The kind-specific matplotlib plotting body (reads `_series` / `_labels`). */
function plotBody(kind: ChartSpecData["kind"]): string {
  switch (kind) {
    case "line":
      return [
        "for _s in _series:",
        '    _y = _s["values"]',
        '    _x = _s.get("x") or list(range(len(_y)))',
        '    ax.plot(_x, _y, marker="o", label=_s.get("name"))',
        "if _labels:",
        "    ax.set_xticks(list(range(len(_labels))))",
        "    ax.set_xticklabels(_labels)",
      ].join("\n");
    case "bar":
      return [
        "_n = len(_series)",
        '_m = max(len(s["values"]) for s in _series)',
        "_w = 0.8 / _n",
        "for _i, _s in enumerate(_series):",
        '    _y = _s["values"]',
        "    _pos = [j + _i * _w - 0.4 + _w / 2 for j in range(len(_y))]",
        '    ax.bar(_pos, _y, width=_w, label=_s.get("name"))',
        "if _labels:",
        "    ax.set_xticks(list(range(_m)))",
        "    ax.set_xticklabels(_labels)",
      ].join("\n");
    case "scatter":
      return [
        "for _s in _series:",
        '    _y = _s["values"]',
        '    _x = _s.get("x") or list(range(len(_y)))',
        '    ax.scatter(_x, _y, label=_s.get("name"))',
      ].join("\n");
    case "pie":
      return [
        '_vals = _series[0]["values"]',
        "_pielabels = _labels if _labels else None",
        '_ = ax.pie(_vals, labels=_pielabels, autopct="%1.1f%%")',
        '_ = ax.axis("equal")',
      ].join("\n");
  }
}

/**
 * Build the SVG→PNG rasterization Python. PURE + injection-safe (SVG rides in as a
 * base64 literal). Prefers cairosvg; falls back to svglib+reportlab; emits the PNG
 * as an `image/png` rich result so the caller captures it like a chart.
 */
export function buildSvgToPngCode(svg: string): string {
  const svgB64 = utf8ToBase64(svg);
  return [
    "import base64, io",
    "from IPython.display import Image, display",
    `_svg = base64.b64decode(${q(svgB64)}).decode("utf-8")`,
    "_png = None",
    "try:",
    "    import cairosvg",
    '    _png = cairosvg.svg2png(bytestring=_svg.encode("utf-8"))',
    "except Exception:",
    "    from svglib.svglib import svg2rlg",
    "    from reportlab.graphics import renderPM",
    "    _drawing = svg2rlg(io.StringIO(_svg))",
    "    _b = io.BytesIO()",
    '    renderPM.drawToFile(_drawing, _b, fmt="PNG")',
    "    _png = _b.getvalue()",
    'display(Image(data=_png, format="png"))',
  ].join("\n");
}

// ─── Local helpers ────────────────────────────────────────────────────────────

/** A safe Python string literal for an already-base64 (ASCII-only) value. */
function q(b64: string): string {
  return JSON.stringify(b64);
}

/**
 * Slugify a title into a filename-safe stem (lowercase, dash-separated). Exported
 * so the report generator (MNEMO-24) derives `.md` filenames the SAME way charts
 * derive their PNG filenames - one slug implementation, no drift. `fallback` is
 * used when the title has no slug-able characters.
 */
export function slugify(title: string, fallback = "chart"): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/** UTF-8 string → base64 (for embedding JSON/SVG in a Python literal). */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64 → raw bytes (decoding an `image/png` rich output). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
