# MNEMO-06 — Sandbox & Brain: Sandbox provisioning & lifecycle

Phase 6 (see `MNEMO-00-ROADMAP.md`). Goal: give each agent its computer — a per-agent Cloudflare
Sandbox (isolated Linux container) with command-run / `readFile` / `writeFile` wrappers, a
warm-on-activity / idle-down lifecycle driven from the DO, R2-backed persistence across sleeps, and
snapshot/restore for recovery. This is the FS layer plain Workers/DOs cannot provide and the largest
cost lever in the product. Depends on MNEMO-04 (the `MnemosyneAgent` DO that owns lifecycle + holds
the warm/idle timer state). Per `docs/PRD.md` v0.5 §7.3 (sandbox = the agent's computer, one per
agent, complete isolation, run-command/`readFile`/`writeFile`, Code Interpreter later), §8.1
(Sandboxes GA April 2026; SDK docs still carry a "Beta" header — *do not pin business-critical
behavior to an undocumented method without a test*), §8.4 (DO is always-cheap home; sandbox is
warm-on-activity / idle-down; FS persists to R2; billing is active-time only — idle promptly).

Conventions: one sandbox per agent, addressed by the same `idFromName(agentId)` idiom as the DO so
they map 1:1 (§8.1). All sandbox access goes through a single wrapper module so later phases (brain
FS in MNEMO-07, tools in Track C, Code Interpreter in MNEMO-23) never talk to the raw SDK. The
wrapper is defensive about the Beta SDK surface: every method is feature-detected / try-caught and
has a test. Respect the subrequest cap (1,000/request on Paid — each command-run / `readFile` /
`writeFile` is one; §8.5). The sandbox is the cost center, so the DO must idle it down promptly after
inactivity.

