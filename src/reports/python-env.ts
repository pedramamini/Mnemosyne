/**
 * One-time per-context Python charting bootstrap (MNEMO-23).
 *
 * The sandbox container is **headless** - there is no display - so matplotlib MUST
 * use the `Agg` non-interactive backend; any interactive backend would fail to
 * import or hang. We also pin a fixed default figure size + DPI and a neutral
 * style so a given {@link import("./types.ts").ChartSpec} renders to byte-identical
 * PNGs run-to-run: that determinism is what the MNEMO-26 report delta/diff work
 * relies on (a chart that only changed because of a backend default is noise).
 *
 * `ensureCharting` / `ensureSvg` are **idempotent**: each is safe to call before
 * every render. They are gated by a per-context flag (the context's stable `id`),
 * so the bootstrap snippet runs at most once per Python context per worker - after
 * that they are a cheap no-op and the warm context keeps the imports loaded.
 */
import type { CodeRunner, CtxHandle } from "./types.ts";

/** Contexts whose charting bootstrap has already run (keyed by `CtxHandle.id`). */
const chartingReady = new Set<string>();
/** Contexts whose SVG-rasterizer bootstrap has already run. */
const svgReady = new Set<string>();

/**
 * The Python that pins matplotlib to `Agg` + a deterministic style. Idempotent in
 * Python too (re-running it just re-applies the same rcParams), so the JS-side
 * flag is purely an optimization, not a correctness crutch. `matplotlib.use("Agg")`
 * is set BEFORE `pyplot` is imported (the backend can only be chosen pre-import).
 */
const CHARTING_BOOTSTRAP = `
import matplotlib
matplotlib.use("Agg")  # headless sandbox: no display, non-interactive backend
import matplotlib.pyplot as plt
import numpy as np  # noqa: F401  (commonly used by chart code)
import pandas as pd  # noqa: F401
# Deterministic defaults so the same spec yields the same PNG bytes (MNEMO-26 diffs).
matplotlib.rcParams["figure.figsize"] = (8, 4.5)
matplotlib.rcParams["figure.dpi"] = 100
matplotlib.rcParams["savefig.dpi"] = 100
matplotlib.rcParams["figure.autolayout"] = True
plt.style.use("seaborn-v0_8-whitegrid") if "seaborn-v0_8-whitegrid" in plt.style.available else plt.style.use("default")
`.trim();

/**
 * The Python that ensures an SVG→PNG rasterizer is importable. Prefers `cairosvg`
 * (fast, accurate); the actual rasterization + fallback lives in
 * {@link import("./charts.ts").buildSvgToPngCode}. Here we only fail loud early if
 * NO rasterizer is available, so `svgToPng` can give a clear error instead of a
 * cryptic NameError mid-render.
 */
const SVG_BOOTSTRAP = `
try:
    import cairosvg  # noqa: F401
    _MNEMO_SVG_BACKEND = "cairosvg"
except Exception:
    try:
        import svglib  # noqa: F401
        import reportlab  # noqa: F401
        _MNEMO_SVG_BACKEND = "svglib"
    except Exception as _e:
        raise RuntimeError("no SVG rasterizer available (need cairosvg or svglib+reportlab)") from _e
`.trim();

/**
 * Ensure the charting deps (matplotlib@Agg, numpy, pandas) are imported and the
 * deterministic style is set in `ctx`. No-op after the first successful call per
 * context. Throws if the bootstrap cell itself errors (a broken charting env is a
 * hard failure - there is nothing to render into).
 */
export async function ensureCharting(
  interp: CodeRunner,
  ctx: CtxHandle,
): Promise<void> {
  if (chartingReady.has(ctx.id)) return;
  const res = await interp.runCode(ctx, CHARTING_BOOTSTRAP);
  if (res.error) {
    throw new Error(
      `charting bootstrap failed: ${res.error.name}: ${res.error.message}`,
    );
  }
  chartingReady.add(ctx.id);
}

/**
 * Ensure an SVG rasterizer is importable in `ctx`. No-op after the first
 * successful call per context. Throws if neither cairosvg nor svglib is present.
 */
export async function ensureSvg(
  interp: CodeRunner,
  ctx: CtxHandle,
): Promise<void> {
  if (svgReady.has(ctx.id)) return;
  const res = await interp.runCode(ctx, SVG_BOOTSTRAP);
  if (res.error) {
    throw new Error(
      `svg bootstrap failed: ${res.error.name}: ${res.error.message}`,
    );
  }
  svgReady.add(ctx.id);
}

/**
 * Clear the per-context readiness flags. TEST-ONLY: lets a unit test assert the
 * idempotency gate without leaking state across cases (the flags are module-level
 * so the warm worker amortizes the bootstrap in production).
 */
export function __resetPythonEnvForTest(): void {
  chartingReady.clear();
  svgReady.clear();
}
