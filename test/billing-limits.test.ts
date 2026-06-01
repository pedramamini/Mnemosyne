import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  acquireSandboxSlot,
  countActiveSlots,
  releaseSandboxSlot,
} from "../src/billing/concurrency.ts";
import {
  admitSandboxRun,
  checkConcurrency,
  checkCostCap,
} from "../src/billing/limits.ts";
import { recordUsage } from "../src/billing/meter.ts";
import { applyBillingEvent } from "../src/billing/subscriptions.ts";
import { TIERS } from "../src/billing/tiers.ts";
import { createAccount } from "../src/db/index.ts";

// MNEMO-49: the admission gate (D1 cost cap + KV concurrency). Seeds usage_events
// + KV leases against the declarative tier limits and asserts the gate decisions.

async function seedAccount(): Promise<string> {
  const account = await createAccount(env, {
    email: `limits-${crypto.randomUUID()}@example.com`,
  });
  return account.id;
}

/** Seed `cents` of current-period spend (1¢/sms_segment → quantity == cents). */
async function seedSpendCents(accountId: string, cents: number): Promise<void> {
  await recordUsage(env, { accountId, kind: "sms_segment", quantity: cents });
}

describe("checkCostCap", () => {
  it("allows comfortably under the cap and denies at/over it", async () => {
    const accountId = await seedAccount();

    // Well under the free cap (200¢, less a 25¢ headroom → 175¢ ceiling).
    await seedSpendCents(accountId, 50);
    const under = await checkCostCap(env, accountId);
    expect(under.allowed).toBe(true);

    // Push spend to the cap → denied with reason cost_cap.
    await seedSpendCents(accountId, 150); // total 200¢ ≥ ceiling
    const over = await checkCostCap(env, accountId);
    expect(over.allowed).toBe(false);
    expect(over.reason).toBe("cost_cap");
  });

  it("allows the same spend on a higher-cap (pro) tier", async () => {
    const accountId = await seedAccount();
    await applyBillingEvent(env, {
      type: "subscription.activated",
      accountId,
      tier: "pro",
    });
    // 200¢ would breach free, but pro's cap (5000¢) leaves ample headroom.
    await seedSpendCents(accountId, 200);
    const result = await checkCostCap(env, accountId);
    expect(result.allowed).toBe(true);
  });
});

describe("concurrency leasing", () => {
  it("leases up to maxConcurrent then denies, and frees a slot on release", async () => {
    const accountId = await seedAccount();
    const max = 2;

    const a = await acquireSandboxSlot(env, accountId, max);
    const b = await acquireSandboxSlot(env, accountId, max);
    expect(a.leased).toBe(true);
    expect(b.leased).toBe(true);
    expect(await countActiveSlots(env, accountId)).toBe(2);

    // At the ceiling → denied.
    const c = await acquireSandboxSlot(env, accountId, max);
    expect(c.leased).toBe(false);

    // Release one → a slot frees up and a new lease succeeds.
    await releaseSandboxSlot(env, accountId, a.leaseId as string);
    expect(await countActiveSlots(env, accountId)).toBe(1);
    const d = await acquireSandboxSlot(env, accountId, max);
    expect(d.leased).toBe(true);
    expect(await countActiveSlots(env, accountId)).toBe(2);
  });
});

describe("checkConcurrency + admitSandboxRun composition", () => {
  it("checkConcurrency denies once the free tier's single slot is held", async () => {
    const accountId = await seedAccount();
    const max = TIERS.free.maxConcurrentSandboxes; // 1

    expect((await checkConcurrency(env, accountId)).allowed).toBe(true);
    await acquireSandboxSlot(env, accountId, max);
    const denied = await checkConcurrency(env, accountId);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("concurrency");
  });

  it("admitSandboxRun composes cost cap THEN concurrency with the right reason", async () => {
    // Clean account → allowed.
    const ok = await seedAccount();
    expect((await admitSandboxRun(env, ok)).allowed).toBe(true);

    // Over cap → denied with cost_cap (checked first).
    const capped = await seedAccount();
    await seedSpendCents(capped, 250);
    const cappedResult = await admitSandboxRun(env, capped);
    expect(cappedResult.allowed).toBe(false);
    expect(cappedResult.reason).toBe("cost_cap");

    // Under cap but at the concurrency ceiling → denied with concurrency.
    const busy = await seedAccount();
    await acquireSandboxSlot(env, busy, TIERS.free.maxConcurrentSandboxes);
    const busyResult = await admitSandboxRun(env, busy);
    expect(busyResult.allowed).toBe(false);
    expect(busyResult.reason).toBe("concurrency");
  });
});
