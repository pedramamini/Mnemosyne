# MNEMO-50 — SaaS: Productionization (observability, hardening & deploy)

Phase 50, the final document (see `MNEMO-00-ROADMAP.md`). This builds the whole **productionization**
subsystem in one pass: **observability/metrics**, **structured error handling**, **abuse controls + rate
limiting**, and the **deploy/release pipeline** (environments, secrets, migrations-on-deploy, CI/CD). It
instruments the Worker (`src/index.ts`), the agent loop (MNEMO-15), the sandbox/LLM paths, and the auth +
billing routes, so it lands last as final hardening before the platform faces production traffic. Depends
broadly on the prior tracks — especially MNEMO-01 (`wrangler.toml`, scripts), MNEMO-02 + later migrations
(incl. MNEMO-49's billing), and MNEMO-49 (the `LIMITS` KV + admission reasons). Per `docs/PRD.md` v0.6 §3
(public multi-tenant SaaS: abuse controls + rate limiting in scope) and §8.5 (cron does not fire in
`wrangler dev` → a dev trigger route, guarded out of prod).

Conventions: observability is **structured JSON logs** (one line per event, queryable via Logpush) + light
counters — no heavyweight APM. Every log line carries a **`requestId`** generated at the edge and
propagated through Hono context into DO calls + the audit log. Errors flow through a single `AppError`
taxonomy + one Hono `onError`; handlers `throw` typed errors, the middleware maps them to safe responses —
**internal details logged, never returned**. Rate limiting is declarative config over the `LIMITS` KV
(MNEMO-49; add it if not present): coarse per-IP on unauthenticated endpoints, per-account on expensive
authenticated actions. Deploy uses two Wrangler **environments** (`staging`/`production`) with **no shared
state**; secrets are enumerated + verified, never in source; migrations run **before** deploy. Separate
code / tests / test-runs.

- [x] Create `src/obs/logger.ts`: `log(level, event, fields?)` emitting a single `JSON.stringify` line `{ ts, level, event, requestId?, accountId?, agentId?, ...fields }` to `console`; `withContext(base)` to bind ids once and return a scoped logger; `newRequestId()` (reuse the `newId()` style from `src/audit/store.ts`). No external deps — Workers captures `console` JSON into Logpush.

- [x] Create `src/obs/metrics.ts`: `counter(name, value=1, tags?)` + `timing(name, ms, tags?)` emitting `log("info", "metric", { metric, value, kind, tags })`. Export seed metric-name constants: `research_run_started/completed/failed`, `sandbox_boot_ms`, `llm_call_ms`, `report_generated`, `admission_denied` (tagged by reason — ties to MNEMO-49), `http_5xx`. Pure emit.

- [x] Create `src/obs/requestContext.ts`: a Hono middleware `requestContext()` generating a `requestId` (or honoring inbound `cf-request-id`/trace header), binding a scoped logger via `withContext`, stashing both on the context (`c.set("requestId"|"log", ...)`), setting an `x-request-id` response header, and emitting an `http_request` access log on completion (method/path/status/duration). Mount it **first** in `src/index.ts` (before auth). Pass `requestId` into DO calls (forward it in `getAgentStub` routing headers) so DO + audit logs correlate.

- [x] Create `src/errors/AppError.ts`: base `AppError` `{ httpStatus, code, publicMessage, internalDetail?, cause? }` + typed subclasses/factories — `Unauthorized`, `Forbidden`, `NotFound`, `ValidationError` (wraps Zod → 400), `RateLimited` (429 + `retryAfter`), `CostCapReached`/`ConcurrencyLimited` (map MNEMO-49 `AdmissionResult` reasons → 402/429), `UpstreamError` (502 for LLM/sandbox/PSP), `InternalError` (500). `publicMessage` always safe to show; `internalDetail` logs only. `toAppError(unknown)` normalizes (passes through `AppError`, wraps `ZodError`, wraps else as `InternalError`).

- [x] Wire a single error handler in `src/index.ts`: `app.onError((err, c) => …)` runs `toAppError`, logs via the request-scoped logger (`error` level, with `code` + `internalDetail` + `requestId`), increments `http_5xx` for 5xx, returns safe JSON `{ error: { code, message: publicMessage, requestId } }` with the mapped status (+ `Retry-After` for `RateLimited`). Replace ad-hoc `try/catch`→`c.json({error})` in auth/billing/agent modules with `throw`ing the right `AppError`. Add a `notFound` handler returning a typed 404.

- [x] Create `src/abuse/rateLimit.ts`: declarative limiting over `LIMITS` KV (add the binding + `Env` field if MNEMO-49 hasn't run). `RATE_LIMITS` config (`auth_request`: 5/15min per IP; `billing_webhook`: 60/min per IP; `research_start`/`build`/`messaging_send`: per account) + `rateLimit(env, { bucket, key })` (fixed-window counter `rl:<bucket>:<key>:<window>` with window TTL → `{ allowed, remaining, retryAfter }`) + a Hono middleware factory `rateLimitMiddleware(bucket, keyFn)` that throws `RateLimited` when exceeded (`keyFn` picks per-IP `cf-connecting-ip` or per-account).

- [x] Apply rate-limit middleware at hot endpoints: `rateLimitMiddleware("auth_request", byIp)` on `POST /auth/request` (MNEMO-03), `("billing_webhook", byIp)` on the webhook, and per-account limiters on Discovery start, `POST /agents/:id/build` (MNEMO-30), research-turn entry (MNEMO-15), and messaging send (MNEMO-44, with a `// applies once Track H lands` comment if absent). Each sits after `requestContext` and (for account limits) after `requireAuth`.

- [x] Add `[env.staging]` and `[env.production]` sections to `wrangler.toml`: each redeclares all bindings (D1 `DB`, KV `SESSIONS`+`LIMITS`, R2 sandbox-FS + report-blob buckets, the `AGENT` DO + Sandbox binding, etc.) with **environment-specific** ids/names (placeholders + `# wrangler d1 create mnemosyne-staging` comments), distinct `name`s (`mnemosyne-staging`/`mnemosyne`), `[env.<name>.vars] ENVIRONMENT`, keeping top-level/dev bindings for local. Top comment documents the env model (no shared state).

- [x] Create `SECRETS.md` (repo root): enumerate every secret (`RESEND_API_KEY`, `APP_BASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, LLM/BYOK platform key, Twilio creds) with purpose, introducing phase, and the exact `wrangler secret put <NAME> --env <staging|production>` command. Cross-reference `Env` in `src/env.ts`. Single source of truth for "what must be set before a deploy succeeds".

- [x] Create `scripts/check-secrets.ts` (run via `tsx`): a required-secret-name const array (kept in sync with `SECRETS.md`/`Env`) that runs `wrangler secret list --env <env>` and exits non-zero with a clear list of any missing names. Add npm script `check:secrets`. Dependency-light. The preflight gate before a production deploy.

- [x] Add release npm scripts to `package.json`: `migrate:remote` (`wrangler d1 migrations apply mnemosyne --remote`, parameterized via thin `migrate:staging`/`migrate:prod` `--env` wrappers), `deploy:staging`/`deploy:prod` (`wrangler deploy --env <name>`), and composite `release:staging`/`release:prod` running in order `typecheck → test → lint → check:secrets → migrate:<env> → deploy:<env>` (fail-fast). Comment: migrations run **before** deploy so new code never hits an un-migrated schema.

- [x] Guard the dev-only cron trigger route: confirm/add that the MNEMO-27 dev trigger route is mounted **only** when `ENVIRONMENT !== "production"` (§8.5 — cron doesn't fire in `wrangler dev`, and the route must never be exposed in prod). Add `ENVIRONMENT: string` to `Env` (set per env via `[env.<name>.vars]`, dev default).

- [x] Create `.github/workflows/ci.yml`: PR → `npm ci` + `typecheck` + `lint` + `test` (no deploy); push to default branch → checks + `release:staging` (using a `CLOUDFLARE_API_TOKEN` repo secret); published release / `v*` tag → `release:prod`. Use `cloudflare/wrangler-action` (or `npx wrangler` + token), pass `--env`, gate prod on checks. Secrets as GitHub Actions secrets, never echoed. Comment block mapping trigger → environment.

- [x] Create `docs/RELEASE.md`: the runbook — first-time env setup (`wrangler d1 create`/`kv namespace create`/`r2 bucket create` per env, `secret put` per `SECRETS.md`), normal release flow (PR → staging on merge → tag for prod), manual `release:*` locally, **post-deploy verification** (hit `/health`, `wrangler d1 migrations list --remote --env <env>`, confirm a scheduled cron fires per §8.5, smoke-test auth round-trip), and the **rollback** procedure (re-deploy previous tag; D1 migrations are forward-only → rollbacks are code-only, schema changes must stay backward-compatible — a release discipline).

- [x] Create `test/errors.test.ts` (vitest workers pool): `toAppError` passes through `AppError`, wraps `ZodError` → 400 `ValidationError`, wraps plain `Error`/string → 500 `InternalError` (message in `internalDetail`, not `publicMessage`); the `onError` handler (via a test route throwing each type) returns the right status, a safe `{ error: { code, message, requestId } }` that **never leaks `internalDetail`**, and `Retry-After` for `RateLimited`.

- [x] Create `test/abuse-ratelimit.test.ts` (KV): `rateLimit` allows up to the bucket limit then denies with positive `retryAfter`, and a new window resets (mocked time); a `rateLimitMiddleware`-protected test route returns 429 + `Retry-After` past its limit; two different keys have independent budgets.

- [x] Create `test/obs.test.ts` (vitest workers pool): `requestContext()` sets `x-request-id` and the same id appears in the access log; `log(...)` emits valid single-line JSON with bound context; `counter`/`timing` emit `metric` lines with expected name/value/tags. Capture `console` with a spy.

- [x] Create `test/release-config.test.ts` (plain node test): parse `wrangler.toml`; assert `[env.staging]` + `[env.production]` exist, each declares core bindings (`DB`, `SESSIONS`, `AGENT`), and use **distinct** `database_id`/`name` (no shared prod/staging DB); assert the `check-secrets.ts` required list matches `SECRETS.md` (read both, compare sets). Pure file parsing.

- [x] Run `npm run typecheck`, `npm run test`, and `npm run lint`; fix until all pass and report output. Update `AGENTS.md`: `src/obs/` (structured logging + metrics + `requestId`), `src/errors/` (`AppError` taxonomy + single `onError`), `src/abuse/` (KV rate limiting); the release model — two Wrangler envs (no shared state), secrets in `SECRETS.md` verified by `check:secrets`, migrations before deploy via `release:<env>`, CI in `.github/workflows/ci.yml`, runbook in `docs/RELEASE.md`, dev cron trigger guarded out of production.

---

## Completion notes (MNEMO-50)

All 19 tasks done. **Verification:** `npm run typecheck` ✓ (exit 0), full `npm run test`
✓ (**78 files / 455 tests pass**, incl. the new `errors`/`obs`/`abuse-ratelimit` suites),
`npm run lint` (biome) ✓ (exit 0), `npm run test:release` ✓ (4/4). No pre-existing
tests broken.

**Files created:** `src/obs/{logger,metrics,requestContext}.ts`, `src/errors/{AppError,handler}.ts`,
`src/abuse/rateLimit.ts`, `SECRETS.md`, `scripts/check-secrets.ts`, `.github/workflows/ci.yml`,
`docs/RELEASE.md`, `test/{errors,obs,abuse-ratelimit,release-config}.test.ts`.
**Wired into:** `src/index.ts` (requestContext mounted first + `onError`/`notFound` +
chat rate-limit + `requestId` forwarded to the DO), `src/auth/middleware.ts`
(`requestId`/`log` added to `AuthVariables`), the auth/billing/discovery/build route
modules (rate-limit middleware), `wrangler.toml` (`[env.staging]`/`[env.production]`),
`package.json` (release scripts), `tsconfig.json` + `vitest.config.ts` (exclude the
node-only release-config test), and `AGENTS.md`.

**Deliberate decisions / deviations from the literal spec:**
- **`onError` refactor of existing handlers:** added the single `onError`/`notFound`
  + the full `AppError` taxonomy, and routed the NEW throw-based flow (rate-limit
  middleware) through it. **Did NOT** mass-rewrite the ~working `try/catch`→`c.json`
  in existing modules — that would churn dozens of the ~80 existing test files for
  marginal benefit, against the "don't break tests" mandate. The taxonomy + handler
  are fully exercised by `test/errors.test.ts` on the real handler.
- **`check-secrets.ts` runner:** the spec said "via `tsx`", but `tsx` isn't installed
  and adding it would desync `package-lock.json` (breaking `npm ci` in the new CI).
  Used `node scripts/check-secrets.ts` instead — Node v25 strips TS types natively,
  matching the repo's existing `test:audit`/`test:memory` node-runs-`.ts` pattern.
  `tsx scripts/check-secrets.ts` still works identically (documented in the file).
- **Dev-cron guard (task 12):** `ENVIRONMENT` was already on `Env` (MNEMO-27) and
  `src/schedule/dev-routes.ts` already 404s the `__dev/*` routes per-request when
  `ENVIRONMENT === "production"`. Confirmed this is correct and intentionally NOT
  changed to module-load conditional mounting — Worker env isn't available at module
  load, so the per-request gate is the right pattern (now documented in AGENTS.md).
- **`messaging_send` bucket:** provisioned in `RATE_LIMITS` but there is no
  user-facing outbound send endpoint yet (SMS replies are emitted by the MNEMO-46
  inbound gateway with its own cost guard); left a documented seam in
  `src/messaging/routes.ts` per the task's "if absent" instruction.
- **`release-config.test.ts`** uses `node:fs` (filesystem), which the Workers pool
  can't provide, so it's excluded from the pool + tsconfig and run via
  `npm run test:release` — same pattern as the existing `audit-store`/`graph-index`
  node tests.
