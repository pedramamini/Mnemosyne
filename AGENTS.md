# AGENTS.md - Mnemosyne

Guidance for AI coding agents working in this repository. Keep this file current as the
project takes shape.

## What this is

Mnemosyne is a **greenfield Cloudflare-edge agentic application**: a self-serve web platform that
packages AI **research agents** for non-technical users. A user describes what to research; the
platform stands up a persistent agent that researches the web, **remembers across runs**, and emails
scheduled markdown reports (Obsidian front matter). Today these agents are hand-built in Maestro
with per-entity templates (vendor / product / investor / founder); Mnemosyne productizes that.

**Memory is the thesis** - each agent owns a persistent Linux filesystem that is its brain (files =
"neurons," links = "synapses"). This is the long-term-memory gap Crema explicitly punts on.

**Read `docs/PRD.md` first** - it is the source of truth for scope, requirements, the
Discovery → Build → Operation lifecycle, the feasibility assessment, and the open decisions (§9).
The Worker skeleton is scaffolded as of MNEMO-01 (Hono + Zod, TS/ESM, vitest, Biome, `/health`);
application logic lands phase-by-phase per `.maestro/playbooks/2026-05-24-Mnemosyne-Build/`.

**Do not infer the product scope from the Crema clone.** Crema is a CRM; Mnemosyne is not - it is a
parts donor for architecture only (see below).

## Relationship to Crema-CRM

`_crema-crm/` is a **read-only reference clone** (https://github.com/Crema-Sales/Crema-CRM), a
**parts donor** for architecture only. We lift its domain-agnostic agent-hosting mechanics; we do
**not** port the CRM domain (customers/leads/tickets, OSINT/gift research, sales personas).

- **Read** `docs/crema-architecture-reference.md` first - it catalogs the 12 reusable components
  (per-entity DO, the `AIChatAgent`+`streamText` engine, auth-through-hibernation, provider
  abstraction, one-catalog-two-transports tools, terminator-tool-as-schema, background sub-agent,
  scheduling, WS bridge, SSE fan-out, prompt layering, safety rails) with source-file pointers.
- Treat `_crema-crm/` as a museum: read it, cite it, **do not edit it** and do not let it ship as
  part of Mnemosyne (gitignore it once the real project is scaffolded).

## Intended stack (from the reference, subject to change)

- **Runtime:** Cloudflare Workers + Durable Objects (SQLite-backed), `nodejs_compat`.
- **Agent framework:** `agents` + `@cloudflare/ai-chat` (the `AIChatAgent` base), Vercel `ai` SDK
  for the tool-calling loop (`streamText` / `generateText` + `stopWhen`).
- **LLM:** OpenRouter (Claude) via Cloudflare AI Gateway, Workers AI as a zero-secret fallback,
  behind one `getModel(env)` provider-abstraction function.
- **Tools surface:** one Zod-typed tool catalog, exposed to both an in-app chat path and an MCP
  server (`McpAgent`).
- **Agent filesystem / memory:** **Cloudflare Sandboxes** (GA April 2026) - an isolated Linux
  container per agent providing real shell tooling (`find`/`grep`/`sed`/`awk`), the ability to write
  and run custom tools, and `readFile`/`writeFile`, persisted to **R2** across sleeps. This is the FS
  layer plain Workers/DOs cannot provide. Lean toward ephemeral sandbox-per-session over an always-on
  container per agent (cost - see PRD §8.4).
- **Storage:** D1 + KV. Plus DO storage for per-instance state; R2 for sandbox FS + report blobs.
- **Email:** Resend (magic-link auth + report notifications).
- **API:** Hono + Zod (OpenAPI). Validation via Zod 4.
- **Language:** TypeScript, ESM.

Pin versions per the reference doc's "Stack to pin" section when scaffolding.

## Repo layout (current)

```
.
├── AGENTS.md                              # this file
├── SECRETS.md                             # single source of truth: every Wrangler secret + put commands (MNEMO-50)
├── package.json                           # ESM ("type": "module"); see scripts below
├── tsconfig.json                          # ES2022, bundler resolution, strict, noEmit
├── wrangler.toml                          # Worker name/main/compat + bindings + [env.staging]/[env.production] (MNEMO-50)
├── biome.json                             # format + lint (scoped to src/, test/, root configs)
├── vitest.config.ts                       # Workers pool via cloudflareTest(); injects TEST_MIGRATIONS
├── env.d.ts                               # merges src/env.ts Env into Cloudflare.Env; types TEST_MIGRATIONS
├── scripts/check-secrets.ts               # preflight: wrangler secret list vs REQUIRED_SECRETS (MNEMO-50)
├── .github/workflows/ci.yml               # PR=checks; main=release:staging; release/tag=release:prod (MNEMO-50)
├── migrations/                            # D1 SQL migrations (0001_accounts … 0007_a2p_10dlc)
├── src/
│   ├── index.ts                           # Hono entry; /health, auth, /agents/:id/* + DO re-export
│   ├── env.ts                             # Env bindings interface (DB/SESSIONS/AGENT; grown per-phase)
│   ├── agent/                             # per-agent DO "home": MnemosyneAgent + sql.ts + types.ts; discovery/ = lifecycle Discovery stage (MNEMO-29); build/ = lifecycle Build stage (MNEMO-30)
│   ├── sandbox/                           # Sandbox SDK boundary: client.ts + persistence.ts + lifecycle.ts (MNEMO-06)
│   ├── memory/                            # brain FS layout + git versioning (MNEMO-07) + graph index (MNEMO-08) + write pipeline (MNEMO-10) + explorer/archive (MNEMO-11) + history/diff/restore (MNEMO-12)
│   ├── tools/                             # Zod-typed sandbox-driving tool registry + large-output-to-FS-path rule (MNEMO-16)
│   ├── reports/                           # Code Interpreter wrapper (interpreter.ts) + chart→PNG pipeline (charts.ts, python-env.ts, types.ts) (MNEMO-23) + Obsidian-front-matter report generation (front-matter.ts, markdown.ts, generate.ts) (MNEMO-24) + R2 archive + retrieval (archive.ts, routes.ts) (MNEMO-25) + delta-aware reporting (findings.ts, delta.ts, delta-report.ts) (MNEMO-26) + audit-emit seams (audit.ts, MNEMO-21)
│   ├── email/                             # Resend transport: magic-link send (resend.ts, MNEMO-03) + report-ready/update owner notification (report-notify.ts, MNEMO-28)
│   ├── db/index.ts                        # typed D1 access layer (Zod row schemas + CRUD helpers)
│   ├── audit/                             # AuditLog DO (AuditLog.ts) + DoSqlDriver + SSE wrapper (MNEMO-20) + AuditEmitter facade + getAuditStub (emitter.ts, MNEMO-21) over the untouched store.ts/types.ts spike
│   ├── schedule/                          # DO this.schedule per-agent timers + Worker scheduled cron fan-out + prod-gated __dev/cron trigger route (types.ts/fanout.ts/dev-routes.ts, MNEMO-27)
│   ├── messaging/                         # messaging channel seam: MessagingChannel interface (provider-agnostic) + TwilioSmsChannel (only impl) + types.ts + segmentation.ts + twilioSignature.ts (MNEMO-44) + inbound gateway/normalize.ts (MNEMO-45) + persistence.ts (counterparty-keyed transcript, daily bucketing) + reply.ts (async SMS reply + cost guard) + routes.ts (web-rendering read API) (MNEMO-46) + access.ts/tiers.ts (whitelist + capability tiers, the real §9.6 safety boundary) + accessRoutes.ts + provisioning.ts/a2p.ts (number provisioning + shared A2P 10DLC) + manageRoutes.ts (enable/status/disable + /api/a2p) + twilioRest.ts (shared Basic-auth) (MNEMO-47) + ThreadCoordinator.ts (per-group-thread DO orchestrator) + groupTypes.ts + mentions.ts + loopPrevention.ts + triage.ts (cheap Haiku gate) (MNEMO-48 group threads) (paid add-on / Track H)
│   ├── billing/                           # SaaS billing/metering/enforcement: tiers.ts (declarative tier limits, single source of truth) + provider.ts (BillingProvider seam + FakeBillingProvider + Stripe stub) + subscriptions.ts (subscriptions/addons D1 lifecycle) + meter.ts (append-only usage_events ledger, UNIT_COSTS→cents) + concurrency.ts (KV sandbox-slot leases) + limits.ts (admission gate: cost cap + concurrency + tier features, fail-closed on cap / fail-open on unknown error) + routes.ts (MNEMO-49)
│   ├── obs/                               # observability: logger.ts (structured JSON log + withContext + newRequestId) + metrics.ts (counter/timing + METRICS names) + requestContext.ts (mounted first: requestId + scoped logger + access log) (MNEMO-50)
│   ├── errors/                            # AppError.ts (taxonomy + toAppError + admissionToAppError) + handler.ts (the single onError + notFound) (MNEMO-50)
│   └── abuse/                             # rateLimit.ts: declarative fixed-window rate limiting over LIMITS KV + rateLimitMiddleware + byIp/byAccount (MNEMO-50)
├── test/
│   ├── health.test.ts                     # Workers-pool test (cloudflare:test / :workers)
│   ├── db.test.ts                         # D1 access-layer tests (Workers pool, migrated DB)
│   ├── memory-layout.test.ts              # pure unit: path-traversal guards + commit-message round-trip (MNEMO-07)
│   ├── memory-git.test.ts                 # Workers-pool: issued git sequence + shell escaping via injected SandboxLike (MNEMO-07)
│   ├── apply-migrations.ts                # vitest setupFile: applies migrations to DB
│   ├── audit-store.test.ts                # node:sqlite spike test (run via `test:audit`)
│   ├── audit-sse.test.ts                  # pure unit: formatSseFrame + SseHub stream (MNEMO-20)
│   ├── audit-do.test.ts                   # Workers-pool: AuditLog DO over ctx.storage.sql via runInDurableObject (MNEMO-20)
│   ├── audit-emitter.test.ts              # Workers-pool: AuditEmitter rubric/level/sessionId + swallow-on-failure (MNEMO-21)
│   ├── reports-charts.test.ts             # pure/mocked: buildChartCode/buildSvgToPngCode snippets + ChartSpec schema + renderChartPng decode/write/emit (MNEMO-23)
│   ├── reports-interpreter.test.ts        # mocked-sandbox: CodeInterpreter once-per-agent context cache + ExecutionResult→RunResult normalization (MNEMO-23)
│   ├── reports-frontmatter.test.ts        # pure: serializeFrontMatter stable key order/quoting/lists + ReportFrontMatter schema (MNEMO-24)
│   ├── reports-generate.test.ts           # mocked interp+sandbox+emitter: generateReport markdown/persist/audit/assets (MNEMO-24)
│   ├── reports-archive.test.ts            # Workers-pool: archiveReport R2 put + D1 row + getReportMarkdown/Asset round-trip + ownership (MNEMO-25)
│   ├── reports-api.test.ts                # Workers-pool full-worker: /agents/:id/reports list/markdown/asset + traversal/missing/ownership guards (MNEMO-25)
│   ├── reports-delta.test.ts              # pure: diffFindings added/removed/changed/unchanged + value normalization + summarizeDelta headlines/isEmpty (MNEMO-26)
│   ├── reports-delta-report.test.ts       # mocked archive + findingsFromMemory: generateDeltaReport What-changed lead, findings round-trip, delta audit payload, skip-when-unchanged, first-run baseline (MNEMO-26)
│   ├── schedule-cron.test.ts              # pure: nextRunAfter (hourly/daily/weekly/step/sparse) + isDue enabled/disabled/null-cron/never-run/malformed (MNEMO-27)
│   ├── schedule-fanout.test.ts            # Workers-pool: runDueAgents only-due/failure-isolation/marker-advance + enableSchedule/disableSchedule arm/cancel (MNEMO-27)
│   ├── email-report-notify.test.ts        # Workers-pool: notifyReportReady send (to/subject/deep-link/inline-cid PNG) + non-2xx error-audit + owner-unresolved + MNEMO-26 skip → zero sends (MNEMO-28)
│   ├── discovery-spec.test.ts             # pure: DiscoverySpec accept/reject + defaultDiscoveryState + prompt facet coverage + finalize_discovery execute/onFinalize/reject (MNEMO-29)
│   ├── discovery-do.test.ts               # Workers-pool: startDiscovery→in_progress/0 + non-finalizing turn increments turns + mocked finalize_discovery flips complete + spec persists across idFromName (MNEMO-29)
│   ├── build-prompt.test.ts               # pure: assembleSystemPrompt (subject/fragment//brain) + getTemplate real-lens/fallback + defaultBuildStatus (MNEMO-30)
│   ├── build-do.test.ts                   # Workers-pool: build() spec-gate (writes nothing) + mocked-sandbox provision + settings/schedule/registry sync + ready/idempotence (MNEMO-30)
│   ├── templates.test.ts                  # pure: per-lens invariants (key/fragment/sources/cron/seed-path) + 'other' fallback + vendor fragment composes via assembleSystemPrompt (MNEMO-31)
│   ├── messaging-segmentation.test.ts     # pure: isGsm7 GSM-7/UCS-2 classification + countSegments boundaries (160/161 GSM-7, 70/71 UCS-2) (MNEMO-44)
│   ├── messaging-twilio-send.test.ts      # Workers-pool: TwilioSmsChannel.send wire format (Messages URL/Basic auth/From-To-Body) + SendResult ok + non-2xx no-throw (MNEMO-44)
│   ├── messaging-twilio-signature.test.ts # Workers-pool: validateTwilioSignature canonical Twilio vector true + tampered URL/param/wrong-sig false + verifyInboundSignature delegate (MNEMO-44)
│   ├── messaging-gateway.test.ts          # Workers-pool full-worker: POST /webhooks/twilio/sms - signed ack + waitUntil handoff, 403 bad-sig, 204 unknown-number (MNEMO-45)
│   ├── messaging-normalize.test.ts        # pure: Twilio-form→InboundMessage mapping + MalformedInboundError + MediaUrl collection (MNEMO-45)
│   ├── messaging-persistence.test.ts      # pure dayKey + Workers-pool DO-SQLite: 1:1 daily bucketing + from/direction/channel round-trip + ordering (MNEMO-46)
│   ├── messaging-onInbound.test.ts        # Workers-pool: onInboundMessage→runInboundReply persist-in/loop/send/persist-out + send-failure-audits + long-reply truncate+link (MNEMO-46)
│   ├── messaging-access.test.ts           # Workers-pool: decideAccess tier resolution (owner/known_contact/group_member/open_world/reject) + tierConstraints private-memory gating (MNEMO-47)
│   ├── messaging-group-expansion.test.ts  # Workers-pool: expandWhitelistForGroup scope:'group' + 1:1→known_contact-not-owner + idempotent (MNEMO-47)
│   ├── messaging-provisioning.test.ts     # Workers-pool: provisionAgentNumber search/purchase/persist + SmsUrl→gateway + no-number/purchase-400 no-throw (MNEMO-47)
│   ├── messaging-a2p.test.ts              # Workers-pool: ensureBrand/ensureCampaign lifecycle + getA2pStatus + enable route 401/409/200 (MNEMO-47)
│   ├── messaging-mentions.test.ts         # pure: parseMentions @name/@handle case-insensitive + first-word + no false-match on bare @/email (MNEMO-48)
│   ├── messaging-loopPrevention.test.ts   # pure: isFromAgent + gateAgentTurn (turn cap > mention, post-speak cooldown, agent↔agent silence) (MNEMO-48)
│   ├── messaging-triage.test.ts           # Workers-pool: triageGate parses bid JSON / silence-is-safe default / one cheap call, model stubbed (MNEMO-48)
│   └── messaging-coordinator.test.ts      # Workers-pool (THREAD+AGENT DOs): fan-out history + whitelist + floor control + @-mention override + agent↔agent cap + dedupe (MNEMO-48)
├── frontend/                              # React+Vite+TS SPA (own package.json) - see "Frontend" below (MNEMO-32)
│   ├── src/api/                           # auth-aware fetch client (apiFetch + ApiError, transport only)
│   ├── src/styles/                        # design tokens (tokens.css = single source of truth) + global.css
│   ├── src/components/ui/                 # canonical shared component library (mandatory; lint-enforced reuse)
│   └── src/pages/                         # route-level screens; src/pages/dev/Components.tsx = /dev/components catalog
├── docs/
│   ├── PRD.md                             # product spec + feasibility - READ FIRST
│   ├── RELEASE.md                         # release runbook: env setup, flow, verify, rollback (MNEMO-50)
│   └── crema-architecture-reference.md    # the reusable-component catalog
├── _crema-crm/                            # read-only reference clone (parts donor; do not edit/ship)
└── .maestro/                              # Maestro orchestration config
```

**Per-phase binding stubs:** `wrangler.toml` keeps every future binding (D1, KV, R2, Durable
Objects, Sandbox, AI, SELF) as a commented block tagged `# added in MNEMO-0X`. Uncomment + fill
the relevant block when its phase lands; mirror the binding's TS shape into `src/env.ts`. Live as
of MNEMO-06: the `SANDBOX` Sandbox DO (+ `[[containers]]` + migration tag `v2`) and the
`BRAIN_BUCKET` R2 bucket - all sandbox access goes through `src/sandbox/client.ts`, the single
boundary over the (Beta-header) Sandbox SDK; the DO owns warm/idle lifecycle (PRD §8.4). MNEMO-25
adds a SECOND R2 bucket, `REPORTS_BUCKET` (`mnemosyne-reports`), kept separate from `BRAIN_BUCKET`
so report blob retention/lifecycle can differ from the brain snapshots. MNEMO-27 adds a `[triggers]`
`crons` block (the platform heartbeat), a `SCHEDULE_KV` KV namespace (the fan-out's platform-side
last-run marker), and an `ENVIRONMENT` var (gates the dev-only trigger routes).

**Brain FS layout + git versioning (`src/memory/`, MNEMO-07):** `/brain` is a **git repo inside
the sandbox**, auto-committed on every write and on each consolidation pass (PRD §6.9). `layout.ts`
is the single source of truth for brain paths - `BRAIN_ROOT` (`/brain`), the `notes/` `tools/`
`reports/` subdirs, and `notePath`/`toolPath` helpers that reject path traversal so a model-supplied
slug can never escape `/brain` (`src/sandbox/persistence.ts` now imports `BRAIN_ROOT` from here - one
owner, no drift). `git.ts` holds `initBrainRepo` (idempotent; wired into `ensureWarm` so every warm
sandbox has the layout + repo), `autoCommit` (the single commit chokepoint - every memory-write path
and consolidation MUST call it, surfaced on the DO as `MnemosyneAgent.commitBrain`), and `isCleanTree`,
all through the MNEMO-06 client wrapper with shell-escaped values. `commit-messages.ts` builds
structured, parseable commit prefixes (`memory:`/`consolidate:`/`tool:`/`init:`) so MNEMO-12 can
categorize history. Debug route: `POST /agents/:agentId/brain/commit` proves the write→commit path.

**Memory graph index (`src/memory/`, MNEMO-08):** the brain's files become a *real graph* -
`wikilink.ts` is a pure `[[wikilink]]` parser (`parseWikilinks` + `slugifyTarget`; ignores fenced/inline
code; no FS/DO calls), and the neuron/synapse index lives in **DO-SQLite** so search, traversal, and
brain-size work WITHOUT waking the container (PRD §4/§6.2/§7.4). `graph-schema.ts` holds the DDL
(`neurons` keyed by FS `path` + `slug`; `synapses` with nullable `dst_path` for *dangling* links) and
`initGraphSchema`, wired into the single `initAgentSchema` chokepoint via the `sqlDriver(SqlStorage)`
adapter (so the same `SqlDriver` surface `src/audit/store.ts` defines runs in the DO and on node:sqlite).
`graph-index.ts`'s `GraphIndex` maintains it: `upsertNeuron` (idempotent delete-then-insert of outgoing
edges, auto-resolving danglers), `removeNeuron`, `resolveDangling`, and `counts()` (the brain-size
primitive MNEMO-09 surfaces). The index is **metadata only** - it never stores note content. On the DO,
`reindexNote(path)` / `reindexAllNotes()` read notes through the MNEMO-06 client and upsert them; every
memory-write path (MNEMO-10) MUST call `reindexNote` after a write to keep the index in lockstep.
The node:sqlite test runs via `npm run test:memory` (excluded from the vitest pool, like `test:audit`).

