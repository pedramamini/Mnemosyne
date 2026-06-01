# Mnemosyne Build — Phase Roadmap (MNEMO)

> Master index for the ~50-phase build. **This file has no `- [ ]` tasks on purpose** — the Auto Run
> engine skips it. It exists so the phase sequence can be reviewed/resequenced before each phase doc is
> expanded into tasks. Source of truth for scope/decisions: `docs/PRD.md` (v0.6).
>
> **Execution model:** one phase = one Auto Run doc = one fresh context, run one at a time. Each doc is
> self-contained; tasks carry their own file paths + rationale. Run a phase with:
> `maestro-cli auto-run .maestro/playbooks/2026-05-24-Mnemosyne-Build/MNEMO-01.md --launch --agent <id>`
>
> **Authoring status:** COMPLETE — all phases authored. **50 phase docs** (MNEMO-01–50, one doc per phase;
> each doc is a self-contained subsystem an agent builds end-to-end in a single fresh context), totalling
> **~480 executable `- [ ]` tasks** (incl. the up-front design-system phase + a reuse-contract task on every
> frontend feature doc). Run in order, one doc per fresh context. A few docs leave `// TODO(MNEMO-XX)` seams
> so each phase runs independently before its dependency lands; reconcile those when the dependency phase runs.

## Sequencing principle
Land the core first — **memory + research + scheduled reporting + audit log + brain explorer** — which is
independently complete and defensible. Layer messaging, collaboration, and SaaS hardening after. Tracks are
roughly sequential; within a track, later phases depend on earlier ones. Frontend (Track G) can begin once
its backing API exists (depends on B–F).

---

## Track A — Foundation (01–05)
- **MNEMO-01** — Repo scaffold: Worker + Hono + Zod, TS/ESM, `wrangler.toml`, test harness (vitest), lint/typecheck, `/health`.
- **MNEMO-02** — D1 schema + migrations: accounts, agents registry, report metadata, messaging tables (schema only, used later).
- **MNEMO-03** — Magic-link auth: Resend email, KV sessions, request/callback/logout routes, auth middleware.
- **MNEMO-04** — Per-agent Durable Object skeleton: `AIChatAgent` base, `idFromName(agentId)` routing, DO SQLite init.
- **MNEMO-05** — Agent registry CRUD API: create/list/get/update agents (Hono + Zod), wired to DO + D1.

## Track B — Sandbox & Brain (06–12)
- **MNEMO-06** — Sandbox provisioning: per-agent Cloudflare Sandbox, `exec`/`readFile`/`writeFile` wrappers, warm/idle lifecycle, R2 persistence.
- **MNEMO-07** — Brain filesystem layout + `git init` in `/brain` + auto-commit helper.
- **MNEMO-08** — `[[wikilink]]` parser + neuron/synapse graph index in DO SQLite.
- **MNEMO-09** — Graph retrieval tool: traversal queries + search + brain-size metric.
- **MNEMO-10** — Memory write/append API + consolidation pass (versioned + diffed before commit).
- **MNEMO-11** — Brain explorer backend: list/read/write/delete files + archive (zip/tar) download.
- **MNEMO-12** — Brain versioning backend: git history, per-file diff, restore endpoints.

## Track C — Harness & Tools (13–19)
- **MNEMO-13** — LLM provider resolver `getModel()`: Workers AI Qwen3 default + per-user BYOK profile.
- **MNEMO-14** — AI Gateway: routing, request logging, per-user spend caps, secret custody.
- **MNEMO-15** — Agent loop: `streamText`/`generateText` in DO, `stopWhen`, high step budget, message persistence.
- **MNEMO-16** — Tool framework: Zod-typed registry, `execute`→sandbox, large-output-to-FS-path pattern.
- **MNEMO-17** — Web research tools: search + fetch with `BLOCKED_HOSTS`, 15s timeout, 200KB cap.
- **MNEMO-18** — Terminator tool + final-report schema (deliberate exit).
- **MNEMO-19** — Self-authored tools: persist to `/brain/tools/`, register, re-run across sessions.

