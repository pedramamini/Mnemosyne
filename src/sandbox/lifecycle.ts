/**
 * Warm-on-activity / idle-down lifecycle for a per-agent sandbox (PRD §8.4).
 *
 * The sandbox is the product's largest cost lever: billing is active-time only,
 * so a container left running burns money. The rule is simple - warm it when the
 * agent acts, and release it promptly once it's been idle. This module is PURE
 * logic over the client + persistence layers; it does NOT own the timer. The DO
 * does (MnemosyneAgent, next task), because the DO is the always-cheap home that
 * survives hibernation and can re-arm the idle alarm across wakes.
 *
 * Cold vs warm: `getSandbox` always returns a handle (the container is created
 * lazily by the SDK), so "was it cold?" is answered by a marker file in the FS.
 * On a cold start the brain tree is empty, so we rehydrate from R2 first, then
 * drop the marker. Subsequent warms see the marker and skip the (costly) restore.
 */

import type { Env } from "../env.ts";
import { initBrainRepo } from "../memory/git.ts";
import { getSandbox, type SandboxClient } from "./client.ts";
import { BRAIN_ROOT, persistToR2, restoreFromR2 } from "./persistence.ts";

/**
 * Idle window before the DO releases the container. A few minutes balances
 * responsiveness (a follow-up turn reuses the warm container) against cost -
 * prompt idle-down is the PRIMARY cost control (PRD §8.4). Exported so the DO's
 * idle alarm and tests share one source of truth.
 */
export const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Marker file proving the brain FS is hydrated; absent == cold container. */
const WARM_MARKER = `${BRAIN_ROOT}/.mnemosyne-warm`;

/**
 * Cold-boot transport faults the Sandbox SDK throws while the container is still
 * coming up (the first subrequest races the boot). They are NOT command failures
 * - the process never ran - so the FIRST contact (`ensureWarm`'s probe) retries
 * past them rather than surfacing a 500 on a user's first turn. Matched on message
 * substrings because the Beta SDK (PRD §8.1) doesn't expose typed boot errors.
 */
const COLD_BOOT_FAULTS = [
  "network connection lost",
  "internal error",
  "not ready",
  "starting",
  "no such container",
  "connection refused",
  "econnrefused",
];

/** True when `err` looks like a transient container-boot fault (worth retrying). */
function isColdBootFault(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return COLD_BOOT_FAULTS.some((p) => msg.includes(p));
}

/**
 * Run the warm probe, retrying ONLY transient boot faults with capped backoff
 * (~6s total over 6 tries). A cold container's first subrequest can land before
 * the runtime is listening; without this the user's first chat turn 500s with
 * "Network connection lost" even though a moment later the box is healthy. The
 * probe is idempotent (`test -f`), so retrying is safe. A non-boot error (or
 * exhausted retries) propagates unchanged.
 */
async function probeUntilReady(
  sandbox: SandboxClient,
  cmd: string,
  maxAttempts = 6,
): Promise<{ stdout: string }> {
  let delayMs = 300;
  for (let attempt = 1; ; attempt++) {
    try {
      return await sandbox.run(cmd);
    } catch (err) {
      if (attempt >= maxAttempts || !isColdBootFault(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 2000);
    }
  }
}

/** Minimal activity state the DO persists (to DO storage) across hibernation. */
export interface ActivityState {
  /** Epoch ms of the last agent activity; drives the idle decision. */
  lastActivityTs: number;
}

/** Stamp the current time as the latest activity (pure; DO persists the result). */
export function touchActivity(state: ActivityState): ActivityState {
  return { ...state, lastActivityTs: Date.now() };
}

/** Outcome of {@link ensureWarm}: the ready handle + whether this was a cold start. */
export interface WarmResult {
  sandbox: SandboxClient;
  /** True when the container had to be hydrated this call (cold start). */
  coldStart: boolean;
}

/**
 * Get-or-create the agent's sandbox and guarantee its brain FS is hydrated.
 * On a cold container (no warm marker) we restore the latest snapshot from R2
 * and drop the marker so later warms skip the restore. Returns a ready handle.
 *
 * The `sandbox` param is injectable for tests (the workers-pool env can't boot a
 * real container); production callers pass two args and get the live handle.
 */
export async function ensureWarm(
  env: Env,
  agentId: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<WarmResult> {
  // One subrequest to probe the marker; `cold` unless it prints exactly "warm".
  // This is the FIRST contact with the container, so it absorbs the cold-boot
  // race (retries transient transport faults until the runtime is listening).
  const probe = await probeUntilReady(
    sandbox,
    `test -f ${WARM_MARKER} && echo warm || echo cold`,
  );
  const coldStart = probe.stdout.trim() !== "warm";

  if (coldStart) {
    await restoreFromR2(env, agentId, sandbox);
    // Ensure the root exists even on a first-ever wake (nothing in R2), then mark.
    await sandbox.mkdir(BRAIN_ROOT);
    // Lay down the brain layout + git repo (MNEMO-07) - the natural-fit
    // versioning of PRD §6.9. Idempotent: restore-from-R2 carries the `.git`
    // directory across sleeps (git history persists because the whole tree
    // persists to R2), so on a restored brain this no-ops; on a first-ever or
    // pre-MNEMO-07 brain it initializes the repo.
    await initBrainRepo(env, agentId, sandbox);
    await sandbox.run(`touch ${WARM_MARKER}`);
  }

  return { sandbox, coldStart };
}

/**
 * Idle-down: persist the brain to R2, then stop/release the container so billing
 * stops (active-time only, §8.4). Persist BEFORE stop - the FS is gone once the
 * container is released. Called by the DO's idle alarm after IDLE_TIMEOUT_MS of
 * no activity; the `sandbox` param stays injectable for tests.
 */
export async function idleDown(
  env: Env,
  agentId: string,
  sandbox: SandboxClient = getSandbox(env, agentId),
): Promise<void> {
  await persistToR2(env, agentId, sandbox);
  await sandbox.stop();
}
