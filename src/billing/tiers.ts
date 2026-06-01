/**
 * Subscription tiers - the SINGLE SOURCE OF TRUTH for every billing limit
 * (MNEMO-49, PRD §3/§8.4). Tiers are DECLARATIVE config in code: the
 * `subscriptions` D1 row stores only WHICH tier an account is on; the limits that
 * make a tier real (cost cap, concurrency, BYOK eligibility, agent count) live
 * here and here only. No call site hard-codes a limit - they read it off the
 * resolved {@link Tier}, so a pricing change is a one-file edit.
 *
 * The numbers are deliberately round. §8.4 names the per-agent container as the
 * top cost risk, so the two levers that bound it - `monthlyCostCapCents` (a
 * fail-closed spend ceiling) and `maxConcurrentSandboxes` (how many containers an
 * account can run at once) - climb with price. Free gets the zero-secret Qwen3
 * default and a single container; paid tiers unlock BYOK + the messaging add-on.
 */

/** Closed set of subscription tiers. Mirrors the `subscriptions.tier` column. */
export type TierId = "free" | "pro" | "scale";

/** Everything a tier grants. Read by the gate (limits.ts) + the billing routes. */
export interface Tier {
  /** Stable id persisted in `subscriptions.tier`. */
  id: TierId;
  /** Human label for the UI / checkout. */
  label: string;
  /** List price in cents per month (0 for free). */
  priceCentsMonthly: number;
  /**
   * Hard monthly ceiling on PLATFORM cost (estimated, in cents) summed from the
   * `usage_events` ledger. The fail-closed cap §8.4 requires - when an account's
   * current-period spend reaches this, new sandbox runs / LLM turns are denied.
   */
  monthlyCostCapCents: number;
  /** How many sandboxes the account may run AT ONCE (the §8.4 concurrency lever). */
  maxConcurrentSandboxes: number;
  /**
   * Which LLM the tier includes: `"free"` = the zero-secret Workers AI Qwen3
   * default only; `"byok"` = the account may bring its own provider key (a paid
   * feature gated by `checkTierFeature(…, "byok")`).
   */
  includedLlmModel: "free" | "byok";
  /** Whether the per-agent messaging add-on (§9.2) may be enabled on this tier. */
  messagingAddonEligible: boolean;
  /** How many agents the account may own. */
  maxAgents: number;
}

/**
 * The tier catalog. Caps are in cents and intentionally conservative: the free
 * tier's small cap bounds the give-away (one container, free model, no
 * messaging), while Pro/Scale buy more cost headroom, more concurrency, BYOK, and
 * messaging eligibility (§8.4). Adjust pricing/limits HERE - never at call sites.
 */
export const TIERS: Record<TierId, Tier> = {
  free: {
    id: "free",
    label: "Free",
    priceCentsMonthly: 0,
    // $2.00/mo of platform cost - enough to evaluate the product, small enough
    // that an unbounded loop can't run up a bill (the §8.4 give-away guard).
    monthlyCostCapCents: 200,
    maxConcurrentSandboxes: 1,
    includedLlmModel: "free",
    messagingAddonEligible: false,
    maxAgents: 1,
  },
  pro: {
    id: "pro",
    label: "Pro",
    priceCentsMonthly: 2_900, // $29/mo
    monthlyCostCapCents: 5_000, // $50.00/mo cost headroom
    maxConcurrentSandboxes: 3,
    includedLlmModel: "byok",
    messagingAddonEligible: true,
    maxAgents: 10,
  },
  scale: {
    id: "scale",
    label: "Scale",
    priceCentsMonthly: 9_900, // $99/mo
    monthlyCostCapCents: 25_000, // $250.00/mo cost headroom
    maxConcurrentSandboxes: 10,
    includedLlmModel: "byok",
    messagingAddonEligible: true,
    maxAgents: 50,
  },
};

/** The free tier - the synthesized default for an account with no subscription row. */
export const DEFAULT_TIER: TierId = "free";

/**
 * Resolve a tier by id, falling back to {@link DEFAULT_TIER} for any unknown /
 * legacy / hand-edited value. So a `subscriptions.tier` that drifts out of the
 * closed set degrades to free (the safe, low-cap tier) instead of throwing.
 */
export function getTier(id: string): Tier {
  return TIERS[id as TierId] ?? TIERS[DEFAULT_TIER];
}
