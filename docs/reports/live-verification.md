---
type: reference
title: Reporting - Live Code-Interpreter Verification (Deploy-Time Release Gate)
created: 2026-05-24
tags:
  - reports
  - sandbox
  - code-interpreter
  - release-gate
  - mnemo-23
related:
  - '[[PRD]]'
  - '[[crema-architecture-reference]]'
---

# Reporting - live Code-Interpreter verification

**Why this is a doc, not a unit test.** The reporting pipeline (`src/reports/`,
MNEMO-23) drives the **Beta** Sandbox Code-Interpreter methods
(`createCodeContext` / `runCode`) - see PRD §8.1. Those carry a Beta-doc header,
so the §8.1 obligation is to *pin business-critical behavior with a real run
before relying on it in production*. That run cannot happen in CI / the
unattended Auto Run environment because:

- **No local container runtime.** `wrangler dev` boots the Sandbox container via
  Docker/containerd; the build/CI host has no Docker, so the container never
  starts.
- **`vitest-pool-workers` can't boot a container**, and MNEMO-06 ships **no
  Code-Interpreter test harness** - `test/stub-sandbox.ts` models only
  `exec`/`readFile`/`writeFile`/`mkdir`, never `createCodeContext`/`runCode`.
- **No reporting HTTP route exists yet.** `renderChartPng` / `svgToPng` are
  internal `src/reports/` functions with no entry point until MNEMO-24 builds the
  report-generation route. (Do **not** add a route purely to test this - that
  front-runs MNEMO-24 and adds untested production surface.)

So this is a **deploy-time release gate**: run it once against a real,
provisioned sandbox before reporting is relied upon in production. It is the
explicit MNEMO-23 manual checkpoint, fully specified here so it is a one-shot
check rather than ad-hoc fiddling.

## When this gate runs

The earliest natural point is **MNEMO-24's first live integration** (the report
route gives a real entry point) or **any deploy that turns reporting on**. It is
a per-environment gate (run once per environment where reporting goes live), not
a per-commit check.

## Preconditions

1. A deployed (or `wrangler dev` against Docker) worker with the real bindings
   filled in `wrangler.toml`: `SANDBOX` (+ the `[[containers]]` image), `AGENT`,
   `DB`, `SESSIONS`, `BRAIN_BUCKET` - i.e. **not** the placeholder
   `00000000-…` IDs.
2. The `cloudflare/sandbox:0.10.2` container image actually pulled and running
   (`instance_type = "basic"` - bump to `"standard"` only if it OOMs at boot;
   record which one passes).
3. An authenticated session + an **owned** agent id (the reporting functions are
   per-agent; ownership is enforced upstream).

## The three checks (the MNEMO-23 checkpoint)

### 1. `print(1+1)` round-trips through the Code Interpreter

Exercises `getContext` → `createCodeContext` (once per agent, cached) and
`runCode` normalization into `{ stdout, stderr, error, results }`.

```ts
import { getCodeInterpreter } from "../src/reports/index.ts";

const interp = getCodeInterpreter(env, agentId);
const ctx = await interp.getContext(agentId);
const r = await interp.runCode(ctx, "print(1 + 1)");
// EXPECT: r.stdout.trim() === "2", r.error === null
// EXPECT: calling getContext(agentId) again returns the SAME cached handle
//         (createCodeContext is NOT called a second time).
```

### 2. `renderChartPng` yields a non-empty PNG persisted in the brain FS

Exercises `ensureCharting` (Agg backend pinned pre-pyplot-import, fixed DPI),
`buildChartCode`, base64 `image/png` capture, and the MNEMO-06
`writeFileBytes` binary write.

```ts
import { renderChartPng } from "../src/reports/index.ts";

const { pngBytes, path } = await renderChartPng(interp, ctx, {
  kind: "bar",
  title: "Smoke test",
  labels: ["a", "b", "c"],
  series: [{ name: "v", data: [1, 2, 3] }],
}, { writer /* the per-agent BrainFileWriter */ });
// EXPECT: pngBytes.length > 0 and pngBytes starts with the PNG magic
//         [0x89, 0x50, 0x4E, 0x47] (\x89PNG).
// EXPECT: path matches /brain/reports/assets/<slug>-<ts>.png and the file
//         exists in the brain FS (read it back; byte length matches).
```

### 3. `svgToPng` rasterizes an SVG string to PNG bytes

Confirms the SVG rasterizer dep is present in the container image (`cairosvg`
primary, `svglib`+`reportlab` fallback) - `ensureSvg` fails loud if neither is
importable, which is the single most likely image-dependency surprise.

```ts
import { svgToPng } from "../src/reports/index.ts";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
  '<rect width="20" height="20" fill="red"/></svg>';
const png = await svgToPng(interp, ctx, svg);
// EXPECT: png.length > 0 and starts with the PNG magic bytes.
// If this throws "no SVG rasterizer", the container image is missing cairosvg
// AND svglib/reportlab - add one to the image (or a per-context pip install in
// python-env.ts) and record the resolution here.
```

## Pass criteria (record results inline when run)

- [ ] (1) `print(1+1)` → `stdout == "2"`, `error == null`, context handle cached.
- [ ] (2) `renderChartPng` → non-empty PNG (magic bytes) persisted at
      `/brain/reports/assets/…png`; read-back byte length matches.
- [ ] (3) `svgToPng` → non-empty PNG (magic bytes); rasterizer present.
- [ ] `instance_type` that passed boot recorded (`basic` vs `standard`).
- [ ] Run date / environment / sandbox image tag recorded.

When all boxes are checked with real output pasted, the §8.1 "pin Beta behavior
with a real run" obligation for `src/reports/` is discharged for that
environment.