**Memory write API + consolidation (`src/memory/`, MNEMO-10):** the *write* side of memory.
`write.ts` is the single note-write pipeline - `writeNote`/`appendNote`/`deleteNote` run the ordered
chain **writeFile → reindex → commit** (reindex BEFORE commit, so the committed git tree and the
DO graph index always agree). Paths go through `notePath` (the traversal guard); the graph + commit
operations are injected as `BrainWriteHooks` (the DO passes `this`-bound `reindexNote`/`removeNeuron`/
`commitBrain` - NOT a self-addressed DO stub, which would deadlock a single-threaded DO). On the DO,
`memoryWrite`/`memoryAppend`/`memoryDelete` warm the sandbox then delegate here (audit emission is the
MNEMO-21 seam - commented, not wired). `consolidation.ts` is the **pure** planning half:
`planConsolidation(notes)` → a `ConsolidationPlan` of `merge`/`relink` ops (each with before/after for
diffing), detecting duplicate notes (normalized-content + title-slug) and format-only dangling links;
the LLM-driven proposals are the `// MNEMO-15/16` seam. `consolidation-apply.ts` is the apply half
enforcing PRD §6.2 "versioned + diffed before commit": clean-tree check → per-op unified diff →
apply via the write pipeline with **deferred per-op commits** → ONE `consolidate:` commit; aborts
(and `git checkout`-discards) a half-applied tree on failure. The single commit + diffs are the
MNEMO-12 restore safety net. Routes (all behind `requireAuth`, ownership-checked): `POST/PATCH/DELETE
/agents/:agentId/brain/notes[/:slug]` (Zod-validated, size-clamped) and `POST .../brain/consolidate?dryRun=`
(default-safe preview). The scheduled "sleep" pass is `onConsolidateIdle` (runs only on a clean tree),
armed via `scheduleConsolidation` - cadence is MNEMO-27. Tests: `test/memory-write.test.ts` (pipeline
ordering + traversal guard, injected `SandboxLike`) and `test/memory-consolidation.test.ts` (pure planning).

**Brain explorer + archive (`src/memory/`, MNEMO-11):** the brain is browsable, editable, and
downloadable from the web (PRD §6.9). `explorer.ts` is a *general file* service over `/brain` (not
just notes): `listTree` (one pruned `find -printf`, typed entries), `readBrainFile` (size-capped via
`MAX_READ_BYTES`, base64 for binary so a 50MB blob never marshals as a JSON string), and
`writeBrainFile`/`createBrainFile`/`createBrainDir`/`deleteBrainPath`. Every path is contained by the
shared `assertInsideBrain` guard in `layout.ts` (reuses `normalizePosix`; one guard, no duplication)
plus `isNotePath`/`noteSlugFromPath`. **Human edits are first-class memory writes:** a note path
(`*.md` under `/brain/notes`) is funnelled through the MNEMO-10 `write.ts` pipeline (so reindex→commit
ordering and the `memory:` commit prefix are identical to an agent write); non-note files
(tools/reports/binaries) raw-write + commit `explorer: edit/delete <path>` (new `explorer`
`CommitCategory` in `commit-messages.ts`; no reindex - not a neuron). `archive.ts`'s `archiveBrain`
builds a whole-brain `tar.gz`/`zip` in `/tmp` (INCLUDING `.git`, excluding transient scratch), reads it
back through the text-only client via a `base64` sidecar, and returns `{ bytes, filename, contentType }`
(noted optimization: stream the R2 snapshot for very large brains). The DO mediates every operation
(`brainListTree`/`brainReadFile`/`brainWriteFile`/`brainCreateFile`/`brainCreateDir`/`brainDeletePath`/
`brainArchive` - warm sandbox + `this`-bound write hooks); routes (`GET/PUT/DELETE
/agents/:agentId/brain/file[s]`, `GET .../brain/archive?format=`) are Zod-validated, size-clamped, and
ownership-checked, never touching the sandbox directly. Tests: `test/brain-explorer.test.ts` and
`test/brain-archive.test.ts` (injected `SandboxLike` + recording hooks). This is the API the Brain
Explorer UI (MNEMO-38) consumes.

**Brain versioning (`src/memory/versioning.ts`, MNEMO-12):** the brain's git history exposed to the
web - commit log, per-file diffs, and one-click restore (PRD §6.9; the safety net consolidation
requires + a guard against a bad self-authored-tool write). All git reads go through the MNEMO-06
client via the **exported** `GIT` (`git -C /brain`) prefix from `git.ts` - one source of truth - using
machine-parseable output (`-z`/`%x1f` so subjects/filenames with spaces parse cleanly, `--numstat` for
counts). `listHistory`/`fileHistory` (`--follow`) return a paged `HistoryPage { entries, nextCursor }`
(category via `parseCommitCategory`); `commitDiff` joins `--numstat` with the per-file patch;
`fileDiff` and `fileAtRevision` (`git show <sha>:<rel>`) serve the side-by-side view. Diffs/reads are
size-bounded (`MAX_PATCH_BYTES`/`MAX_FILE_AT_BYTES`, truncate + flag). **Restore is the one destructive
op and is conservative:** `restoreFile` (`git checkout <sha> -- <path>`) and `restoreTree`
(`git read-tree --reset -u <sha>` - faithful incl. deletions, HEAD untouched) both land as a **NEW**
commit through the MNEMO-07 `autoCommit` chokepoint (`restore:` prefix + `CommitCategory`), never a
hard reset - so a restore is itself reversible. Restore re-syncs the DO graph index via injected
`RestoreHooks` (`reindexNote` for a file, `reindexAllNotes` for a tree - else index ↔ FS diverge,
§7.4) and `restoreTree` takes a `pre-restore` R2 snapshot FIRST (the coarse backstop). Every sha is
whitelisted by `assertSafeRev` (no `--option` injection) and shell-quoted. The DO surfaces
`brainHistory`/`brainFileHistory`/`brainCommitDiff`/`brainFileDiff`/`brainFileAt`/`brainRestoreFile`/
`brainRestoreTree` (warm sandbox + `this`-bound restore hooks); routes (`GET .../brain/history[/file]`,
`GET .../brain/diff?sha=` | `?path=&from=&to=`, `GET .../brain/file-at`, `POST .../brain/restore`) are
Zod-validated (a `GitRev` boundary schema) and ownership-checked. Tests: `test/brain-versioning.test.ts`
+ `test/brain-restore.test.ts` (injected `SandboxLike` + graph mock). This is the backend for the Brain
Versioning UI (MNEMO-39).

**Per-agent DO (`src/agent/`, MNEMO-04):** `MnemosyneAgent extends AIChatAgent<Env>` is the
always-home half of the DO-warm / sandbox-ephemeral split (PRD §7.4). It is registered via the
`AGENT` Durable Object binding (`class_name = "MnemosyneAgent"`) plus a `new_sqlite_classes`
migration (`tag = "v1"`) so `ctx.storage.sql` is available; the class is re-exported from
`src/index.ts` for Wrangler. One instance per agent via `env.AGENT.idFromName(agentId)`
(`getAgentStub`); settings/schedule persist to DO-SQLite via the single `initAgentSchema` path in
`src/agent/sql.ts` (the extension point for the MNEMO-08 memory index and MNEMO-27 schedule). The
Worker calls the DO's public methods directly over native RPC on the stub - no fetch switch. NB:
the persisted run-schedule accessors are `getScheduleConfig`/`updateScheduleConfig`, not
`getSchedule` (the base class already owns `getSchedule(id)` for its alarm scheduler).

