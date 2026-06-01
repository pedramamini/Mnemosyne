/**
 * Per-account sandbox-slot leasing (MNEMO-49) - the concurrency half of the §8.4
 * cost guard. Each live container holds a lease key in the `LIMITS` KV namespace;
 * the admission gate counts leases to decide whether another sandbox may boot.
 *
 * IMPORTANT: KV is EVENTUALLY CONSISTENT, so this is a SOFT cost bound, not a
 * security boundary - two racing boots could both observe "under max" and both
 * lease (briefly over-provisioning). That is acceptable: the real isolation
 * boundary is the per-agent sandbox (PRD §7.3); this only bounds COST. Each lease
 * carries a ~30-minute TTL so a crashed agent that never releases its slot can't
 * wedge an account's concurrency forever.
 */
import type { Env } from "../env.ts";

/** Safety TTL on a lease (seconds): a slot a crashed run never releases self-heals. */
export const LEASE_TTL_SECONDS = 30 * 60;

/** KV key for one lease. Listed by the `lease:<accountId>:` prefix to count slots. */
function leaseKey(accountId: string, leaseId: string): string {
  return `lease:${accountId}:${leaseId}`;
}

/** The list prefix covering all of an account's leases. */
function leasePrefix(accountId: string): string {
  return `lease:${accountId}:`;
}

/** Outcome of {@link acquireSandboxSlot}. */
export interface SlotLease {
  /** True when a slot was leased (account was under `maxConcurrent`). */
  leased: boolean;
  /** The lease id to release later - present only when `leased`. */
  leaseId?: string;
}

/**
 * Count an account's currently-leased sandbox slots (live container count). A KV
 * prefix list; cursor-paged so it stays correct past the per-page key cap.
 */
export async function countActiveSlots(
  env: Env,
  accountId: string,
): Promise<number> {
  const prefix = leasePrefix(accountId);
  let count = 0;
  let cursor: string | undefined;
  // Page through; concurrency is small (single-digit caps), so this is one page
  // in practice, but the loop keeps the count correct if a TTL backlog builds up.
  do {
    const page = await env.LIMITS.list({ prefix, cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return count;
}

/**
 * Try to lease a sandbox slot for `accountId`: count active leases and, if BELOW
 * `maxConcurrent`, store a fresh `lease:<accountId>:<leaseId>` key (TTL-expiring)
 * and return its id; otherwise return `{ leased: false }`. The read-then-write is
 * NOT atomic (KV has no CAS) - see the module note: a soft bound, not a hard one.
 */
export async function acquireSandboxSlot(
  env: Env,
  accountId: string,
  maxConcurrent: number,
): Promise<SlotLease> {
  const active = await countActiveSlots(env, accountId);
  if (active >= maxConcurrent) return { leased: false };

  const leaseId = crypto.randomUUID();
  await env.LIMITS.put(leaseKey(accountId, leaseId), String(Date.now()), {
    expirationTtl: LEASE_TTL_SECONDS,
  });
  return { leased: true, leaseId };
}

/** Release a previously-acquired slot (delete the lease key). No-op if absent. */
export async function releaseSandboxSlot(
  env: Env,
  accountId: string,
  leaseId: string,
): Promise<void> {
  await env.LIMITS.delete(leaseKey(accountId, leaseId));
}