## Track D — Audit Log / "glass cockpit" (20–22)
- **MNEMO-20** — Wire the existing `src/audit` spike into an `AuditLog` DO + SSE wrapper in the worker runtime.
- **MNEMO-21** — Audit event emission across the loop (session/source/memory/tool/report/chart/narration/error).
- **MNEMO-22** — Audit API: SSE stream (`sinceSeq`), filter (type/level/session/time), FTS search; altitude levels.

## Track E — Reporting & Scheduling (23–28)
- **MNEMO-23** — Code Interpreter integration: persistent Python contexts, chart→PNG pipeline.
- **MNEMO-24** — Report generation: markdown + Obsidian front matter + embedded PNG.
- **MNEMO-25** — Report archive + storage: R2 blobs, D1 metadata, retrieval.
- **MNEMO-26** — Delta-aware report logic (diff against remembered prior state).
- **MNEMO-27** — Scheduling: DO `this.schedule` timers + Worker `scheduled` cron fan-out + dev trigger route.
- **MNEMO-28** — Email notifications via Resend (report ready/update).

## Track F — Lifecycle: Discovery → Build → Operation (29–31)
- **MNEMO-29** — Discovery flow: clarify-scope conversation + good-enough confidence gate + slot rubric.
- **MNEMO-30** — Build/provisioning flow: FS init, system-prompt assembly, tool enablement, schedule defaults.
- **MNEMO-31** — Entity templates: vendor / product / investor / founder scaffolds.

## Track G — Frontend (32–43)
> **Frontend reuse contract:** every feature phase (33–43) composes the shared component library + design
> tokens from **MNEMO-32** and never builds bespoke controls — enforced by a lint rule (no raw interactive
> HTML outside `components/ui/`). The design system is defined up front (in MNEMO-32) and is token-driven so
> it can be reskinned later by swapping tokens. Each feature doc carries this as its first task.
- **MNEMO-32** — Frontend foundation: scaffold (Vite+React+TS, routing, auth-aware API client) + the design system & shared `components/ui/` library (tokens, catalog, lint-enforced reuse). Built before any feature UI.
- **MNEMO-33** — Auth UI: magic-link request + callback + session handling.
- **MNEMO-34** — Agent list + create wizard (Discovery front end).
- **MNEMO-35** — Conversation UI: threaded chat, streaming, rename/search.
- **MNEMO-36** — Agent detail page: chat / reports / audit / settings / metadata tabs.
- **MNEMO-37** — Glass cockpit UI: audit stream + filters + search + milestone/"show the work" toggle.
- **MNEMO-38** — Brain explorer UI: file tree, view/edit/create/delete, download archive.
- **MNEMO-39** — Brain versioning UI: history, diff viewer, restore.
- **MNEMO-40** — Brain graph map visualization (neurons/synapses).
- **MNEMO-41** — Report viewer + full-text search UI.
- **MNEMO-42** — Agent management/metrics dashboard (list/filter/search, brain-size).
- **MNEMO-43** — Mobile-responsive parity pass.

## Track H — Messaging: SMS via Twilio (44–48) — *paid add-on, later phase*
- **MNEMO-44** — `MessagingChannel` interface + `TwilioSmsChannel` (REST outbound send).
- **MNEMO-45** — Inbound gateway Worker: Twilio signature validation, number→agent routing, normalize.
- **MNEMO-46** — `onInboundMessage` in DO + async reply; SMS persistence (daily session buckets + channel tag) + web rendering.
- **MNEMO-47** — Access control (whitelist/open toggle, capability tiers, group whitelist auto-expand) + number provisioning (Twilio API, opt-in) + A2P 10DLC onboarding.
- **MNEMO-48** — Group threads: thread-coordinator DO, triage gate, floor control, loop prevention, @-mention.

## Track I — SaaS Productionization (49–50)
- **MNEMO-49** — Billing + tiers: subscription, premium messaging add-on, usage metering, per-user cost caps + concurrency limits.
- **MNEMO-50** — Observability, abuse controls, error handling, deploy/release pipeline.