**Harness & agentic loop (`src/agent/`, MNEMO-15):** the agentic loop itself - PRD §7.1 **topology A**
(the DO is the harness host, the model is called via API, the sandbox is a tool surface). It is the
Vercel AI SDK loop hosted by `AIChatAgent`, NOT bespoke loop code: `onChatMessage` runs `streamText`
(interactive) and `runHeadless` runs `generateText` (scheduled/background, e.g. reporting MNEMO-24,
scheduling MNEMO-27), both over an **empty tool map this phase** (the catalog lands MNEMO-16; the
`// tools added in MNEMO-16` seam marks it). `src/agent/config.ts` holds the loop budgets -
`INTERACTIVE_STEP_BUDGET=30`, `DEFAULT_HEADLESS_STEP_BUDGET=80`, `DEEP_RESEARCH_STEP_BUDGET=200`
(§8.5) - fed to `stopWhen: stepCountIs(...)`, the **hard ceiling**; the terminator tool (MNEMO-18)
is the *intended* exit, so a budget-exhausted finish without a terminator call is a detectable
soft-fail. `src/agent/prompts.ts`'s `buildSystemPrompt(agent, { extras })` layers in fixed order
**base persona → entity-template overlay (vendor/product/investor/founder, keyed by the D1
`AgentTemplate` enum) → the agent's own `system_prompt` → per-turn extras** (base scope/safety always
wins; null layers skipped; data-driven, no agent names - mirrors crema-ref §11). The DO rehydrates its
registry context (`accountId`/`template`/`system_prompt`) in `onStart` via `getAgent(env, this.name)`
(cached in DO-SQLite under `registry:context`), captures the forwarded `x-mnemo-account` identity
header in `onConnect`/`fetch` (the §3 `x-rep-jwt` threading pattern, so a cold DO self-identifies),
and resolves the per-user model via `resolveModel()` → `getModel(env, accountId)` (PRD §7.2). Each
turn's spend is metered through `recordUsage` (MNEMO-14) in the `onFinish` callback (best-effort -
never breaks the stream). `AIChatAgent` persists message history automatically. The Worker routes chat
with `app.all("/agents/:agentId/chat")` (behind `requireAuth`, ownership-checked → 404 no-leak):
it copies the authenticated account id into `x-mnemo-account` (un-spoofable - `Headers.set` overwrites)
and forwards the raw request to the DO `fetch`, handling **both** the WS upgrade (interactive
streaming) and a plain `POST .../chat` JSON entry (the DO's `fetch` override → `saveMessages`). Tests
(`test/agent-loop.test.ts`, `test/agent-headless.test.ts`) are hermetic via a deterministic
`MockLanguageModelV3` injected through `MnemosyneAgent.testModelOverride` (shared builders in
`test/mock-model.ts`, a non-`.test.ts` helper) - no real inference. **Decision:** the harness reaches
Mnemosyne services via a **direct service layer** (PRD §7.1), not Crema's tools-over-own-API, so no
`SELF` binding is added here.

**Tool framework & sandbox-driving registry (`src/tools/`, MNEMO-16):** the Zod-typed tool catalog
the harness hands the model (PRD §6.3). `types.ts` defines the per-turn `ToolContext`
(`{ env, agentId, accountId, sandbox, emit, sessionId }`; `SandboxHandle` aliases the MNEMO-06
`SandboxClient`), the `MnemosyneTool = Tool` alias, and `LARGE_OUTPUT_THRESHOLD_BYTES` (8 KiB).
`largeOutput.ts`'s `spillIfLarge` is the **load-bearing §7.1 enforcement point**: the `ai` SDK never
compacts the in-loop message array, so any tool output ≥ the threshold is written to
`/brain/.tool-out/<sessionId>/<name>-<ts>.txt` and the loop is handed a **path + 500-char preview, not
the blob** (small outputs inline; size measured in UTF-8 bytes). `registry.ts`'s `buildTools(ctx)`
returns the five core sandbox-driving tools - `runShell`, `runPython`, `readFile`, `writeFile`,
`listDir` - each routing output through `spillIfLarge` and emitting a `tool.ran` audit event
(`writeFile` also emits `memory.wrote`); `runShell`/`runPython` carry a 60s guard, `listDir` shell-quotes
its path via `git.ts`'s `shQuote`. **NB:** MNEMO-06 ships no Code Interpreter wrapper yet, so `runPython`
writes the snippet to `/tmp` and runs `python3` over the exec surface. **Decision (resolved):** tools use
the **direct service layer** - a tool's `execute` calls the sandbox/service wrappers directly, NO `SELF`
HTTP round-trip (crema-ref "tools-over-own-API" trade-off; the surface is a memory store, not a rich API).
The DO wires it in via `MnemosyneAgent.buildTurnTools(sessionId)` (warms the sandbox, builds the context
with a **no-op `emit`** until MNEMO-20's AuditLog DO, calls `buildTools`) in both `onChatMessage`
(`sessionId: null`) and `runHeadless`. A TEST-ONLY `testSandboxOverride` (mirrors `testModelOverride`)
injects a stub container in the workers pool. Tests: `test/tools-largeOutput.test.ts`,
`test/tools-registry.test.ts`, `test/agent-tools-integration.test.ts` (mock model emits a `runShell`
call → final text, proving the registry is wired into the loop), with a shared `test/stub-sandbox.ts`
recording `SandboxLike`.

**Terminator tool & final-report schema (`src/tools/` + `src/agent/`, MNEMO-18):** the
*deliberate* loop exit for deep-research runs (PRD §6.3/§7.1; the "terminator-tool-as-schema"
pattern, crema-ref §6). `reportSchema.ts` is the final-report Zod schema `FinalReport` (`title` /
`summary` / `sections[]` / `keyFindings[]` / `sources[]` / `confidence`; Obsidian-friendly so
MNEMO-24 renders it straight to markdown + front matter) and its inferred `FinalReportData`. That
schema **is** the terminator's `inputSchema`: `terminator.ts`'s `makeTerminator(ctx)` builds a
per-run tool (`description` opens with the §6 "TERMINATOR - call exactly once…" convention) whose
`execute` captures the validated report into a closure `sink`, emits a `report.generated` audit
event, and returns `{ saved: true }`; `getResult()`/`wasCalled()` expose the captured state. The DO
reads the sink after the loop. `src/agent/stopConditions.ts`'s `terminatorOrBudget(stepBudget,
wasCalled)` is the `stopWhen` array: `stepCountIs(stepBudget)` (the hard ceiling) **plus** a
predicate that stops the moment the terminator fires, so a deliberate exit ends the loop promptly.
`MnemosyneAgent.runHeadless` wires it in - builds the terminator over a shared `buildToolContext`,
registers it under `submitFinalReport`, appends the `DEEP_RESEARCH_OVERLAY` system layer (headless
only, never interactive chat), and returns a new `finalReport: FinalReportData | null`. A null
report after the loop emits an `error`-level `narration` audit note - the detectable soft-fail (the
run hit the ceiling, or finished as prose, instead of terminating on purpose). Audit emission now
flows through one `emitAudit` method (the MNEMO-20 AuditLog seam) with a TEST-ONLY `testAuditSink`
recorder (mirrors `testModelOverride`/`testSandboxOverride`). Tests: `test/terminator.test.ts`
(capture + emit + Zod rejection) and `test/agent-terminator-loop.test.ts` (a scripted clean exit vs.
a no-terminator soft-fail, driven through `runHeadless`).

**Self-authored tools / procedural memory (`src/tools/selfAuthored/`, MNEMO-19):** the agent's
*procedural* memory (PRD §6.2) - scripts it writes ONCE to `/brain/tools/<name>/` and re-runs across
sessions (vs. notes as *declarative* memory). **The product's largest security surface** (agent-authored
code re-run later), contained by complete per-agent sandbox isolation (§7.3/§8.4): such code only ever
runs in the agent's own container, never in the Worker/DO and never against another brain. `manifest.ts`
is the `ToolManifest` Zod schema (`name` slug `^[a-z0-9-]+$` / `description` / `runtime` python|shell /
`entrypoint` / `inputSchema` JSON-Schema / `createdAt` / `version`) + `toolDir`/`manifestPath` helpers.
`security.ts` is the containment layer: `validateToolName` (slug-only - rejects traversal/dotfile/
uppercase/empty), `assertWithinToolDir` (reuses `layout.ts`'s `assertInsideBrain`, then tightens to the
single tool dir; any escape → one `ToolSecurityError`), `validateInput` (a focused JSON-Schema validator
run BEFORE any script sees input), and `SELF_AUTHORED_RUN_TIMEOUT_MS = 60_000`. `authoring.ts`'s
`buildAuthoringTools(ctx, deps?)` exposes the meta-tools `authorTool` (writes script + manifest, bumps
`version` on re-author, auto-commits `tool: author <name>` via the MNEMO-07 `autoCommit` - injectable as
`deps.commit` for tests - and emits `tool.authored`), `listTools`, and `deleteTool` (`rm -rf` + commit +
`tool.authored{deleted}`). `discover.ts`'s `discoverSelfAuthoredTools(ctx)` lists `/brain/tools/*/tool.json`
via `find`, `safeParse`s each (a malformed manifest is skipped with an `error` note - never crashes the
loop), and registers each valid one as `brain__<name>` whose `inputSchema` is `jsonSchema(...)` and whose
`execute` validates input, **delivers it as a JSON file read from stdin (never string-interpolated into the
shell command** - the load-bearing injection guard), runs `python3|sh '<entry>' < '<inputfile>'` under the
60s cap, spills large output (§7.1), and emits `tool.ran`. `registry.ts`'s `buildTools` is now **async** -
it spreads `buildAuthoringTools` + `await discoverSelfAuthoredTools` under the `brain__*`/authoring
namespace (discovery degrades gracefully). `MnemosyneAgent.runHeadless` was updated to `...(await
buildTools(ctx))` accordingly (`buildTurnTools` already returned the promise). Tests:
`test/selfAuthored-security.test.ts`, `test/selfAuthored-authoring.test.ts`,
`test/selfAuthored-discover.test.ts`, and `test/agent-selfAuthored-replay.test.ts` (an in-memory FS
sandbox proves author-then-discover-then-call cross-session replay through the real loop).

**Audit log DO (`src/audit/`, MNEMO-20):** the first phase of Track D ("glass cockpit") - it runs the
**untouched** audit spike (`store.ts`/`types.ts`, 6/6 tested) in the Workers runtime as a dedicated
per-agent `AuditLog` Durable Object (PRD §7.4/§8.6). Registered via a SECOND DO binding `AUDIT`
(`class_name = "AuditLog"`, `new_sqlite_classes` tag `v3`) - a separate namespace from `AGENT`, so the
append-only audit index (DO SQLite + FTS5) is queryable WITHOUT waking the agent loop; one instance per
agent via `env.AUDIT.idFromName(agentId)` (`getAuditStub` in `src/index.ts`, mirroring `getAgentStub`).
The phase is pure plumbing - **no spike logic changed**: `do-driver.ts`'s `DoSqlDriver` is the production
twin of the test's `NodeDriver`, adapting `ctx.storage.sql` to the shared `SqlDriver` surface (the
spike's `SCHEMA`/`RETURNING`/FTS5 parity across `node:sqlite` and `ctx.storage.sql` is why one `AuditStore`
runs in both). `sse.ts` is the fan-out: a pure `formatSseFrame(event)` (uses the event `seq` as the SSE
`id:` so a browser's `Last-Event-ID` reconnect maps onto the store's `sinceSeq` cursor, §6.7) plus an
`SseHub` (`subscribe(): Response` text/event-stream + `publish(event)` to live subscribers). `AuditLog.ts`
is thin: it builds an `AuditStore` over a `DoSqlDriver` in the constructor, runs `store.init()` once under
`ctx.blockConcurrencyWhile`, and exposes RPC `emit`/`query`/`search` (+ `fetch` handling `GET .../stream`
→ `hub.subscribe()`; reconnect backfill + filtering + the altitude default were layered on in MNEMO-22 -
see the Audit API note below). **NB:** the agentId stamped on every event is read
from `this.ctx.id.name` (populated for `idFromName` IDs under our compat date - the `agents` SDK derives
`MnemosyneAgent.name` the same way), NOT threaded through each call as the spec's outdated "idFromName
doesn't expose the name" premise assumed. **Known seam (MNEMO-22):** the native RPC stub can't *type* these
methods because the spike's `AuditEvent.payload: Record<string, unknown>` isn't RPC-type-serializable
(`Serializable<unknown>` → `never`); tests use `runInDurableObject` for real types, and a typed RPC
boundary is MNEMO-22's to add. The MNEMO-15/18 `MnemosyneAgent.emitAudit` no-op is the wiring seam (MNEMO-21).
Tests: `test/audit-sse.test.ts` (pure) and `test/audit-do.test.ts` (Workers pool, parallel to the spike's
`test/audit-store.test.ts`).

**Audit emission across the loop (`src/audit/emitter.ts` + `src/agent/`, MNEMO-21):** the agent now
*writes to* the glass cockpit - the higher-level **productivity stream** (`session.*`, `source.read`,
`memory.wrote/linked/consolidated`, `tool.authored/ran`, `report.generated`, `chart.rendered`,
`narration`, `error`), NOT a token/tool dump (PRD §6.7/§7.1). `AuditEmitter` is the ONE typed write
facade: typed convenience methods (`sessionStarted`/`sourceRead`/`memoryWrote`/… /`error`) that encode
the **default altitude rubric** ONCE - `session.*`/`report.generated`/`memory.consolidated`/`tool.authored`
→ `milestone`; `source.read`/`memory.wrote`/`memory.linked`/`tool.ran`/`chart.rendered`/`narration` →
`info`; `error` → `error` - bind every event to a run's `sessionId` (`AuditEmitter.withSession`), and
**swallow** a failed emit (`console.warn`, never throw - audit is observability, not control flow). It
drives a structural `AuditEmitTarget` (`{ emit(input) }`), so it works over the real DO instance (tests)
AND over the `getAuditStub` RPC stub cast through that interface - the one bridge past the MNEMO-22
not-yet-typed-RPC seam. `getAuditStub` **moved** `src/index.ts` → `src/audit/index.ts` (re-exported) so
the agent DO imports it without a circular import. In `MnemosyneAgent`: `emitAudit` is no longer a no-op
- it records to `testAuditSink` then forwards through a cached forwarding emitter to the `AuditLog` DO;
`auditFor(sessionId)` returns a rubric emitter whose target funnels back through `emitAudit` (so loop
events hit both the test spy and the DO). `onChatMessage`/`runHeadless` mint a `sessionId`, emit
`sessionStarted` (a length-bounded prompt *summary*, never the full text), `sessionCompleted` (step count
+ outcome) on finish, and `error` on `onError`/catch (message only; detail in `payload`); `onStepFinish` →
`narrateStep` emits one plain-English `narration` per tool-call intent (`describeToolCall`, derived from
the call - NOT raw reasoning, which is the `info`-level "show the work"). The soft-fail `narration`@`error`
("research ended without a final report") shape is preserved verbatim. Memory layer: `memoryWrite`/
`memoryAppend` emit `memory.wrote` + a `memory.linked` per distinct `[[wikilink]]` (re-running the pure
`parseWikilinks` the MNEMO-08 index uses, so the stream agrees with the graph); `consolidate` emits
`memory.consolidated` (`milestone`, `{ ops, merges, relinks, commit }`) and the scheduled `onConsolidateIdle`
wraps the pass in a synthetic `consolidate:<ts>` session. Tool-layer emissions (`tool.ran`/`source.read`/
`tool.authored`) were already wired in MNEMO-16/17/19 via `ToolContext.emit`; they now actually reach the
DO. `src/reports/audit.ts` reserves the MNEMO-23 (`emitReportGenerated`) / MNEMO-24 (`emitChartRendered`)
emit seams behind an optional emitter param. Tests: `test/audit-emitter.test.ts` (rubric/level/sessionId +
swallow-on-failure).

**Audit API (`src/audit/routes.ts`, MNEMO-22):** the glass cockpit over HTTP (PRD §6.7/§8.6). A
`Hono<AppEnv>` group (`auditRoutes()`, wired into `src/index.ts` before the `/agents/:agentId/*`
wildcard) mounts three reads at `/agents/:agentId/audit/*`, all behind `requireAuth` + an
`assertOwnsAgent` guard (reuses the MNEMO-05 `getAgentOwned` lookup; **404, not 403** for a non-owned
id - same no-existence-leak convention as the registry/brain routes):

- `GET /stream` - the live SSE tail. The route Zod-validates the filter params then proxies the **raw**
  request to the DO `fetch` and returns its streamed `Response` directly, so SSE (and the `Last-Event-ID`
  header / `?sinceSeq=` / filters) passes through the worker untouched.
- `GET /events?type[]=&level=&sessionId=&sinceSeq=&fromTs=&toTs=&limit=` - structured filter → the DO
  `query` RPC → JSON array. `limit` default 100 / max 1000 (= `AuditStore.MAX_LIMIT`).
- `GET /search?q=&limit=` - FTS5 search → the DO `search` RPC → JSON array. `limit` default 50 / max 200
  (the store's search cap); `q` is required + length-bounded (the store already quotes it as an
  injection-safe FTS phrase - not re-sanitized here).

`type`/`level` are validated against the `AuditType`/`AuditLevel` unions (unknown ⇒ 400); numeric params
are `z.coerce.number().int()`-coerced and `limit` clamped server-side. **Altitude default (§6.7
progressive disclosure):** when a stream/query omits `level` it defaults to `DEFAULT_AUDIT_LEVEL =
"milestone"` (the calm narrated stream) - `level=info` shows the work, `level=error` isolates failures.
The altitude is a *read-time query concern*: the spike's `store.query`/`search` and the schema are
**unchanged**; the default is set in the DO `fetch` (stream) and the `EventsQuery` schema (`/events`)
off one shared constant. **Reconnect backfill:** the DO `fetch` reads the cursor from `Last-Event-ID`
(falling back to `?sinceSeq=`; `seq` *is* the SSE `id:`), `query`s the missed gap (filtered identically),
and `SseHub.subscribe({ backfill, filter })` writes those frames into the new stream **before**
registering it for the live tail - so a reconnecting client gets the gap (exclusive of the cursor, in seq
order) then resumes live with no dupes and no gap (the DO is single-threaded; nothing is emitted between
query and register). `SseHub.publish` now applies a **per-subscriber filter** so live frames honor the
same `type`/`level`/`sessionId`. The read side of the **MNEMO-22 typed-RPC seam** is bridged like the
MNEMO-21 `AuditEmitTarget`: a structural `AuditReader` (`{ query, search }`) the stub is cast through
(the native RPC stub still can't type `AuditEvent.payload`). Tests: `test/audit-api.test.ts`
(filter/search/caps/ownership through the full worker, parallel to the spike's `audit-store` semantics)
and `test/audit-stream.test.ts` (content type, live `id:`=`seq` frame, `Last-Event-ID`/`?sinceSeq`
backfill ordering, milestone-drops-info filter; bounded reads so an open stream can't hang).

**Reporting: Code Interpreter + chart→PNG (`src/reports/`, MNEMO-23):** the first phase of Track E
(Reporting & Scheduling) - persistent per-agent Python contexts + a chart→PNG pipeline (PRD
§6.4/§7.3/§8.1). **All Sandbox Code Interpreter access is isolated to `src/reports/interpreter.ts`**:
per the §8.1 Beta-SDK caveat, the Beta `createCodeContext`/`runCode` methods are funnelled through one
`CodeInterpreter` wrapper (the Code-Interpreter twin of `src/sandbox/client.ts`, which owns the
exec/readFile/writeFile surface - these methods are NOT in that wrapper). `getContext(agentId)` lazily
calls `createCodeContext` ONCE per agent and caches the handle, so matplotlib/pandas imports + loaded
dataframes persist across a run (the warm sandbox amortizes import cost); `runCode(ctx, code)` normalizes
the SDK `ExecutionResult` into the stable `{ stdout, stderr, error, results }` (a Python error is
RETURNED in `error`, not thrown - like a non-zero shell exit). `python-env.ts`'s `ensureCharting`/`ensureSvg`
are idempotent (gated by the context's `id`) one-time bootstraps: matplotlib pinned to the **`Agg`**
headless backend with a FIXED figure size/DPI + neutral style so a spec renders to reproducible PNG bytes
(the determinism MNEMO-26's delta/diff work needs), plus an SVG-rasterizer readiness check (cairosvg, else
svglib). `charts.ts` is the pipeline: `buildChartCode(spec)`/`buildSvgToPngCode(svg)` are **pure**,
unit-testable Python generators (the spec/SVG ride in as a **base64 literal**, never string-interpolated -
the injection guard); `renderChartPng(interp, ctx, spec, { writer, emitter? })` runs the snippet, captures
the `image/png` rich output, decodes base64→bytes, and persists to `/brain/reports/assets/<slug>-<ts>.png`
(layout's new `REPORT_ASSETS_DIR`) via the MNEMO-06 binary write, returning `{ pngBytes, path }`; `svgToPng`
rasterizes agent/tool SVG to the same canonical PNG (PNG embeds across web/email/SMS where SVG can't). The
optional injected `AuditEmitter` gets one `chart.rendered` via the MNEMO-21 `emitChartRendered` seam - kept
optional so the renderer is usable outside a loop (tests, scheduled runs). `types.ts` owns the public surface
(the Zod `ChartSpec` shared with MNEMO-24, plus `RunResult`/`CtxHandle`/`CodeRunner`/`BrainFileWriter` so
callers type against `src/reports/`, not the raw SDK); `index.ts` re-exports it. **MNEMO-06 extension:**
`SandboxClient` gained `writeFileBytes(path, bytes)` (base64 via the SDK's `encoding` option) - binary
artifacts can't go through the UTF-8 `writeFile`. Tests: `test/reports-charts.test.ts` (pure snippets +
schema + a fake interpreter/writer/emitter proving decode→write→emit) and `test/reports-interpreter.test.ts`
(mocked-sandbox unit test of the context cache + normalization). **Manual checkpoint → deploy-time release
gate:** the vitest-pool-workers env can't boot a container, MNEMO-06 exposes no Code-Interpreter test
harness, and there is no Docker / deployed worker / reporting route in CI, so a live
`print(1+1)`/real-chart/SVG→PNG round-trip against a provisioned sandbox cannot run in the unattended
environment. Rather than leave an open manual checkpoint, it is converted to a fully-specified deploy-time
release gate - **`docs/reports/live-verification.md`** (the 3 checks with snippets + pass criteria) - and the
live `src/reports/` verification is folded into MNEMO-24's first live integration. This is the §8.1 "pin
business-critical Beta behavior with a real run" obligation; run the gate once per environment before
relying on reporting in production.

**Reporting: report generation (`src/reports/`, MNEMO-24):** the finished **report artifact** -
Obsidian-style YAML front matter + a markdown body + **embedded PNG charts** (from MNEMO-23) -
produced on demand or on schedule, written to the brain FS, and audited (PRD §6.4). `front-matter.ts`
is the typed front-matter layer: a Zod `ReportFrontMatter` (`title`/`type:"report"`/`agentId`/
`template` (reusing the registry `AgentTemplate` enum)/`tags`/`created`/optional `period`/`cadence`/
`source_count`) plus `serializeFrontMatter` - a small dependency-light deterministic YAML emitter (no
YAML lib in the tree) that writes keys in a FIXED `KEY_ORDER` (documented `// MNEMO-26`) and omits absent
optionals, so the same input is **byte-identical** run-to-run (the property MNEMO-26's report delta/diff
relies on); `tags` render as a block list, scalars are quoted only when ambiguous (colons/dates/bool-/
number-like) with `\`/`"`/newline escaping. `markdown.ts`'s `buildReportMarkdown(input, deps)` is the
body assembler - front matter → `# title` → per-section `## heading`+body, rendering each section's
optional `ChartSpec` to PNG via MNEMO-23's `renderChartPng` (chart rendering is INJECTED - `{ interp,
ctx, writer, emitter? }` - so it's unit-testable with a mocked renderer) and inserting an image ref by a
path RELATIVE to the report (`![title](assets/<file>.png)`; both live under `/brain/reports/`), plus a
trailing `## Related` block of `[[wikilink]]`s so the report is a first-class neuron (§6.2); it collects
the rendered `ChartAsset`s ({ path, bytes, title }). `generate.ts`'s `generateReport(env, agentId, input,
deps?)` orchestrates: accepts the assembled `ReportInput` (a `// MNEMO-26` delta seam marks where
*what-changed* pre-filtering lands), ensures the agent's Code Interpreter context + `ensureCharting`,
calls `buildReportMarkdown` (passing the SAME `SandboxClient` as the chart writer, so PNGs land under
`assets/` during assembly), persists the `.md` to `/brain/reports/<slug>-<ts>.md` via the MNEMO-06
`writeFile` wrapper (shared `slugify` for the stem), emits `report.generated` (`milestone`, title +
`brainPath`) through the optional MNEMO-21 `AuditEmitter` (reusing `audit.ts:emitReportGenerated`), and
returns `{ markdown, frontMatter, brainPath, assets }`. The interpreter / brain-FS client / emitter are
all injectable (mirroring `src/memory/write.ts`) so it runs headless in tests without a container. **R2
archive + D1 metadata is MNEMO-25** (it reads back `assets[]` - bytes carried - + `brainPath`); the
delta/diff is MNEMO-26. Tests: `test/reports-frontmatter.test.ts` (pure) + `test/reports-generate.test.ts`
(fake interpreter/sandbox/emitter).

**Reporting: report archive + retrieval (`src/reports/archive.ts` + `routes.ts`, MNEMO-25):** the
durable home of a published report (PRD §6.4/§7.4). The brain-FS copy (MNEMO-24) stays the git-versioned
working copy; **R2 (`REPORTS_BUCKET`) is the store of record**. `archive.ts`'s `archiveReport(env,
agentId, generated)` mints a `reportId`, builds ONE prefix per report -
`agents/<agentId>/reports/<reportId>/` (derived from ids ONLY, never the model-supplied title/slug, so a
hostile name can't shape a key) - and `put`s `report.md` (`text/markdown`) + each `assets/<file>.png`
(`image/png`, bytes carried inline on `ChartAsset`, never re-read from the FS) under it, then inserts the
D1 `reports` row via the MNEMO-02 `createReport` (`r2_key` = the prefix, `front_matter` = serialized JSON;
D1 holds metadata ONLY, no blobs). `createReport` gained an optional `id` so the minted `reportId` IS the
D1 PK - the row id and the prefix's id are the same UUID. Asset filenames are the basename of
`ChartAsset.path`, re-validated against the exported `SAFE_ASSET_FILE` (`^[\w.-]+\.png$`) as defense in
depth. The read side (`getReportMarkdown`/`getReportAsset`) shares a private `ownedReport` (uses the new
`getReport(env, id)` db helper, returns null on absent OR `agent_id` mismatch - no existence leak),
resolves the R2 key off the record's prefix, and returns the `R2ObjectBody` (the R2-key derivation lives
in this ONE module). `generate.ts` now also exposes `generateAndArchiveReport` - the §6.4 happy path
(generate → persist-to-brain → archive-to-R2 → record-in-D1) - which runs `generateReport` with audit
emit SUPPRESSED (new `deps.emitGenerated` flag) then emits ONE finalized `report.generated` carrying the
real `r2Key`/`reportId` (`generateReport` stays callable standalone for tests). `routes.ts`'s
`reportRoutes()` mounts three reads at `/agents/:agentId/reports` (wired into `src/index.ts` before the
`/agents/:agentId/*` wildcard so the streamed Responses pass through): `GET /` (metadata list, newest
first), `GET /:reportId` (`report.md` as `text/markdown`, 404 if missing), `GET /:reportId/assets/:file`
(a PNG as `image/png`, `file` traversal-guarded by `SAFE_ASSET_FILE`). All behind `requireAuth` + the
shared `assertOwnsAgent` guard - **extracted to `src/agents/ownership.ts`** (de-duplicated from
`src/audit/routes.ts`, which now imports it; 404-not-403 no-existence-leak convention in one place).
Full-text search over report BODIES is deferred to the MNEMO-41 viewer UI. Tests:
`test/reports-archive.test.ts` (R2 put + D1 row + read round-trip + ownership) and
`test/reports-api.test.ts` (full-worker list/markdown/asset + traversal/missing/ownership guards).

**Reporting: delta-aware reporting (`src/reports/{findings,delta,delta-report}.ts`, MNEMO-26):**
the payoff of the memory thesis (PRD §6.4) - a scheduled report surfaces *what changed* since
last time, not a from-scratch re-summary, because the agent remembers prior state. The diff is
**semantic** (added/removed/changed *facts*), not a markdown line-diff. `findings.ts` is the
structured model both sides reduce to: a Zod `Findings` = a flat, `key`-unique list of typed
`Fact`s (`key` stable id e.g. `funding.last_round`, `label`, `value` (always a STRING so
comparison is uniform), optional `unit`/`source`/`asOf`/`section`). Reports **embed** their
findings as a fenced ` ```mnemosyne-findings ` JSON block (the MNEMO-24 assembler writes it from
the new `ReportInput.findings`, after the prose + Related) so a report **round-trips** - next run
reads last run's block to diff against; `findingsFromReport(fm, markdown|block)` extracts it and
`findingsFromMemory(env, agentId, scope, deps?)` derives current findings from neurons through an
injectable `FindingsSource` (the sandbox by default). Extraction is **deterministic** -
`canonicalizeFindings` sorts + de-dupes by `key` and `serializeFindings` emits a fixed field
order - so unchanged state yields a byte-identical `Findings` (no noise reports). `delta.ts` is
the **pure** (IO-free, exhaustively unit-tested) diff engine: `diffFindings(prior, current)` →
`{ added, removed, changed: {key,label,from,to}[], unchangedCount }` keyed by `key`, comparing
`normalizeValue`-normalized values (`"$10M"` ≡ `"$10 M"`, so cosmetic churn isn't a change);
`summarizeDelta` → `{ headline, isEmpty }` (`isEmpty` true ONLY when added/removed/changed are all
empty - `unchangedCount` never affects it). `delta-report.ts`'s `generateDeltaReport` orchestrates:
load the prior report's findings (most recent archived report via MNEMO-25, or empty ⇒ first-run
baseline) → `findingsFromMemory` → `diffFindings` → build a `ReportInput` that LEADS with a "What
changed" section (New/Changed/Removed lists + a prior-vs-current **bar chart** for numeric changes)
embedding the current `findings` → call `generateAndArchiveReport`; when the delta `isEmpty` and
`opts.skipWhenUnchanged` is set (scheduled default) it returns `null` and emits a milestone
`narration` "No material changes - skipped report" instead of noise. The `// MNEMO-26` seam in
`generate.ts` is **filled**: `ReportInput` gained `findings?` (persisted via the markdown block, the
next diff baseline) + `delta?` (its headline + add/change/remove counts ride into the
`report.generated` audit payload so the cockpit shows *why* a report fired). Every collaborator
(prior loader, current-findings derivation, generator, emitter) is injectable, so the orchestration
is testable without a container or R2. Tests: `test/reports-delta.test.ts` (pure diff/summary) and
`test/reports-delta-report.test.ts` (mocked archive + `findingsFromMemory` + a capturing generator
over the real `generateReport`).

**Scheduling: DO timers + cron fan-out + dev trigger (`src/schedule/`, MNEMO-27):** agents run **on a
schedule** via TWO deliberately-distinct layers (PRD §6.4/§7.4/§8.5). `types.ts` is the **pure** core
both layers share: a minimal INTERNAL 5-field cron evaluator (NOT a dep - the project is
dependency-light and the Worker-side fan-out can't lean on the `agents` SDK's own cron, so one owned
implementation keeps ONE cron semantics across both, evaluated in UTC) exposing `nextRunAfter(cron,
fromTs)` (field-advance algorithm: month→day→hour→minute, with the Vixie DOM/DOW OR rule) and
`isDue(schedule, nowTs, lastRunAt)` (enabled + cron + `now >= nextRunAfter(lastRunAt ?? 0)`; a
disabled/null/malformed cron is never due - a bad expression degrades, never throws into the
heartbeat), plus the `ScheduledRun`/`ScheduledRunPayload` Zod schemas. **Layer 1 - the DO timer
(`MnemosyneAgent`):** `scheduleNextRun()` reads `getScheduleConfig` (MNEMO-04) and, if enabled with a
valid cron, arms a one-shot `this.schedule(delaySec, "runScheduled", payload)` (the `agents` SDK
alarm, which **survives hibernation**, §7.1) tracked by a single stored id (cancel/re-arm, never
accumulate - mirrors the idle-alarm bookkeeping). `runScheduled(payload)` runs the work via an
**injected `scheduledRunner`** (default `defaultScheduledRun`: a stub that narrates a
`session.started`/`session.completed` pair via the MNEMO-21 emitter - the `// MNEMO-15/26` seam where
the real headless loop + delta report hook in), then in a `finally` records the DO-side last-run
marker and **re-chains** the next occurrence (so a failed run never stops the cadence; the error
still propagates to the fan-out). `enableSchedule(cron)`/`disableSchedule()` persist via
`updateScheduleConfig` and arm/cancel the timer. **Layer 2 - the Worker cron fan-out
(`fanout.ts`):** `runDueAgents(env, nowTs)` is the SAFETY NET for a DO evicted before its own timer
fired. It lists candidates from D1 (`listScheduledAgents`: `status='active'` + non-null
`schedule_cron`), checks each against a **platform-side** last-run marker in `SCHEDULE_KV`
(`lastrun:<agentId>` - separate from the DO's own `agent_meta` marker, so due-ness is decided WITHOUT
waking every DO), and only wakes a genuinely-due agent via its `runScheduled` RPC, advancing the
marker only on success (a failed run is retried next tick). Per-agent try/catch isolates failures
(one bad agent never aborts the batch); concurrency is chunked. The Worker `scheduled(event, env,
ctx)` handler (`src/index.ts`, default export is now `{ fetch, scheduled }`) is thin - just
`ctx.waitUntil(runDueAgents(env, Date.now()))` - fired by the `[triggers]` `crons = ["*/15 * * * *"]`
coarse heartbeat (per-agent cadence is enforced INSIDE the fan-out, not by many cron lines).
**`dev-routes.ts`** exists because **cron does NOT fire under `wrangler dev`** (§8.5): a prod-gated
group (`POST /__dev/cron` simulates a tick; `POST /agents/:agentId/__dev/run` forces one agent) whose
own middleware 404s every request unless `env.ENVIRONMENT !== "production"`, so it is mounted always
but **never reachable in production**. Tests: `test/schedule-cron.test.ts` (pure) and
`test/schedule-fanout.test.ts` (Workers-pool: only-due/failure-isolation/marker-advance via real D1 +
SCHEDULE_KV + AGENT DO, plus enable/disable arm-cancel via `listSchedules`).

**Reporting: email notification on report ready/update (`src/email/report-notify.ts`, MNEMO-28):** the
final phase of Track E - when a report is generated/updated, **notify the agent's owner by email** via
Resend (PRD §6.4). `resend.ts` (MNEMO-03) gains `sendReportNotification(env, opts)` - a SECOND send
function (not a new transport): subject `"[<agentName>] <reportTitle> - <deltaHeadline>"`, a SHORT HTML
notice (escaped user strings) with a deep link to the full web report, and - when a hero chart is present
- the chart PNG as a Resend **attachment** with a `content_id` referenced inline via `cid:` (the §6.4
rationale: PNG embeds in-client where SVG/email-CSS can't). It mirrors `sendMagicLink` - typed `SendResult`,
NEVER throws on non-2xx. `report-notify.ts`'s `notifyReportReady(env, agentId, report, deps?)` is the glue:
resolves the owner email (agent → `account_id` → `accounts.email` via the new `getAccount` db helper),
builds the `reportUrl` from `APP_BASE_URL` + the MNEMO-25 route, picks the hero chart (FIRST `ChartAsset`,
bytes carried inline - never re-reads R2), derives the headline (MNEMO-26 `summarizeDelta`, or "New report"
for a baseline), sends, and audits the outcome (a `milestone` narration "Emailed report to owner" on
success, an `error` on failure) via the MNEMO-21 emitter. The whole body is wrapped so a send/lookup
failure is logged + audited but NEVER propagates (best-effort - §7.1). A `// preferences` seam defaults
notifications ON until MNEMO-05 settings carry a toggle. Wired into the post-archive path of
`generateAndArchiveReport` (so MNEMO-26's `generateDeltaReport` gets it for free when a report IS produced)
via injectable `deps.waitUntil` (`ctx.waitUntil` in a Worker / `this.ctx.waitUntil` in a DO) so the send is
fire-and-forget; awaited inline when no scheduler is injected. The MNEMO-26 **skip path**
(`skipWhenUnchanged` → no report) returns BEFORE the generator, so **no email** fires on an unchanged run.
`APP_BASE_URL` is now a `wrangler.toml` `[vars]` entry (dev/test default; per-env override in prod) so the
deep link resolves. Tests: `test/email-report-notify.test.ts` (Resend POST stubbed at `globalThis.fetch`).

**Lifecycle: Discovery (`src/agent/discovery/`, MNEMO-29):** the **Discovery** stage of the
Discovery→Build→Operation lifecycle (PRD §5/§6.3) - a user gives an agent name + short description and the
platform runs a **clarify-scope conversation** that asks follow-ups until it is confident (~0.9
*good-enough*, **not** perfect, **not** every blank filled) it understands what the agent should specialize
in, then persists a structured **Discovery spec** that MNEMO-30 reads to provision a live agent. It runs
ENTIRELY inside the `MnemosyneAgent` DO - pure conversation + model calls, **no sandbox** (the agent isn't
provisioned yet). `facets.ts` is the **soft rubric**: the five PRD §5 facets (`subject`, `entityType`,
`sources`, `cadence`, `outputFormat`) each as `{ key, label, prompt, weight }` (`subject`/`entityType`
weighted slightly higher) - rubric DATA the prompt and the spec schema both reference, explicitly a
self-assessment guide and **NOT a required-fields gate**. `types.ts` is the Zod `DiscoverySpec` (the five
facets + `name`/`description`/`confidence` 0..1/`facetNotes`/`finalizedAt`; `entityType` reuses the D1
`AgentTemplate` enum + `"other"` - the **bridge to MNEMO-31 templates**), the `DiscoveryState`
(`status`/`spec`/`turns`) + `defaultDiscoveryState()`. `prompt.ts`'s `buildDiscoverySystemPrompt({ name,
description })` is the scoping-interviewer system prompt (one or two focused follow-ups per turn, prefer the
user's words, continuously self-assess, finalize at ~0.9 or immediately if the opening is already detailed;
calm §6.7 tone) - string-builder only, kept in its own module so MNEMO-31's templates extend it. **The
confidence gate is a terminator-style `finalize_discovery` tool (`tools.ts`), NOT a required-fields form**
(mirrors MNEMO-18's `submitFinalReport`): its Zod `inputSchema` **is** the `DiscoverySpec`, so the only way
to end Discovery is to emit a well-formed spec; `execute` validates it, calls the injected `onFinalize`, and
returns a confirmation - no sandbox/web tools are exposed (conversation-only). In `MnemosyneAgent`:
`startDiscovery({ name, description })` seeds `DiscoveryState` (`in_progress`, 0 turns) under the `discovery`
meta key (+ `discovery:input`/`discovery:messages`); `discoveryTurn(userMessage)` appends to the transcript
and runs the MNEMO-15 `generateText` loop with the Discovery prompt + tool over `getModel()` (MNEMO-13),
`stopWhen` = `[stepCountIs(DISCOVERY_STEP_BUDGET=8), () => finalized]` (shallow; stops the moment the
terminator fires), returning `{ reply, state }` and incrementing `turns`; `completeDiscovery(spec)` validates
+ persists the spec and flips status `complete`; `getDiscoveryState()` reads it back - all via `setMeta`/
`getMeta` (MNEMO-04), so the conversation survives hibernation. `// MNEMO-30 reads getDiscoveryState().spec
to provision` - Discovery provisions nothing. Routes (`src/agent/discovery/routes.ts`, wired into
`src/index.ts` before the `/agents/:agentId/*` wildcard, behind `requireAuth` + the shared `assertOwnsAgent`
guard, DO invoked over native RPC): `POST /agents/:agentId/discovery/start`, `POST .../discovery/message`,
`GET .../discovery`. Tests: `test/discovery-spec.test.ts` (pure: spec schema accept/reject, default state,
prompt facet coverage, the tool's `execute` calls `onFinalize` + rejects an invalid spec) and
`test/discovery-do.test.ts` (Workers pool: `startDiscovery`→`in_progress`/0; a mocked non-finalizing turn
increments `turns`; a mocked `finalize_discovery` flips `complete` + the spec persists across a fresh
`idFromName` stub - model mocked via `testModelOverride` so the loop is deterministic and free).

**Lifecycle: Build (`src/agent/build/`, MNEMO-30):** the **Build** stage of the
Discovery→Build→Operation lifecycle (PRD §5(2)) - turn a finalized Discovery spec (MNEMO-29) into a
**live, operable agent**. Orchestrated FROM the DO (PRD §7.1 topology A): it spins the per-agent
sandbox up to lay down the brain filesystem, then lets it idle (PRD §8.4) - Build never holds the
container warm. Build is **idempotent + resumable**: `MnemosyneAgent.build()` records each completed
`BuildStep` into `agent_meta` (`buildStatus`, the `build` key) as it lands, so a re-run (a half-built
sandbox MUST be safe to retry) skips finished steps and a fully-built agent is a no-op.
`types.ts` is the Zod state: `BuildStep` (`fs_init`/`git_init`/`template_applied`/`system_prompt`/
`tools_enabled`/`schedule_defaults`/`registry_synced`), `BuildStatus` (`phase`
`not_started`→`building`→`ready`/`failed` + `completed[]` + `error` + `builtAt`), `defaultBuildStatus()`,
and `ProvisionResult` (a per-sub-step `{ ok, step, detail? }` - provisioning failures are RETURNED, not
thrown). `template.ts` is the **template application interface** (MNEMO-30): `EntityTemplate`
(`key`/`systemPromptFragment`/`defaultSources`/`defaultCadenceCron`/`reportShapeHint`/`seedNotes`) +
`getTemplate(key)` over a `TEMPLATES` registry map. The four real lenses
(vendor/product/investor/founder) live one-per-file under **`src/agent/build/templates/`** (MNEMO-31),
each `export default` an `EntityTemplate` - a specialization overlay: an additive `systemPromptFragment`
(what signals matter for that lens, what "an update" means), `defaultSources` (seed hints, not an
allowlist), a weekly `"0 13 * * 1"` `defaultCadenceCron`, a `reportShapeHint` (named report sections
consumed by MNEMO-24), and a `/brain/notes/<lens>-profile.md` seed note with Obsidian front matter +
`[[wikilink]]` scaffolding (MNEMO-08 parses these into the graph so a fresh brain is non-empty).
**Adding a new lens = one file under `templates/` + one entry in the `TEMPLATES` map** - no interface
change. The registry also keeps the minimal generic `"other"` default (empty seeds, weekly cadence), and
`getTemplate` **falls back to `"other"`** for an unregistered lens (never throws). `systemPrompt.ts`'s `assembleSystemPrompt({ spec, template })`
is a PURE composer of the agent's operating system prompt (concise `/brain` base-persona reminder + the
spec subject/description/sources + the template fragment + report-shape hint + the §6.7 audit-narration
tone); Build persists it as the agent's `system_prompt`, where the MNEMO-15 layerer wraps it as the
"Operator instructions" layer at run time. `provision.ts`'s `provisionFilesystem(env, agentId, sandbox,
template)` lays down the brain FS by REUSING MNEMO-07's idempotent `initBrainRepo` (layout + README +
`.gitignore` + `git init` + initial commit) then writes the template's `seedNotes` and commits them via
the MNEMO-07 `autoCommit` chokepoint - each sandbox call individually error-handled into a
`ProvisionResult` (the signature takes `env`/`agentId` to feed `initBrainRepo`, the documented adaptation
of the spec's `(sandbox, template)` sketch). In `MnemosyneAgent`: `build()` requires
`getDiscoveryState().status === "complete"` with a non-null spec (else returns a `failed` BuildStatus
carrying `BUILD_NEEDS_SPEC` and writes nothing), then runs the seven steps in order - provision (uses
`testSandboxOverride ?? warmSandbox()`), assemble+persist the prompt via `updateSettings({ systemPrompt,
template })` (the spec's `"other"` entityType maps to a **null** registry template, no overlay), record
the operational tool set (`updateSettings({ enabledTools })` - new `AgentSettings.enabledTools` list:
web search/fetch + sandbox exec + self-authored tools), `enableSchedule(template.defaultCadenceCron)`
(persists + arms the DO timer), and `syncRegistry` → `updateAgent(... status:"operational")` - capturing
errors into `failed` with the failing step. `getBuildStatus()` reads it back. **NB:** Build promotes the
registry row to `operational`, so `listScheduledAgents` (MNEMO-27 cron fan-out) was broadened to
`status IN ('active','operational')` - else the scheduling safety net would never wake a built agent.
Routes (`src/agent/build/routes.ts`, wired into `src/index.ts` before the `/agents/:agentId/*` wildcard,
behind `requireAuth` + the shared `assertOwnsAgent` guard, DO invoked over native RPC): `POST
/agents/:agentId/build` (→ `build()`; safe to call repeatedly) and `GET /agents/:agentId/build` (→
`getBuildStatus()`). Tests: `test/build-prompt.test.ts` (pure: prompt assembly + template fallback +
default state), `test/build-do.test.ts` (Workers pool: the spec-gate writes-nothing path, a
mocked-sandbox end-to-end build asserting the `/brain` creation calls + settings/schedule/registry sync +
`ready`, and idempotence - a second `build()` does not double the filesystem work), and
`test/templates.test.ts` (MNEMO-31: per-lens invariants for vendor/product/investor/founder - own `key`,
non-empty fragment/report hint, ≥1 source, 5-field cron, `/brain/`-rooted seed paths - plus the `"other"`
fallback and a composition check that the vendor fragment lands in `assembleSystemPrompt`).

**Messaging: channel seam + Twilio SMS (`src/messaging/`, MNEMO-44):** opens **Track H** - a **paid
per-agent add-on** layered on the core (PRD §9.1/§9.3). `MessagingChannel.ts` is the provider-agnostic
seam the agent loop speaks so it NEVER imports a provider SDK: `readonly channel` + `readonly
capabilities` + `send(OutboundMessage)` + `verifyInboundSignature(req)`; a new transport is a new
implementation, not a caller change. `types.ts` is the Zod-typed contract both sides share - `Channel`
(`sms` is LIVE; `imessage`/`rcs` RESERVED so persistence/UI tags stay stable, §9.5),
`InboundMessage`/`OutboundMessage`, `ChannelCapabilities`, and the `SendResult` discriminated union
(`{ ok:true, providerMessageIds, segments } | { ok:false, error, status? }`); phone numbers are E.164
throughout. `segmentation.ts` is pure SMS length math - `isGsm7` (GSM-7 basic+extension vs UCS-2
classification) + `countSegments` over the 160/153 (GSM-7) and 70/67 (UCS-2) limits - used to report
`segments` for cost/audit (§9.2). `TwilioSmsChannel.ts` is the ONLY implementation now
(`ImessageProviderChannel` is PARKED per §9.2): `send()` POSTs form-encoded `From`/`To`/`Body` to
`${apiBase}/2010-04-01/Accounts/<sid>/Messages.json` under HTTP Basic auth, surfaces the `sid` + segment
count on 2xx, and returns `{ ok:false, status }` on non-2xx WITHOUT throwing (the seam-wide convention -
the caller audit-logs it); `capabilities` is `{ group:false, media:true, deliveryType:"sms" }` (SMS has
no native group thread - group threads are modeled app-side in MNEMO-48). `twilioSignature.ts`'s
`validateTwilioSignature` implements Twilio's `X-Twilio-Signature` scheme (full URL + POST params
sorted-by-key concatenated `key+value`, HMAC-SHA1 via Web Crypto `crypto.subtle` - no Node `crypto` -
base64, constant-time compare) so the MNEMO-45 gateway can trust inbound webhooks (§9.6);
`TwilioSmsChannel.verifyInboundSignature` is a thin delegate to it. Credentials (`TWILIO_ACCOUNT_SID`/
`TWILIO_AUTH_TOKEN`) are Wrangler secrets; `TWILIO_API_BASE` is a plain var (defaults
`https://api.twilio.com`). **MNEMO-45 wires this seam into an inbound webhook gateway.** Tests:
`test/messaging-segmentation.test.ts` (pure boundaries), `test/messaging-twilio-send.test.ts` (Workers
pool: send wire format + non-2xx no-throw, `fetch` stubbed), `test/messaging-twilio-signature.test.ts`
(Workers pool: Twilio's canonical signature vector true + tampered URL/param/wrong-sig false).

**Messaging: inbound gateway (`src/messaging/{gateway,normalize}.ts`, MNEMO-45):** the public webhook
Twilio POSTs to when someone texts an agent's number (PRD §9.3/§9.6). `gateway.ts`'s
`mountMessagingGateway(app)` registers `POST /webhooks/twilio/sms` - deliberately PUBLIC (NOT behind
`requireAuth`; the authenticated caller is Twilio, proven by the `X-Twilio-Signature` the handler
`validateTwilioSignature`s, not a logged-in user). It reads the form body, authenticates (403 on a bad
signature), `normalizeTwilioInbound`s it to the channel-agnostic `InboundMessage` (`normalize.ts`: pure
Twilio-form→`InboundMessage` mapping, `MalformedInboundError`→400; collects `MediaUrl0..N` bounded by
`NumMedia`), resolves the destination number→owning agent via `getAgentIdByNumber` (204 + warn when no
agent owns it), then FIRE-AND-FORGETS the handoff to the per-agent DO (`stub.onInboundMessage(msg)`) under
`executionCtx.waitUntil` and returns Twilio's empty-TwiML ack - the ack NEVER blocks on the agent loop.

**Messaging: inbound→loop→async reply + SMS persistence (`src/messaging/`, MNEMO-46):** a text message
actually drives the agent - the per-agent DO runs the SAME brain/memory/tools loop web chat uses and
replies **asynchronously** over the Twilio REST API once the loop finishes; SMS turns persist to the same
DO-SQLite store the web UI reads, so text threads render in-app as first-class conversations with a channel
badge (PRD §9.3/§9.5). This phase is 1:1 SMS only (`threadId === null`); group threads + access tiers are
later phases. **Persistence:** `src/agent/sql.ts` gained two DO-SQLite tables on the single `initAgentSchema`
path - `msg_session` (keyed by `counterparty`; a UNIQUE `(counterparty, kind, day)` index makes a calendar
day map to exactly ONE 1:1 session) and `msg_message` (`seq` AUTOINCREMENT; each row tagged with its `from`
identity + `channel`, §9.5) - plus thin typed CRUD (`insert/find/selectMsg*`, NO business logic).
`src/messaging/persistence.ts` layers the §9.5 rules over that CRUD: `dayKey(ts)` (UTC `YYYY-MM-DD`, the
daily bucket key, following the web conversation model §6.5), `getOrCreate1to1Session` (the daily
bucketing), `appendMessage`, `listSessions`/`listMessages` (the web-rendering read shapes, `from_id`→`from`),
and a `getOrCreateGroupSession` left for MNEMO-48. **The handler** (`MnemosyneAgent.onInboundMessage`,
replacing the MNEMO-45 stub) resolves/creates the 1:1 daily session, persists the inbound turn, and DEFERS
the loop+reply onto a DO **alarm** (`this.schedule(0, "runInboundReply", …)`) - an agent loop can exceed
the webhook timeout, so it never runs inline on the gateway's `waitUntil` (PRD §9.3: reply asynchronously;
the alarm survives hibernation). `runInboundReply` (the alarm callback, public like `runScheduled`)
assembles the loop input from the counterparty's RECENT transcript (`in`→user / `out`→assistant
`ModelMessage`s), runs `generateText` over the layered persona + a terse **SMS overlay** (long output links
to the full web thread) + the MNEMO-16 tool catalog, then sends the final text via `src/messaging/reply.ts`
and persists the outbound copy (`fromId: "agent"`); a loop/send failure is audited and SWALLOWED (a
messaging turn never crashes the DO). `reply.ts`'s `sendAgentReply(env, { agentId, fromNumber, to, body,
channel })` GUARDS over-long bodies (`guardBodyLength`: if `countSegments > REPLY_SEGMENT_LIMIT` (4),
truncate and append a short link to the full web thread instead of fanning out costly segments, §9.2), then
constructs the agent's `TwilioSmsChannel` (`fromNumber` = the inbound `to`, the agent's provisioned number)
and `.send()`s - returning the typed `SendResult` (never throws). **Web-rendering read API**
(`src/messaging/routes.ts`, `messagingRoutes()` wired into `src/index.ts` before the `/agents/:agentId/*`
wildcard, behind `requireAuth` + the shared `assertOwnsAgent` guard): `GET
/agents/:agentId/messaging/sessions` (conversation list, newest first, each with
`counterparty`/`channel`/`kind`/`day` + message count) and `GET
/agents/:agentId/messaging/sessions/:sessionId/messages` (one thread, each message with
`from`/`direction`/`channel`/`body`/`ts`) - driven by DO methods `listMessagingSessions()`/
`listMessagingMessages(sessionId)` over native RPC (plain string/number/null shapes, so no structural-cast
bridge). Both responses carry `channel` per session + per message so the UI renders a channel badge (§9.5).
Tests: `test/messaging-persistence.test.ts` (pure `dayKey`; daily bucketing + from/direction/channel
round-trip + ordering against a real DO-SQLite handle) and `test/messaging-onInbound.test.ts` (Workers pool:
inbound persisted→loop-ran-on-body→send-called→outbound persisted via a stubbed model/sandbox + `fetch`,
plus a send-failure-audits-no-crash case and a long-reply truncate+link case).

**Messaging: access control + number provisioning + A2P 10DLC (`src/messaging/`, MNEMO-47):** the
complete **"enable messaging on an agent"** subsystem (PRD §9.1/§9.2/§9.6). Two halves: **access
control** (who the agent answers + at what disclosure tier) and **provisioning** (buying a number +
the shared 10DLC carrier registration). **The capability TIER - not the access list - is the real
safety boundary (§9.6).** `tiers.ts` is the safety model: `CapabilityTier` (`owner` > `known_contact`
> `group_member` > `open_world`), a Zod `AccessDecision` (`{ accept, tier, reason }`), and
`tierConstraints(tier)` → `{ systemConstraint, allowSensitiveTools, allowPrivateMemory }` - `owner`
fully unconstrained; `known_contact` keeps private memory but guards sensitive data; `group_member`
+`open_world` set `allowPrivateMemory:false` (open_world also `allowSensitiveTools:false`, the
safe-default public persona that is the day-one social-engineering guard). `access.ts`'s
`decideAccess(env, { agentId, ownerNumber, from, threadId, openToWorld })` resolves
owner→group→whitelist→open-world→reject (owner matches ONLY a 1:1 with a registered owner number; a
group thread is permissive - ANY member is accepted as `group_member`, since the tier, not acceptance,
guards disclosure); the access LIST gates only acceptance. `expandWhitelistForGroup(env, agentId,
members[])` is the §9.6 **permissive auto-expansion** - pulling a bot into a group whitelists every
member with `scope:'group'` (idempotent), but a group-added contact in a later 1:1 resolves to
`known_contact`, NEVER `owner`; exported for the MNEMO-48 group coordinator. **The whitelist CRUD lives
in `src/db/index.ts`** (`WhitelistRow` + `isWhitelisted`/`addToWhitelist` (idempotent `INSERT OR
IGNORE`)/`listWhitelist`/`removeFromWhitelist`). **Gateway wiring (MNEMO-45):** the inbound gateway now
loads the agent's owner number + open-to-world flag via the DO `getMessagingAccess()` (agent_meta:
`messaging:ownerNumber`/`messaging:openToWorld`, defaults closed - WHITELIST-BY-DEFAULT) and calls
`decideAccess` BEFORE the loop; a rejected message still acks empty TwiML 200 (no Twilio retry) but
hands NOTHING off. On accept the resolved `tier` rides through `onInboundMessage(msg, tier)` → the
`InboundReplyTask` alarm payload → `runInboundReply`, where `tierConstraints(tier).systemConstraint`
is injected into the SMS reply's `buildSystemPrompt` extras (this is where §9.6 capability gating
actually takes effect; `owner` adds nothing, preserving MNEMO-46 1:1 behavior). **Settings API**
(`accessRoutes.ts`, `requireAuth`+`assertOwnsAgent`): `GET/PUT /agents/:id/messaging/access` (the
open-to-world flag + owner number) and `POST/DELETE /agents/:id/messaging/whitelist[/:contactE164]`
(E.164-validated). **Number provisioning** (`provisioning.ts`): `provisionAgentNumber(env, { agentId,
areaCode?, country="US" })` searches Twilio AvailablePhoneNumbers then purchases via
IncomingPhoneNumbers with `SmsUrl` pointed at the gateway (inbound live immediately), persists via
`addAgentNumber` (the new `agent_numbers.twilio_sid` column, migration `0007`), attaches to the shared
campaign best-effort, and returns a typed `{ ok, e164, sid }` - never throws; `releaseAgentNumber`
backs disable (Twilio DELETE by SID + `removeAgentNumber`). **A2P 10DLC** (`a2p.ts`): the brand +
campaign are SHARED org-level resources (one covers many numbers, §9.2) - `ensureBrand`/`ensureCampaign`
(create/submit, idempotent; campaign requires an approved brand), `attachNumberToCampaign`,
`getA2pStatus`, `isA2pReady`. Onboarding is **asynchronous / days-not-minutes** so nothing blocks on
approval; every Twilio A2P call is isolated behind a function marked `// verify against current Twilio
A2P API` (paths shift across API versions). All Twilio REST reuses `TwilioSmsChannel`'s Basic-auth via
the shared `twilioRest.ts` (`twilioApiBase`/`twilioAuthHeader`/`twilioAccountUrl`). **Enable API**
(`manageRoutes.ts`): per-agent opt-in `POST /agents/:id/messaging/enable` (gates on
`isA2pReady(getA2pStatus())` → `409` "10DLC onboarding incomplete" rather than provisioning a throttled
number; the MNEMO-49 billing/entitlement check belongs at this spend boundary), `GET .../status`, `POST
.../disable`, plus org-level `GET /api/a2p/status` + `POST /api/a2p/onboard` (`ensureBrand`/`ensureCampaign`
- admin-guard is a documented extension point, no role model yet). **D1:** `0007_a2p_10dlc.sql` adds
`a2p_brand`/`a2p_campaign` (shared singleton brand keyed `SHARED_BRAND_ID="default"`) + the
`agent_numbers.twilio_sid` column. Tests: `messaging-access` (tier resolution + constraints),
`messaging-group-expansion` (permissive-but-tier-guarded auto-expansion), `messaging-provisioning`
(search/purchase/persist/SmsUrl + failure modes, no throw), `messaging-a2p` (brand/campaign lifecycle +
the enable route's 401/409/200 paths through the full worker); `messaging-gateway` gained an
access-control rejection case.

**Messaging: group threads - `ThreadCoordinator` DO + triage gate + floor control (`src/messaging/`,
MNEMO-48):** closes Track H - multi-agent **group threads** where a message reaches one or more agents
(and humans), every agent SEES every message but RESPONDS only when it has something valuable -
"no pile-on, only signal" (PRD §9.4). Orchestrated by a NEW per-group-thread `ThreadCoordinator` Durable
Object - a DEDICATED `THREAD` binding (`class_name="ThreadCoordinator"`, `new_sqlite_classes` tag `v4`),
one instance per thread via `env.THREAD.idFromName(threadId)` (the same idiom as `AGENT`). It
ORCHESTRATES only - each agent keeps its own DO (identity/memory/tools). `onGroupMessage(GroupInbound)`:
(1) fans the message into EVERY member agent's group session so every agent records the full multi-party
history (`from`+`channel` tags, §9.5) and seeds group access (§9.6); (2) resolves @-mentions → forced
floor winners (a named agent always responds); (3) applies loop-prevention (agent↔agent silence + turn
cap + cooldown); (4) fans the cheap **triage gate** out to the remaining members and collects confidence
bids; (5) picks the floor - mentioned agents always win, then the top `MAX_FLOOR_WINNERS=2` bids by
confidence; (6) invokes each winner's group loop + reply, stamping floor state. Its floor-control state
(`thread_meta` roster + agent-turn counter, `floor_state` per-agent last-spoke, `seen_messages` dedupe)
lives in DO-SQLite via the `src/audit/store.ts` `SCHEMA: string[]` init pattern (idempotent DDL gated by
`blockConcurrencyWhile`, mirroring `AuditLog`). The coordinator's outward calls (record / triage / reply)
are injectable via `test*` override fields for hermetic workers-pool tests. `groupTypes.ts` is the shared
Zod-typed contract (`GroupInbound`/`TriageBid`/`FloorDecision` + the `MAX_FLOOR_WINNERS`/
`TRIAGE_DEBOUNCE_MS`/`MAX_AGENT_TURNS_PER_HUMAN_TURN`/`POST_SPEAK_COOLDOWN_MS` tunables + the
`GroupRecordInput`/`GroupRecordResult`/`GroupReplyInput` agent-DO payloads - kept here so the coordinator
and agent DO share them without a circular import). `mentions.ts` is the PURE @-mention parser
(`parseMentions` - conservative: a token must follow a word boundary so `foo@bar`/a lone `@` never
false-trigger; case-insensitive + punctuation-folded against handle/name/first-word; a mentioned agent
bypasses triage and is always a winner). `loopPrevention.ts` is the PURE §9.4 loop guard: `isFromAgent`
(agent vs. human sender) and `gateAgentTurn` (rule order: HARD turn cap blocks even a mention → post-speak
cooldown → agent-to-agent silence, which a mention overrides). `triage.ts` is the cheap gate: a dedicated
`getTriageModel(env)` resolving the zero-secret Workers AI cheap default (deliberately NOT the per-user
`getModel()` - triage is high-frequency/low-stakes and must stay cheap regardless of an agent's BYOK
profile), ONE `generateText` call (no tools, NOT the agent loop), JSON parsed + Zod-validated into a
`TriageBid`, defaulting to `wantsToRespond:false` on ANY failure (silence-is-safe). **Agent DO
(`MnemosyneAgent`):** `recordGroupMessage` persists into the group session via `getOrCreateGroupSession`
(MNEMO-46; `fromSelf` records the sender's own turn as outbound), runs the §9.6 `expandWhitelistForGroup`
on FIRST sight of a group (once-per-thread), and returns the recent transcript tail for triage;
`replyInGroup` runs the loop as a floor winner under the `group_member` tier (the §9.6 disclosure
constraint injected into the system context) via the shared `deliverReply` helper extracted from
`runInboundReply` - replying over the same async Twilio path; `ThreadCoordinator` is re-exported from
`src/index.ts`. **Gateway (`gateway.ts`):** `groupThreadIdFor` routes a group inbound to the coordinator
(under `waitUntil`, ack still immediate) - it honors a transport's native thread id, else derives a STABLE
id from the sorted participant set (`deriveGroupThreadId`) ONLY when the `MESSAGING_SMS_GROUPS="enabled"`
flag is set (SMS has no native group thread, MNEMO-44 `capabilities.group=false`); 1:1 stays the default.
Tests: `messaging-mentions` + `messaging-loopPrevention` (pure), `messaging-triage` (workers pool, stubbed
cheap model), `messaging-coordinator` (workers pool, real THREAD+AGENT DOs: fan-out history + whitelist
expansion + floor control + @-mention override + agent↔agent silence/turn-cap halt + dedupe).

**SaaS billing, metering & enforcement (`src/billing/`, MNEMO-49):** the public multi-tenant guard
rails (PRD §3/§8.4/§9.2). **Tiers are DECLARATIVE config - `tiers.ts` is the single source of truth**
for every limit (`monthlyCostCapCents`, `maxConcurrentSandboxes`, `includedLlmModel: free|byok`,
`messagingAddonEligible`, `maxAgents`); no call site hard-codes a limit, it reads the resolved `Tier`.
`subscriptions.ts` owns the `subscriptions`/`addons` D1 lifecycle (Zod rows; new migrations
`0010_billing.sql`/`0011_usage.sql`): `getSubscription` (row or synthesized `free` default),
`ensureFreeSubscription` (idempotent - wired into the MNEMO-03 magic-link callback on account
creation), `applyBillingEvent` (the ONLY tier/status writer), and the per-agent messaging add-on
helpers. The PSP is abstracted behind `provider.ts`'s `BillingProvider` interface with a deterministic
`FakeBillingProvider` (tests + `wrangler dev`, no network) and a `StripeBillingProvider` stub (live
calls are marked TODOs); `getBillingProvider(env)` picks fake unless `STRIPE_SECRET_KEY` is set.
`meter.ts` is the **append-only `usage_events` ledger**: `recordUsage` prices an event into
normalized `cost_cents` from the `UNIT_COSTS` table (sandbox-sec/llm-tokens/sms-segment/report -
estimates citing §8.4/§8.5/§9.2) and stamps the `YYYY-MM` period; `getUsageSummary` rolls a period up
into `{ totalCents, byKind }`. **Enforcement** is `limits.ts` (the admission gate) + `concurrency.ts`
(per-account KV sandbox-slot leases in the `LIMITS` namespace - eventually-consistent ⇒ a SOFT cost
bound, not a security boundary): `checkCostCap` (spend vs tier cap, with a `COST_CAP_HEADROOM_CENTS`
buffer), `checkConcurrency` (live leases vs `maxConcurrentSandboxes`), `checkTierFeature("byok"|"messaging")`,
and `admitSandboxRun` composing cost-cap THEN concurrency. **The deliberate policy: FAIL-CLOSED on a
determined cap/limit breach, FAIL-OPEN on an UNKNOWN error** - a metering/KV glitch must never silently
brick a paying user (§8.4). Wired into `MnemosyneAgent`: `runHeadless` admits the run (cost cap +
concurrency, gating concurrency only on a cold boot so an agent's own warm slot can't block its own
re-run) BEFORE booting the sandbox or calling the model - denied ⇒ narrate WHY (audit `error` +
`narration`) and return without booting/invoking; `onChatMessage` gates on the cost cap and streams a
user-facing "cap reached" message instead of calling the model; `resolveModel` forces the free default
when the tier lacks BYOK (MNEMO-13 `getModel(env, accountId, { forceFree })`); `warmSandbox` leases a
slot + stamps boot time on a cold boot and `onSandboxIdle` releases the slot + meters `sandbox_sec` on
teardown; each LLM turn meters `llm_tokens` into the ledger (alongside the MNEMO-14 `llm_spend` write).
HTTP surface `routes.ts` (`billingRoutes()`, account-scoped behind `requireAuth`): `GET
/billing/{subscription,usage,limits}`, `POST /billing/{checkout,cancel}`, `POST /billing/addon/messaging`
(per-agent, gated on `messagingAddonEligible`), plus the deliberately PUBLIC `POST /billing/webhook`
(verifies the provider signature → `applyBillingEvent`). Tests: `billing-meter` + `billing-subscriptions`
(D1), `billing-limits` (D1 + KV), `billing-enforcement-integration` (DO + D1 + KV, sandbox + model
mocked: over-cap ⇒ no boot / no model call / `cost_cap` + audit; within-budget ⇒ boot leases a slot,
`llm_tokens` + `sandbox_sec` metered, slot released on teardown).

**Productionization: observability, errors, abuse controls & deploy (`src/obs/`, `src/errors/`,
`src/abuse/`, MNEMO-50):** the final hardening pass before production traffic (PRD §3/§8.5).
**Observability** (`src/obs/`) is structured JSON logs + light counters, no APM: `logger.ts` emits one
`JSON.stringify` line per event (`{ ts, level, event, ...fields }`) to `console` (Workers → Logpush);
`withContext(base)` binds correlation ids once (returns a scoped `Logger`); `newRequestId()` reuses the
audit `newId()` shape. `metrics.ts`'s `counter`/`timing` are just `event:"metric"` log lines
(`{ metric, value, kind, tags }`) with seed name constants in `METRICS` (research-run lifecycle,
`sandbox_boot_ms`, `llm_call_ms`, `report_generated`, `admission_denied` tagged by MNEMO-49 reason,
`http_5xx`). `requestContext.ts` is mounted **FIRST** in `src/index.ts` (before auth): it mints/honors a
`requestId` (inbound `cf-request-id`/`x-request-id` wins), binds a scoped logger on the context
(`c.var.requestId`/`c.var.log` - added to `AuthVariables`), sets the `x-request-id` response header, and
emits one `http_request` access log on completion; the chat passthrough forwards the same `requestId`
into the DO so DO + audit logs correlate. **Errors** (`src/errors/`): `AppError.ts` is the taxonomy -
base `AppError { httpStatus, code, publicMessage, internalDetail?, retryAfter? }` (publicMessage ALWAYS
safe to return, internalDetail logged NEVER returned) + typed subclasses (`Unauthorized`/`Forbidden`/
`NotFound`/`ValidationError`/`RateLimited`/`CostCapReached`/`ConcurrencyLimited`/`UpstreamError`/
`InternalError`), `admissionToAppError` (maps a denied MNEMO-49 `AdmissionResult` → 402/429/403), and
`toAppError(unknown)` (passes `AppError`, wraps `ZodError`→400, else→500). `handler.ts` is the SINGLE
`onError` (+ `notFound`) wired in `src/index.ts`: normalize → log full detail with `requestId` →
`counter(http_5xx)` on 5xx → safe `{ error: { code, message, requestId } }` (+ `Retry-After` for
`RateLimited`); extracted so `test/errors.test.ts` exercises the real handler. (Existing handlers keep
their explicit `c.json` error returns; new throw-based flow runs through the rate-limit middleware - a
mass refactor of working handlers was deliberately avoided to not churn the ~80 test files.) **Abuse
controls** (`src/abuse/rateLimit.ts`): a declarative fixed-window counter over the `LIMITS` KV -
`RATE_LIMITS` config (`auth_request` 5/15min per-IP, `billing_webhook` 60/min per-IP, `research_start`/
`build`/`messaging_send` per-account), `rateLimit(env,{bucket,key})` (key `rl:<bucket>:<key>:<window>`,
TTL self-clean, **fails OPEN** on a KV fault), and `rateLimitMiddleware(bucket, keyFn)` (throws
`RateLimited` → onError → 429+`Retry-After`); `byIp`/`byAccount` keyers. Applied on `POST /auth/request`
+ `POST /billing/webhook` (per-IP) and Discovery start + `POST /agents/:id/build` + the chat/research
turn (per-account, after `requireAuth`); messaging-send has a documented seam until a user-facing send
endpoint lands. **Release model:** two Wrangler **environments** in `wrangler.toml` (`[env.staging]` =
`mnemosyne-staging`, `[env.production]` = `mnemosyne`) with **NO SHARED STATE** - each redeclares all
bindings with distinct D1/KV/R2 ids+names (placeholders + create-commands); the top-level config stays
the local/test target; `ENVIRONMENT` (already on `Env`, MNEMO-27) gates the dev cron trigger routes
(`src/schedule/dev-routes.ts` 404s them per-request when `=== "production"`, so they are inert in prod -
the correct Workers pattern since env isn't available at module load). **Secrets** are enumerated in
`SECRETS.md` (the single source of truth - purpose + phase + exact `wrangler secret put <NAME> --env`
per secret; vars stay in `wrangler.toml`, never here) and verified by `scripts/check-secrets.ts` (npm
`check:secrets`, runs `wrangler secret list`, exits non-zero listing any missing). **Release scripts**
(`package.json`): `migrate:remote`/`migrate:staging`/`migrate:prod`, `deploy:staging`/`deploy:prod`, and
composite `release:staging`/`release:prod` running `typecheck → test → lint → check:secrets → migrate →
deploy` (fail-fast; **migrations BEFORE deploy** so new code never hits an un-migrated schema). **CI**
(`.github/workflows/ci.yml`): PR → checks only; push to default branch → checks + `release:staging`;
published release/`v*` tag → `release:prod` (a `CLOUDFLARE_API_TOKEN` Actions secret, never echoed).
**Runbook** in `docs/RELEASE.md` (first-time env setup, normal flow, manual release, post-deploy
verification incl. confirming cron fires per §8.5, and the forward-only-migration rollback discipline =
code-only re-deploy ⇒ migrations must stay backward-compatible). Tests: `test/errors.test.ts`,
`test/abuse-ratelimit.test.ts`, `test/obs.test.ts` (all Workers-pool), and `test/release-config.test.ts`
(plain node - parses `wrangler.toml`/`SECRETS.md`/`check-secrets.ts`; excluded from the vitest pool +
tsconfig like the other node tests, run via `npm run test:release`).

## Conventions

Until the project establishes its own, **mirror the Crema patterns** documented in the reference:

- **One DO instance per entity** via `env.<BINDING>.idFromName(<stableId>)` - no allocation logic.
- **Thread auth through hibernation:** capture the token on connect, persist to DO storage,
  rehydrate on wake. Forge a token for headless/cron paths.
- **Tools return typed results;** end background loops with a terminator tool whose `inputSchema`
  is the result schema.
- **Provider-agnostic LLM access** through a single resolver; never hardcode a model deep in code.
- **Safety rails are not optional:** time-box and size-cap outbound HTTP, draft-don't-send for any
  outbound action, scope every tool to the calling user's identity.

The **tools-over-own-API** question is an open architectural decision - see the reference doc's
trade-off section. Do not assume; confirm before committing to it.

## Writing style: never use the em-dash (hard rule)

**The em-dash (Unicode U+2014, "EM DASH") is banned everywhere in this project.** It must not appear
in code, comments, string literals, UI copy, docs, commit messages, or any content an agent generates
at runtime (reports, emails, system prompts, chat replies). The em-dash is a tell of machine-written
text and every byte we ship or commit must read as human-written. (This file deliberately names the
character by codepoint instead of printing the glyph, so the project stays 100% glyph-free.)

- For the parenthetical / aside use, write a spaced hyphen (` - `), a comma, parentheses, or just
  rewrite the sentence. For compounds, use a plain hyphen (`-`).
- Also avoid the en-dash (U+2013, "EN DASH"); prefer a plain hyphen there too.
- The whole corpus was scrubbed once; keep it clean. Before committing, this must return nothing:
  `rg $'\u2014' src test frontend/src migrations docs *.md` (the shell expands the escape to the EM DASH glyph).
- If you are writing or editing an agent system prompt or report template, state the same
  constraint to the model so generated output stays em-dash-free.

## Build / test / deploy

TypeScript ESM, source under `src/`, tests under `test/`; intra-repo imports use explicit `.ts`
extensions (`allowImportingTsExtensions`). npm scripts:

- `npm run dev` - `wrangler dev` (local Worker)
- `npm run deploy` - `wrangler deploy`
- `npm run migrate:local` - `wrangler d1 migrations apply mnemosyne --local` (applies
  `migrations/` to the local D1 in `.wrangler/state`). Tests apply migrations automatically
  via the `test/apply-migrations.ts` setupFile, so this is just for `wrangler dev`.
- `npm run typecheck` - `tsc --noEmit`
- `npm run test` / `test:watch` - vitest in the Cloudflare Workers pool (Miniflare); reads
  `wrangler.toml`. Tests run *inside* workerd - import bindings from `cloudflare:workers`.
- `npm run test:audit` / `test:memory` / `test:retrieval` - the `node:sqlite` suites
  (`src/audit/store`, `src/memory/graph-index`, `src/memory/graph-retrieval`) via
  `node --experimental-sqlite --test`. Deliberately **excluded** from the vitest pool in
  `vitest.config.ts` - workerd has no `node:sqlite`; keep node-runtime suites out of the pool.
- `npm run test:release` - `node --test` over `wrangler.toml`/`SECRETS.md`/`check-secrets.ts`
  (plain file parsing; excluded from the pool + tsconfig like the other node suites).
- `npm run lint` - `biome check .` (recommended rules, 2-space indent). Biome is scoped to
  `src/`, `test/`, and root configs - **never** run `biome check --write` against the repo root
  unscoped; it will reformat the read-only `_crema-crm/` clone.

## Testing

**Tests are part of the change, not a follow-up.** Every PR-sized change ships with tests:
a new route/DO method/service/tool gets a test that drives it; a bug fix gets a regression test
that fails before the fix; a changed contract updates the test that pins it. Tests must be
**meaningful, not padding** - assert observable behavior (status, body, persisted state, emitted
audit), not that a line ran. Delete or fix a test that no longer reflects intended behavior rather
than leaving it red or `.skip`-ped. The `release:staging`/`release:prod` scripts gate on
`typecheck && test && lint`, so a red suite blocks deploy.

**Three runtimes, by necessity (backend):**
- **vitest + `@cloudflare/vitest-pool-workers`** (Miniflare/workerd) - the bulk of `test/`. Tests
  run *inside* workerd; import bindings from `cloudflare:workers`, helpers from `cloudflare:test`.
- **`node:sqlite` suites** - `graph-index` / `graph-retrieval` / `audit-store`, run via
  `test:memory` / `test:retrieval` / `test:audit` (workerd lacks `node:sqlite`).
- **`test:release`** - plain-Node config parsing.
The frontend is its own vitest + jsdom suite (run from `frontend/`); see [Frontend](#frontend).

**Test layers + the mock seams** (the Workers pool can't host an LLM or a container, so two
injection points keep DO tests hermetic without module mocking):
- **Unit** - pure logic and single DO methods via `runInDurableObject` (e.g. `build-do`, `memory-write`).
- **HTTP integration** - drive the *real* worker: seed an account + KV session
  (`createAccount` + `createSession`/`SESSION_COOKIE`), then `worker.fetch` through
  `createExecutionContext`/`waitOnExecutionContext`. This is how the route layer (auth, ownership
  404, Zod 400) is covered - see `agents-routes`, `audit-api`, `brain-routes`.
- **`MnemosyneAgent.testModelOverride`** ← `test/mock-model.ts` (deterministic `ai`-SDK models:
  `generateModel`, `streamingModel`, `toolThenTerminatorModel`, …).
- **`MnemosyneAgent.testSandboxOverride`** ← `test/stub-sandbox.ts` (`makeStubSandbox` - a recording
  `SandboxLike`; program results with `onRun`/`onRead`). For an HTTP route whose DO method warms the
  sandbox, inject the stub onto the live instance via `runInDurableObject(... a.testSandboxOverride = …)`
  *before* the `worker.fetch` (same DO id → same instance), as in `brain-routes`.
- **E2E** - `test/e2e-agent-lifecycle.test.ts` threads the spine (create → build → operational →
  research run → audit + brain read back over HTTP → owner-only) through the real worker + DOs,
  mocking only the model + sandbox. Add an E2E when a NEW cross-subsystem path needs proof that the
  stages connect; per-subsystem behavior belongs in the unit/integration layers.

**Coverage** (~80% line floor on both suites; raise it, don't regress it):
- Backend: `--coverage.provider=istanbul` (v8 fails in workerd - no `node:inspector`), then
  `node scripts/merge-coverage.mjs coverage/lcov.info <node-sqlite-lcov>` folds in the excluded
  `node:sqlite` suites' coverage for one honest number (see `scripts/merge-coverage.mjs` header).
- Frontend: `--coverage.provider=v8`.
- RTK mangles vitest stdout - prefix coverage runs with `rtk proxy` and read the summary/lcov file.

## Frontend

The web client is a **separate package** in `frontend/` (React 18 + Vite + TypeScript, ESM, its own
`package.json` - distinct from the Worker root). Built in **MNEMO-32**; all feature screens land in
MNEMO-33+. Run npm scripts from inside `frontend/` (not the repo root).

- **Layout:** `src/api/` (auth-aware `apiFetch` client + `ApiError` - transport only, no endpoint
  code), `src/styles/` (design tokens + `global.css`), `src/components/ui/` (the shared component
  library), `src/pages/` (route-level screens; `src/pages/dev/Components.tsx` is the catalog).
  Path alias `@/*` → `src/*`. React function components + hooks only; keep modules < 500 lines.
- **Design tokens are the single source of truth.** `src/styles/tokens.css` declares *every* color
  role, space, font, radius, shadow, z-index, breakpoint, and motion value as CSS custom properties
  (typed mirror in `tokens.ts`). Components reference `var(--token)` only - **never** hardcode a
  visual value. Dark skin = the `[data-theme="dark"]` block; reskin = swap tokens, no component edits.
- **The shared component library + tokens are MANDATORY for all feature screens.** Import UI only
  from `@/components/ui`; compose those primitives - **no bespoke one-off controls**. A missing
  primitive is added to `components/ui/` (with a catalog entry) and consumed from there. **Lint-
  enforced:** Biome's `noRestrictedElements` bans raw `<button>/<input>/<select>/<textarea>/<a>`
  everywhere under `src/` except inside `components/ui/`. See `frontend/src/components/ui/README.md`
  for the full reuse contract, and `/dev/components` (dev builds only) for the living style guide.
- **Dev server proxy:** `vite.config.ts` proxies `/api`, `/auth`, `/agents` → `http://localhost:8787`
  (run `wrangler dev` at the repo root alongside `frontend/`'s `npm run dev`).
- **Testing:** vitest + jsdom + `@testing-library/react` (NOT the Workers pool - this is the browser
  client). Setup in `src/test/setup.ts` (jest-dom matchers + `afterEach(cleanup)`).
- **Scripts (in `frontend/`):** `dev` (vite), `build` (`tsc -b && vite build`), `preview`,
  `test` / `test:watch` (vitest), `typecheck` (`tsc --noEmit`), `lint` (`biome check .`).

## Working agreements

- Files may only be written within this working directory (`/Users/pedram/Projects/Mnemosyne`)
  and the Auto Run folder. Reads anywhere are fine.
- Disagree with bad ideas and justify with reasoning - no sycophancy, no hand-holding.
- Prefer extending/composing existing code over duplicating helpers.

## Open questions

Core job is **resolved** (research-agent platform - see [What this is](#what-this-is)). The live
decisions now live in **`docs/PRD.md` §9** - do not duplicate them here; that list is the source of
truth. The ones that gate scaffolding:

- **Audience & scale:** public multi-tenant SaaS vs. personal/invite-only (drives billing, abuse
  controls, per-user cost caps).
- **Container model:** ephemeral sandbox-per-session + R2-persisted brain (recommended) vs. a
  long-lived container per agent (cost driver).
- **Tools-over-own-API vs. a direct shared service layer** - likely a direct service layer here,
  since the surface is a memory store, not a rich API. Decide before wiring tools.
