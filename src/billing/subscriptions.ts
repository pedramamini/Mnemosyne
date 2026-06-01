/**
 * Subscription + add-on state (MNEMO-49) - typed D1 access and lifecycle over the
 * `subscriptions` / `addons` tables. This is the ONLY writer of an account's
 * tier/status: the billing routes route a PSP {@link BillingEvent} through
 * `applyBillingEvent`, and account creation seeds the free default via
 * `ensureFreeSubscription`. No PSP calls happen here - that's provider.ts; this
 * module just persists the result.
 *
 * Limits are NOT stored - `getSubscription` returns the tier id, and callers
 * resolve limits through `getTier` (tiers.ts, the single source of truth).
 */
import { z } from "zod";
import type { Env } from "../env.ts";
import type { BillingEvent } from "./provider.ts";
import { DEFAULT_TIER, type TierId } from "./tiers.ts";

// ─── Row schemas (source of truth for shapes) ───────────────────────────────

/** A `subscriptions` row. `tier`/`status`/`provider` are plain strings mirroring
 * the migration; the closed sets are enforced at write time (getTier degrades an
 * unknown tier to free on read). */
export const SubscriptionRow = z.object({
  id: z.string(),
  account_id: z.string(),
  tier: z.string(),
  status: z.string(),
  provider: z.string(),
  provider_customer_id: z.string().nullable(),
  provider_subscription_id: z.string().nullable(),
  current_period_end: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SubscriptionRow = z.infer<typeof SubscriptionRow>;

/** An `addons` row. `agent_id` is nullable (account-level vs per-agent add-ons). */
export const AddonRow = z.object({
  id: z.string(),
  account_id: z.string(),
  agent_id: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  created_at: z.string(),
});
export type AddonRow = z.infer<typeof AddonRow>;

/** The add-on kinds we support. Today: the per-agent messaging add-on (§9.2). */
export const MESSAGING_ADDON = "messaging";

// ─── subscriptions ───────────────────────────────────────────────────────────

/** Synthesize the free-tier default for an account with no `subscriptions` row. */
function freeDefault(accountId: string): SubscriptionRow {
  const now = new Date().toISOString();
  return {
    id: `synthetic:${accountId}`,
    account_id: accountId,
    tier: DEFAULT_TIER,
    status: "active",
    provider: "stripe",
    provider_customer_id: null,
    provider_subscription_id: null,
    current_period_end: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * The account's subscription, or a synthesized `free`/`active` default when none
 * exists - so every account ALWAYS resolves to a tier (callers never branch on a
 * missing row). The default is NOT persisted; `ensureFreeSubscription` does that
 * at account-creation time.
 */
export async function getSubscription(
  env: Env,
  accountId: string,
): Promise<SubscriptionRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE account_id = ?",
  )
    .bind(accountId)
    .first();
  return row ? SubscriptionRow.parse(row) : freeDefault(accountId);
}

/**
 * Idempotently ensure a `free`/`active` subscription row exists for the account.
 * Called on account creation (MNEMO-03 magic-link callback). `INSERT OR IGNORE`
 * on the unique `account_id` index makes a repeat call (or a callback race) a
 * no-op. Returns the persisted (or pre-existing) row.
 */
export async function ensureFreeSubscription(
  env: Env,
  accountId: string,
): Promise<SubscriptionRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions
       (id, account_id, tier, status, provider, created_at, updated_at)
     VALUES (?, ?, 'free', 'active', 'stripe', ?, ?)`,
  )
    .bind(id, accountId, now, now)
    .run();
  return getSubscription(env, accountId);
}

/**
 * Apply a PSP {@link BillingEvent} - the single tier/status writer. Upserts the
 * account's subscription: `subscription.activated` → the event's tier + `active`;
 * `subscription.past_due` → keep the tier, status `past_due`; `subscription.canceled`
 * → `free` + `canceled`. Stamps the provider ids + period end and `updated_at`.
 */
export async function applyBillingEvent(
  env: Env,
  event: BillingEvent,
): Promise<SubscriptionRow> {
  const tier: TierId =
    event.type === "subscription.canceled" ? "free" : event.tier;
  const status =
    event.type === "subscription.activated"
      ? "active"
      : event.type === "subscription.past_due"
        ? "past_due"
        : "canceled";

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO subscriptions
       (id, account_id, tier, status, provider, provider_customer_id,
        provider_subscription_id, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       tier                     = excluded.tier,
       status                   = excluded.status,
       provider_customer_id     = COALESCE(excluded.provider_customer_id, subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(excluded.provider_subscription_id, subscriptions.provider_subscription_id),
       current_period_end       = excluded.current_period_end,
       updated_at               = excluded.updated_at`,
  )
    .bind(
      id,
      event.accountId,
      tier,
      status,
      event.providerCustomerId ?? null,
      event.providerSubscriptionId ?? null,
      event.currentPeriodEnd ?? null,
      now,
      now,
    )
    .run();
  return getSubscription(env, event.accountId);
}

// ─── addons ────────────────────────────────────────────────────────────────

/**
 * Enable the per-agent messaging add-on (§9.2), idempotently. `INSERT OR IGNORE`
 * on the unique `(account_id, agent_id, kind)` index so re-enabling is a no-op.
 * Eligibility (`messagingAddonEligible`) is enforced by the route, NOT here.
 */
export async function addMessagingAddon(
  env: Env,
  accountId: string,
  agentId: string,
): Promise<void> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO addons (id, account_id, agent_id, kind, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, accountId, agentId, MESSAGING_ADDON, created_at)
    .run();
}

/** Disable (delete) the messaging add-on for an agent. No-op if absent. */
export async function removeMessagingAddon(
  env: Env,
  accountId: string,
  agentId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM addons WHERE account_id = ? AND agent_id = ? AND kind = ?",
  )
    .bind(accountId, agentId, MESSAGING_ADDON)
    .run();
}

/** Whether the messaging add-on is enabled for `agentId` under `accountId`. */
export async function hasMessagingAddon(
  env: Env,
  accountId: string,
  agentId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM addons WHERE account_id = ? AND agent_id = ? AND kind = ? AND status = 'active' LIMIT 1",
  )
    .bind(accountId, agentId, MESSAGING_ADDON)
    .first();
  return row !== null;
}
