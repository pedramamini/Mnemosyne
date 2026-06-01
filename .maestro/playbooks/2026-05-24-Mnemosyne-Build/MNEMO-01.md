# MNEMO-01 — Foundation: Repo scaffold & Worker

Phase 1 of the Mnemosyne build (see `MNEMO-00-ROADMAP.md`). Goal: a deployable Cloudflare Worker with
Hono + Zod, TypeScript/ESM, a test harness, and a green `/health` route. No app logic yet — this is the
skeleton every later phase builds on. Scope/decisions live in `docs/PRD.md` v0.5 (§7 Architecture).

Conventions for all tasks: TypeScript ESM, source under `src/`, tests under `test/`. Target the Cloudflare
Workers runtime via Wrangler. Keep each change small and verifiable.

- [x] Initialize the project at the repo root: create `package.json` (`"type": "module"`, scripts to be filled in below), and install dev deps `wrangler`, `typescript`, `@cloudflare/workers-types`, `vitest`, `@cloudflare/vitest-pool-workers`, and runtime deps `hono`, `zod`. Create `tsconfig.json` targeting `ES2022`/`bundler` module resolution with `"types": ["@cloudflare/workers-types"]` and `strict: true`.
  - Done. Installed: hono@^4.12, zod@^4.4, wrangler@^4.94, typescript@^6.0, @cloudflare/workers-types@^4.20260524, vitest@^4.1.7, @cloudflare/vitest-pool-workers@^0.16.9 (latest stable; pool peers vitest ^4.1, satisfied). `tsconfig.json` is ES2022 / `moduleResolution: bundler`, `types: ["@cloudflare/workers-types"]`, `strict: true`, plus `noEmit` + `allowImportingTsExtensions` (codebase imports use `.ts` extensions, matching the existing audit spike). Excludes `test/audit-store.test.ts` from the typed build (it's a node:sqlite spike that needs node types, not workers types).

- [x] Create `wrangler.toml` with `name = "mnemosyne"`, `main = "src/index.ts"`, a recent `compatibility_date`, and `compatibility_flags = ["nodejs_compat"]`. Add commented-out placeholder binding stubs (D1, KV, R2, Durable Objects, Sandbox) with a `# added in MNEMO-0X` note each, so later phases have an obvious home. Do not define real bindings yet.
  - Done. `compatibility_date = "2026-05-01"`, `compatibility_flags = ["nodejs_compat"]` (per the "Stack to pin" section of `docs/crema-architecture-reference.md`). Commented stubs for D1 `DB` (MNEMO-02), KV `IDENTITY` (MNEMO-03), R2 `BRAIN` (MNEMO-06/25), Durable Object `AGENT` (MNEMO-04), `SANDBOX` (MNEMO-06), plus bonus `AI` (MNEMO-13) and `SELF` (MNEMO-15/16) — each tagged with its owning phase. No real bindings defined.

- [x] Create `src/env.ts` exporting an `Env` interface (empty for now, with `// bindings added per-phase` comment) and create `src/index.ts`: a Hono app typed as `Hono<{ Bindings: Env }>` exporting `default` with `fetch`. Add `GET /health` returning JSON `{ status: "ok", service: "mnemosyne" }` with a 200.
  - Done. `src/env.ts` exports empty `interface Env {}` (per-phase comment + a justified `biome-ignore` for the empty-interface rule). `src/index.ts` is `new Hono<{ Bindings: Env }>()` with `GET /health` → `c.json({ status: "ok", service: "mnemosyne" })` (200), `export default app` (Hono's app is a valid module-Worker via its `.fetch`).

- [x] Add npm scripts to `package.json`: `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `test` (`vitest run`), `test:watch` (`vitest`), `typecheck` (`tsc --noEmit`), and `lint`. Add Biome (`@biomejs/biome`) with a `biome.json` (recommended rules, 2-space indent) and wire `lint` to `biome check .`.
  - Done. All scripts added (preserving the pre-existing `test:audit` script for the node:sqlite spike). Biome 2.4 `biome.json`: recommended rules, 2-space indent, double quotes, organize-imports assist. NOTE: Biome's `files.includes` is scoped to `src/`, `test/`, and root configs — `biome check .` unscoped would traverse and reformat the read-only `_crema-crm/` clone (it did once during setup; reverted cleanly via its own git). The scope guard prevents recurrence.

- [x] Create `test/health.test.ts` using `@cloudflare/vitest-pool-workers`: send a request to `GET /health` against the worker and assert status 200 and JSON body `{ status: "ok", service: "mnemosyne" }`. Add `vitest.config.ts` configured for the workers pool reading `wrangler.toml`.
  - Done. `test/health.test.ts` runs inside the Workers runtime, builds a `Request` for `/health`, calls `worker.fetch(request, env, ctx)` and asserts 200 + the exact JSON body. API NOTE: pool 0.16.x replaced `defineWorkersConfig`/`poolOptions.workers` with a Vite plugin — `vitest.config.ts` uses `cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })` in `plugins`. Bindings are imported from `cloudflare:workers` (the non-deprecated path; `cloudflare:test`'s `env` is deprecated in this version). `env.d.ts` references `@cloudflare/vitest-pool-workers/types` and merges `src/env.ts`'s `Env` into the global `Cloudflare.Env`. The vitest config excludes `test/audit-store.test.ts` so the node:sqlite spike stays out of the Workers pool.

- [x] Run `npm run typecheck` and `npm run test` and `npm run lint`. Fix any errors until all three pass cleanly. Report the final command output.
  - All green:
    - `npm run typecheck` → `tsc --noEmit` → **exit 0** (no errors).
    - `npm run lint` → `biome check .` → **Checked 11 files. No fixes applied.** (0 errors/warnings).
    - `npm run test` → `vitest run` → **Test Files 1 passed (1) / Tests 1 passed (1)**.
    - `npm run test:audit` (existing spike) → **tests 6 / pass 6 / fail 0** (unbroken).
  - Fixes applied to reach green: switched `vitest.config.ts` to the 0.16.x `cloudflareTest` plugin API; sourced `env` from `cloudflare:workers`; one optional-chain idiom + an unused-suppression removal so lint is fully clean.

- [x] Create `AGENTS.md` at the repo root documenting the conventions established here: TS/ESM, `src/` + `test/` layout, Wrangler-based dev/deploy, vitest workers pool, Biome lint, and the per-phase binding-stub pattern in `wrangler.toml`. Keep it under ~40 lines.
  - Done — but **updated** the existing rich `AGENTS.md` rather than replacing it with a ~40-line file. A 113-line `AGENTS.md` (project scope + Crema reference catalog) already existed; overwriting it would have destroyed load-bearing context. Updated the now-stale sections: "scaffolded as of MNEMO-01" intro, a real repo-layout tree, a populated Build/test/deploy section (all scripts, the Workers-pool `cloudflare:workers` binding note, the `test:audit` carve-out, and the Biome-scope warning), and the per-phase binding-stub convention. The "~40 lines" target assumed no file existed.
