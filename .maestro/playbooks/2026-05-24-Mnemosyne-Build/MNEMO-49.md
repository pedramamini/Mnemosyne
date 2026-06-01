# MNEMO-49 — SaaS: Billing, metering & cost/concurrency enforcement

Phase 49 (see `MNEMO-00-ROADMAP.md`). This document builds the entire `src/billing/` subsystem in one pass:
**subscription tiers**, the **premium messaging add-on**, **usage metering** (the append-only ledger of
sandbox-second / LLM-token / message consumption), and the **enforcement** that makes the tiers real —
per-user **cost caps** and **concurrency limits**. Depends on MNEMO-05 (accounts + agent registry),
MNEMO-06 (sandbox lifecycle — where spin-up is gated), MNEMO-13 (LLM resolver — the token signal + BYOK
gating), MNEMO-15 (the loop that drives both), and MNEMO-27 (scheduled runs are billable too). Per
`docs/PRD.md` v0.6 §3 (public multi-tenant SaaS: billing + per-user cost caps in scope), §8.4 (per-agent
container cost is the top risk → caps + concurrency are the necessary guard), §9.2 (messaging is a paid
per-agent add-on).

Conventions: billing lives in `src/billing/`. Subscription + usage state is relational → D1 (new numbered
migrations). **Tiers are declarative config in code** (`tiers.ts`, the single source of truth — limits read,
never hard-coded at call sites). The metering ledger is **append-only**, unit-normalized to cents. The PSP
is abstracted behind a `BillingProvider` interface with a deterministic **fake** for tests/dev — no live
PSP calls in tests. Enforcement is a thin **gate module** consulted by the sandbox + LLM call sites:
**fail-closed on cost cap, fail-open on unknown error** (a metering glitch must never silently brick paid
users — a deliberate, commented trade-off). Caps are enforced at the **account** level. Separate code /
tests / test-runs.

- [x] Create `migrations/0010_billing.sql`: `subscriptions` (`id` PK, `account_id` FK→accounts, `tier` default `free`, `status` default `active` ∈ active/past_due/canceled, `provider` default `stripe`, `provider_customer_id`, `provider_subscription_id`, `current_period_end`, `created_at`, `updated_at`, unique index on `account_id`); `addons` (`id` PK, `account_id` FK, `agent_id` nullable FK→agents, `kind` e.g. `'messaging'`, `status` default `active`, `created_at`, unique index `(account_id, agent_id, kind)`). Comment: messaging add-on (§9.2) is per-agent, hence nullable `agent_id`.

- [x] Create `migrations/0011_usage.sql`: append-only `usage_events` (`id` PK, `account_id` FK, `agent_id` nullable FK, `kind` ∈ `sandbox_sec`/`llm_tokens`/`sms_segment`/`report`, `quantity REAL`, `unit TEXT`, `cost_cents REAL` (normalized estimate), `period TEXT` (`YYYY-MM`), `session_id TEXT`, `created_at`). Indexes on `(account_id, period)`, `(agent_id, period)`, `(account_id, kind, period)`. Comment: single source of truth for per-period consumption.

- [x] Run `wrangler d1 migrations apply mnemosyne --local`; verify `0010` + `0011` apply cleanly; report output.

- [x] Create `src/billing/tiers.ts`: `type TierId = "free" | "pro" | "scale"` + `TIERS` mapping each to `{ id, label, priceCentsMonthly, monthlyCostCapCents, maxConcurrentSandboxes, includedLlmModel: "free"|"byok", messagingAddonEligible, maxAgents }`. Free = low cap, 1 concurrent sandbox, free Qwen3, no messaging; Pro/Scale = higher caps + concurrency + BYOK + messaging-eligible (sensible round numbers; cite §8.4). `getTier(id)` with `free` fallback. Single source of truth other phases import — no limits hard-coded elsewhere.

- [x] Create `src/billing/provider.ts`: `interface BillingProvider { createCheckout; cancelSubscription; handleWebhook }` + a `BillingEvent` type (`subscription.activated|canceled|past_due` with `accountId`, `tier`, provider ids, `currentPeriodEnd`). Ship a deterministic `FakeBillingProvider` (no network — tests + `wrangler dev`) and a `StripeBillingProvider` stub reading the secret from env (live calls as marked TODOs with Stripe endpoints noted). `getBillingProvider(env)` selects fake unless `STRIPE_SECRET_KEY` present. Add `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` to `Env` (commented as `wrangler secret put`).

- [x] Create `src/billing/subscriptions.ts`: typed D1 access + lifecycle over `subscriptions`/`addons` (Zod rows). `getSubscription(env, accountId)` (row or synthesized `free` default), `ensureFreeSubscription` (idempotent — called on account creation), `applyBillingEvent(env, event)` (upsert tier/status/period), `addMessagingAddon`/`removeMessagingAddon`/`hasMessagingAddon(env, accountId, agentId)`. No PSP calls. Wire `ensureFreeSubscription` into the MNEMO-03 account-creation path (magic-link callback) with a `// MNEMO-49` comment.