- [x] In `wrangler.toml`, add the Cloudflare Sandbox binding and container config per the Sandbox SDK: install the Sandbox SDK package (e.g. `@cloudflare/sandbox`) as a runtime dep; add the `[[containers]]` / Durable-Object-backed binding the SDK requires (name `SANDBOX`), choosing a small instance type to control cost (§8.4), and add a `[[migrations]]` entry if the SDK ships a DO class that must be declared. Add `SANDBOX: DurableObjectNamespace` (or the SDK's binding type) to the `Env` interface in `src/env.ts` with a `// MNEMO-06` comment. Also add an R2 bucket binding `BRAIN_BUCKET` (placeholder id, `# wrangler r2 bucket create mnemosyne-brains` comment) and `BRAIN_BUCKET: R2Bucket` to `Env` — this is the durable layer the FS persists to.

- [x] Create `src/sandbox/client.ts`: a thin typed wrapper over the Sandbox SDK. Export `getSandbox(env, agentId)` returning a handle keyed by `idFromName(agentId)` (one sandbox per agent, §8.1), and async methods `run(cmd, opts?)` → `{ stdout, stderr, exitCode }` (delegating to the SDK's command-execution method), `readFile(path)` → string, `writeFile(path, contents)` → void, `mkdir(path)`. Every method wraps the raw SDK call in try/catch and normalizes errors to a typed `SandboxError` (the SDK is Beta — §8.1 — so isolate it here). Add a clear comment block citing PRD §7.3/§8.1 and listing exactly which SDK methods are used, so the Beta surface is auditable in one place.

- [x] Create `src/sandbox/persistence.ts`: the R2-backed durability layer (§8.4 — FS persists to R2 across sleeps). Export `persistToR2(env, agentId, sandbox)` that archives the sandbox's working tree (e.g. `tar` via the wrapper's `run` to a temp path, then `readFile` the archive and `BRAIN_BUCKET.put(\`brains/<agentId>/snapshot.tar\`, ...)`) and `restoreFromR2(env, agentId, sandbox)` that fetches the latest archive from R2, writes it into the fresh sandbox, and unpacks it via `run`. Key R2 objects under `brains/<agentId>/`. Add a `snapshotKey(agentId, label?)` helper so MNEMO-12 versioning and recovery snapshots can coexist (e.g. `snapshots/<agentId>/<label>.tar`). Use R2 object versioning as the coarse backstop noted in PRD §6.9; the fine-grained per-file diff/restore is git (MNEMO-07/12).

- [x] Create `src/sandbox/lifecycle.ts`: the warm-on-activity / idle-down state machine (§8.4). Export `ensureWarm(env, agentId)` — get-or-create the sandbox, and if it was cold, call `restoreFromR2` to rehydrate the FS; returns a ready handle. Export `touchActivity(state)` and `idleDown(env, agentId)` — `idleDown` persists to R2 (`persistToR2`) then stops/releases the container so billing stops (active-time-only, §8.4). Define an `IDLE_TIMEOUT_MS` constant (e.g. a few minutes) with a comment that prompt idle-down is the primary cost control. This module is pure logic over the client/persistence layers; the DO owns the timer (next task).

- [x] Wire lifecycle into `src/agent/MnemosyneAgent.ts` (MNEMO-04): add `private async warmSandbox()` that calls `ensureWarm(this.env, this.agentId)` and records last-activity, and schedule an idle-down via the `agents` SDK scheduler (`this.schedule(...)`, which survives hibernation — `docs/crema-architecture-reference.md` §8) so that after `IDLE_TIMEOUT_MS` of no activity the DO calls `idleDown`. Add a comment that the DO is the always-cheap home (PRD §7.4) and only *it* (not request handlers) owns sandbox lifecycle, so a sandbox is never left running. Do not call the LLM loop here — just expose `warmSandbox()` and the idle alarm. Persist `lastActivityTs` to DO storage so the decision survives hibernation.

- [x] Add a debug route in `src/index.ts` (behind `requireAuth`, ownership-checked via the MNEMO-05 service) `POST /agents/:agentId/sandbox/run` that forwards `{ cmd }` to the DO, which calls `warmSandbox()` then the client wrapper's `run(cmd)` and returns `{ stdout, stderr, exitCode }`. This is the end-to-end proof that the worker → DO → sandbox path works. Cap `cmd` length and add a comment that real tool execution is gated behind the harness/tool framework (Track C) — this route is a provisioning smoke test, not the agent interface.

- [x] Create `test/sandbox-client.test.ts` (vitest workers pool): test the wrapper's error normalization and method surface — `writeFile` then `readFile` round-trips a file; `run("echo hi")` returns `stdout` containing `hi` and `exitCode 0`; a failing command surfaces a non-zero `exitCode`; an SDK error path is normalized to `SandboxError`. If the workers-pool test environment cannot start a real container, write the test against a mockable `SandboxLike` interface that `src/sandbox/client.ts` accepts (inject the SDK handle) and assert the wrapper logic; add a `// SDK is Beta (PRD §8.1) — verified against the real container in the manual checkpoint` comment. Keep code and test split: do not change `client.ts` behavior to satisfy the test beyond making the handle injectable.

- [x] Create `test/sandbox-persistence.test.ts` (vitest workers pool, R2 bucket configured): using the injectable `SandboxLike` handle, test that `persistToR2` puts an object under `brains/<agentId>/snapshot.tar` and `restoreFromR2` reads it back and feeds it into the sandbox restore path; assert the R2 key shape from `snapshotKey`. Test `ensureWarm` calls `restoreFromR2` only on a cold start. Run `npm run test`, `npm run typecheck`, and `npm run lint`; fix until all pass and report output.

---

## Completion notes (MNEMO-06)

All 8 tasks complete. **40/40 tests pass (7 files), `tsc --noEmit` clean, `biome check .` clean.**

- **Bindings (`wrangler.toml` + `src/env.ts`):** installed `@cloudflare/sandbox@0.10.2` as a runtime dep. Added the `SANDBOX` Durable-Object binding (`class_name = "Sandbox"`, the SDK's container DO, re-exported from `src/index.ts`), a `[[containers]]` block (`image = docker.io/cloudflare/sandbox:0.10.2`, `instance_type = "basic"` as the cost lever, `max_instances = 5`), and the `[[migrations]]` tag `v2` (`new_sqlite_classes = ["Sandbox"]`). Added the `BRAIN_BUCKET` R2 bucket (`mnemosyne-brains`). Both typed into `Env`.
- **`src/sandbox/client.ts`:** `getSandbox(env, agentId)` (keyed by `idFromName`, 1:1 with the DO) + `SandboxClient` wrapper (`run`/`readFile`/`writeFile`/`mkdir`/`stop`). Every SDK call is try/caught and normalized to a typed `SandboxError` tagged with the op. Split from its handle (`SandboxLike`) so it's testable without a real container. A non-zero exit is **returned**, not thrown; only transport/SDK failures throw.
- **`src/sandbox/persistence.ts`:** `persistToR2` / `restoreFromR2` keyed under `brains/<agentId>/`, plus `snapshotKey(agentId, label?)` so MNEMO-12 versioned snapshots (`snapshots/<agentId>/<label>.tar`) coexist. Archive is `tar|gzip|base64` to a sidecar text file so it round-trips losslessly through the deliberately text-only wrapper (binary streaming is a later concern). R2 object versioning noted as the §6.9 backstop.
- **`src/sandbox/lifecycle.ts`:** `ensureWarm` (cold-start detection via a `/brain/.mnemosyne-warm` marker → restore from R2 only when cold), `touchActivity`, `idleDown` (persist-then-stop), and `IDLE_TIMEOUT_MS = 5min`. Pure logic over client/persistence; sandbox handle injectable for tests.
- **`src/agent/MnemosyneAgent.ts`:** `warmSandbox()` + `runSandboxCommand(cmd)`; idle-down armed via `this.schedule(..., "onSandboxIdle")` (survives hibernation). `lastActivityTs` + the pending alarm id persist to DO-SQLite so the idle decision survives hibernation; the alarm re-arms if activity landed after it was set. DO is the sole lifecycle owner (PRD §7.4).
- **`src/index.ts`:** `POST /agents/:agentId/sandbox/run` (behind `requireAuth`, ownership-checked via the MNEMO-05 `getAgentOwned` service → 404 for non-owned, no existence leak), `cmd` capped at 4096 chars; forwards to the DO's `runSandboxCommand`. Provisioning smoke test only — real tool execution is gated behind Track C.

> **Manual checkpoint (not blocking):** the Sandbox SDK still carries a "Beta" header (PRD §8.1). Tests run against an injected `SandboxLike` mock because the workers-pool env can't boot a container. Verify `run`/`readFile`/`writeFile`/`mkdir`/`destroy` and the tar/base64 persist↔restore round-trip against a **real** deployed container, and confirm `instance_type = "basic"` boots the image (bump to `standard` if it OOMs).
