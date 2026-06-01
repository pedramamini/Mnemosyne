import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkTierFeature } from "../src/billing/limits.ts";
import {
  addMessagingAddon,
  applyBillingEvent,
  ensureFreeSubscription,
  getSubscription,
  hasMessagingAddon,
  removeMessagingAddon,
} from "../src/billing/subscriptions.ts";
import { createAccount, createAgent } from "../src/db/index.ts";

// MNEMO-49: subscription + add-on lifecycle (D1). ensureFreeSubscription is the
// idempotent account-creation seed; applyBillingEvent is the single tier/status
// writer (driven by a FakeBillingProvider-shaped event); the messaging add-on
// round-trips and is gated on the tier's messagingAddonEligible flag.

async function seedAccount(): Promise<string> {
  const account = await createAccount(env, {
    email: `sub-${crypto.randomUUID()}@example.com`,
  });
  return account.id;
}

describe("subscriptions lifecycle", () => {
  it("getSubscription defaults to free for an account with no row", async () => {
    const accountId = await seedAccount();
    const sub = await getSubscription(env, accountId);
    expect(sub.tier).toBe("free");
    expect(sub.status).toBe("active");
  });

  it("ensureFreeSubscription is idempotent (twice → one free row)", async () => {
    const accountId = await seedAccount();
    const first = await ensureFreeSubscription(env, accountId);
    const second = await ensureFreeSubscription(env, accountId);
    expect(first.tier).toBe("free");
    expect(second.id).toBe(first.id); // same persisted row, not a new insert

    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM subscriptions WHERE account_id = ?",
    )
      .bind(accountId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("applyBillingEvent upserts activated (→ pro/active) then canceled (→ free/canceled)", async () => {
    const accountId = await seedAccount();
    await ensureFreeSubscription(env, accountId);

    const activated = await applyBillingEvent(env, {
      type: "subscription.activated",
      accountId,
      tier: "pro",
      providerCustomerId: "cus_fake",
      providerSubscriptionId: "sub_fake",
      currentPeriodEnd: "2026-12-31T00:00:00.000Z",
    });
    expect(activated.tier).toBe("pro");
    expect(activated.status).toBe("active");
    expect(activated.provider_subscription_id).toBe("sub_fake");
    expect(activated.current_period_end).toBe("2026-12-31T00:00:00.000Z");

    const canceled = await applyBillingEvent(env, {
      type: "subscription.canceled",
      accountId,
      tier: "free",
    });
    expect(canceled.tier).toBe("free");
    expect(canceled.status).toBe("canceled");
    // The provider linkage is preserved across the upsert (COALESCE).
    expect(canceled.provider_subscription_id).toBe("sub_fake");
  });
});

describe("messaging add-on", () => {
  it("round-trips add → has → remove", async () => {
    const accountId = await seedAccount();
    const agent = await createAgent(env, {
      account_id: accountId,
      name: "Addon agent",
    });

    expect(await hasMessagingAddon(env, accountId, agent.id)).toBe(false);
    await addMessagingAddon(env, accountId, agent.id);
    expect(await hasMessagingAddon(env, accountId, agent.id)).toBe(true);
    // Idempotent re-add (unique index) - still exactly enabled.
    await addMessagingAddon(env, accountId, agent.id);
    expect(await hasMessagingAddon(env, accountId, agent.id)).toBe(true);

    await removeMessagingAddon(env, accountId, agent.id);
    expect(await hasMessagingAddon(env, accountId, agent.id)).toBe(false);
  });

  it("is rejected on a tier whose messagingAddonEligible is false (free), allowed on pro", async () => {
    const accountId = await seedAccount();
    await ensureFreeSubscription(env, accountId);

    // Free tier: messaging feature not eligible (the route gate denies enabling).
    const free = await checkTierFeature(env, accountId, "messaging");
    expect(free.allowed).toBe(false);
    expect(free.reason).toBe("tier_feature");

    // Upgrade to pro → eligible.
    await applyBillingEvent(env, {
      type: "subscription.activated",
      accountId,
      tier: "pro",
    });
    const pro = await checkTierFeature(env, accountId, "messaging");
    expect(pro.allowed).toBe(true);
  });
});