- [x] Create `src/billing/meter.ts`: metering writer + aggregator over `usage_events`. `recordUsage(env, { accountId, agentId?, kind, quantity, unit, sessionId? })` computes `cost_cents` from a `UNIT_COSTS` table (sandbox-second, per-1k-LLM-token, per-SMS-segment, per-report — seed from §8.4/§8.5/§9.2, comment each source), stamps `period` (`YYYY-MM`), appends a row; `getUsageSummary(env, accountId, period?)` → `{ totalCents, byKind }`. Pure D1 + arithmetic — **no enforcement**.

- [x] Create `src/billing/limits.ts`: the admission gate. `type AdmissionResult = { allowed; reason?: "cost_cap"|"concurrency"|"tier_feature"; detail? }`; `checkCostCap(env, accountId)` (tier via `getSubscription`→`getTier`, current-period `getUsageSummary().totalCents` vs `monthlyCostCapCents`, with headroom buffer); `checkConcurrency(env, accountId)` (live sandbox count vs `maxConcurrentSandboxes`); `checkTierFeature(env, accountId, feature)` (`"byok"`/`"messaging"`); composite `admitSandboxRun(env, accountId)`. Header comment: **fail-closed on cap, fail-open on unknown error** (§8.4).

- [x] Create `src/billing/concurrency.ts`: per-account sandbox-slot leasing in KV (add `[[kv_namespaces]]` `LIMITS` to `wrangler.toml` with `# wrangler kv namespace create LIMITS`; `LIMITS: KVNamespace` to `Env`). `acquireSandboxSlot(env, accountId, maxConcurrent)` → `{ leased, leaseId? }` (atomic read, reject if at/over max, else store `lease:<accountId>:<leaseId>` with a ~30min TTL safety expiry); `releaseSandboxSlot`; `countActiveSlots`. Comment: KV is eventually-consistent → a soft cost bound, not a security boundary.

- [x] Wire the gate into sandbox spin-up (MNEMO-06 provisioning path): before booting, `admitSandboxRun(env, accountId)`; if not allowed, do NOT boot — return the `AdmissionResult` to the caller. On boot, `acquireSandboxSlot` + stash `leaseId` on the warm-sandbox handle; release on idle-down/teardown. `recordUsage({ kind:"sandbox_sec", ... })` when the sandbox stops. `// MNEMO-49 enforcement` at each hook.

- [x] Wire the gate into LLM calls (MNEMO-15 loop / MNEMO-13 `getModel()`): before invoking the model, `checkCostCap`; if over cap, abort the turn with a typed user-facing "monthly cost cap reached" rather than calling the model. After each response, `recordUsage({ kind:"llm_tokens", quantity: <prompt+completion>, ... })` (AI SDK surfaces usage). Gate BYOK resolution on `checkTierFeature(env, accountId, "byok")`. Surface the abort to the audit log (MNEMO-21) as `error`/`narration` so the user sees why.

- [x] Create `src/billing/routes.ts` (mounted from `src/index.ts`, `requireAuth`, account-scoped): `GET /billing/subscription` (subscription + tier limits); `GET /billing/usage` (current-period summary + `monthlyCostCapCents` for the UI bar); `POST /billing/checkout` (`{ tier }` → provider checkout URL); `POST /billing/cancel`; `POST /billing/addon/messaging` (`{ agentId, enable }` → add/remove, **gated on `messagingAddonEligible`**); `GET /billing/limits` (tier limits, spend vs cap, concurrency vs max, derived `{ canRunNow, reason? }` from `admitSandboxRun`); and an **unauthenticated** `POST /billing/webhook` that verifies the provider signature and routes the parsed `BillingEvent` through `applyBillingEvent`.

- [x] Create `test/billing-meter.test.ts` (D1): `recordUsage` appends rows with correct `cost_cents` per `kind` (assert against `UNIT_COSTS`), `period` stamps `YYYY-MM`, `getUsageSummary` aggregates `totalCents` + per-kind across events and isolates by `account_id`+`period`.

- [x] Create `test/billing-subscriptions.test.ts` (D1): `ensureFreeSubscription` idempotent (twice → one `free` row), `getSubscription` defaults to `free`, `applyBillingEvent` upserts from `FakeBillingProvider` activated (→ `pro`/`active`) + canceled (→ `canceled`), messaging add-on round-trips and is rejected when tier `messagingAddonEligible:false`.

- [x] Create `test/billing-limits.test.ts` (D1 + KV): with seeded `usage_events` — `checkCostCap` allows under cap, denies (`reason:"cost_cap"`) at/over; a `pro` account's higher cap allows the same spend; `acquireSandboxSlot` leases to `maxConcurrent` then denies, succeeds after release; `countActiveSlots` reflects leases; `admitSandboxRun` composes both with the right `reason`.

- [x] Create `test/billing-enforcement-integration.test.ts` (DO + D1 + KV, sandbox + model mocked): an over-cap account → sandbox NOT booted, model NOT called, run returns `cost_cap` admission failure + audit `error`/`narration`. A within-budget run → sandbox boots, slot leased then released, `usage_events` rows for `sandbox_sec` + `llm_tokens` recorded.

- [x] Run `npm run test`, `npm run typecheck`, `npm run lint`; run `wrangler d1 migrations apply mnemosyne --local` (confirm `0010`/`0011` clean); fix until all pass and report output. Update `AGENTS.md`: `src/billing/` — tiers declarative in `tiers.ts`, append-only `usage_events` ledger, PSP behind `BillingProvider` (+ `FakeBillingProvider`), enforcement in `limits.ts`+`concurrency.ts` wired into sandbox (MNEMO-06) + LLM (MNEMO-13/15) paths, fail-closed on cap / fail-open on unknown error (§8.4).

---

## Completion notes (MNEMO-49)

Entire `src/billing/` subsystem built in one pass. Verification: **434/434 tests pass** (incl. 14 new
billing tests), `tsc --noEmit` clean, `biome check .` clean, both migrations apply clean
(`No migrations to apply!` on the second run).

- **`migrations/0010_billing.sql`** — `subscriptions` (unique `account_id`, `status` CHECK
  active/past_due/canceled) + `addons` (nullable `agent_id` for the per-agent messaging add-on, unique
  `(account_id, agent_id, kind)`).
- **`migrations/0011_usage.sql`** — append-only `usage_events` (`kind` CHECK, `quantity`/`cost_cents`
  REAL, `period`, `session_id`) + the three rollup indexes.
- **`tiers.ts`** — `TierId`/`Tier`/`TIERS`/`getTier` (free fallback). free=200¢ cap/1 sandbox/free
  model/no messaging; pro=5000¢/3/byok/messaging; scale=25000¢/10/byok/messaging (§8.4).
- **`provider.ts`** — `BillingProvider` + `BillingEvent` + `FakeBillingProvider` (no network) +
  `StripeBillingProvider` stub (TODOs w/ endpoints); `getBillingProvider(env)`. Added
  `STRIPE_SECRET_KEY?`/`STRIPE_WEBHOOK_SECRET?` to `Env`.
- **`subscriptions.ts`** — Zod rows + `getSubscription` (free default), `ensureFreeSubscription`
  (idempotent; **wired into the MNEMO-03 magic-link callback**), `applyBillingEvent` (sole tier/status
  writer), messaging add-on add/remove/has.
- **`meter.ts`** — `recordUsage` (prices via `UNIT_COSTS`, stamps `YYYY-MM`, appends), `getUsageSummary`
  (`{ totalCents, byKind }`); pure accounting, no enforcement. Distinct from MNEMO-14's `llm_spend`.
- **`limits.ts`** — `AdmissionResult` + `checkCostCap` (w/ `COST_CAP_HEADROOM_CENTS=25`),
  `checkConcurrency`, `checkTierFeature`, `admitSandboxRun` (fail-closed on cap / fail-open on unknown).
- **`concurrency.ts`** — KV slot leasing (`acquireSandboxSlot`/`releaseSandboxSlot`/`countActiveSlots`,
  30-min TTL); added `LIMITS` KV to `Env` + `wrangler.toml`.
- **Sandbox wiring** — `warmSandbox` leases a slot + stamps boot time on a cold boot;
  `onSandboxIdle`→`meterAndReleaseSandbox` releases the slot + meters `sandbox_sec` on teardown.
- **LLM wiring** — `runHeadless` runs `admitSandboxRun` before booting/calling the model (concurrency
  gated only on a cold boot, so an agent's own warm slot can't block its own re-run); `onChatMessage`
  gates on the cost cap and streams a user-facing "cap reached" message; `resolveModel` forces the free
  default when the tier lacks BYOK (`getModel(..., { forceFree })`); every turn meters `llm_tokens`.
- **`routes.ts`** — mounted from `src/index.ts`: `GET /billing/{subscription,usage,limits}`, `POST
  /billing/{checkout,cancel}`, `POST /billing/addon/messaging` (gated), public `POST /billing/webhook`.
- **Tests** — `billing-meter`, `billing-subscriptions`, `billing-limits`,
  `billing-enforcement-integration` (all green).
- **`AGENTS.md`** — repo-layout `src/billing/` entry + full subsystem prose note added.
