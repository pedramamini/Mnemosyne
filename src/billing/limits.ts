/**
 * The admission gate (MNEMO-49) - where the declarative tier limits (tiers.ts)
 * become real. The sandbox spin-up path and the LLM call path consult these
 * checks before spending money (PRD §8.4: the per-agent container is the top cost
 * risk → caps + concurrency are the guard). Caps are enforced at the ACCOUNT level.
 *
 * Failure policy (the deliberate trade-off):
 *   - FAIL-CLOSED on a determined cap/limit breach - over the cost cap, at the
 *     concurrency ceiling, or missing a tier feature ⇒ DENY. The whole point of a
 *     cap is to stop spend.
 *   - FAIL-OPEN on an UNKNOWN error - if a check itself throws (a D1/KV glitch, a
 *     metering hiccup), the composite gate ALLOWS rather than bricking a paying
 *     user over an observability fault. A metering glitch must never silently
 *     brick paid users.
 */
import type { Env } from "../env.ts";
import { countActiveSlots } from "./concurrency.ts";
import { getUsageSummary } from "./meter.ts";
import { getSubscription } from "./subscriptions.ts";
import { getTier } from "./tiers.ts";

/** Why a run was denied (absent when allowed). */
export type AdmissionReason = "cost_cap" | "concurrency" | "tier_feature";

/** The result of an admission check. `detail` is a short human-readable reason. */
export interface AdmissionResult {
  allowed: boolean;
  reason?: AdmissionReason;
  detail?: string;
}

/** Tier features the gate can check. */
export type TierFeature = "byok" | "messaging";

/** Allowed shorthand. */
const ALLOW: AdmissionResult = { allowed: true };

/**
 * Reserve a little room below the hard cap so a run that meters its cost AFTER it
 * finishes (sandbox-seconds on stop, LLM tokens after the response) can't blow far
 * past the ceiling - we fail-closed slightly early. In cents.
 */
export const COST_CAP_HEADROOM_CENTS = 25;

/**
 * Cost-cap check: deny when the account's current-period spend (summed from
 * `usage_events`) has reached its tier cap, minus the headroom buffer. FAIL-CLOSED
 * on a determined breach. Allowed when comfortably under.
 */
export async function checkCostCap(
  env: Env,
  accountId: string,
): Promise<AdmissionResult> {
  const sub = await getSubscription(env, accountId);
  const tier = getTier(sub.tier);
  const { totalCents } = await getUsageSummary(env, accountId);
  const ceiling = tier.monthlyCostCapCents - COST_CAP_HEADROOM_CENTS;
  if (totalCents >= ceiling) {
    return {
      allowed: false,
      reason: "cost_cap",
      detail: `monthly cost cap reached (${Math.round(totalCents)}¢ of ${tier.monthlyCostCapCents}¢ on the ${tier.label} tier)`,
    };
  }
  return ALLOW;
}

/**
 * Concurrency check: deny when the account is already running its tier's max
 * concurrent sandboxes (counted from the KV leases). Allowed when a slot is free.
 */
export async function checkConcurrency(
  env: Env,
  accountId: string,
): Promise<AdmissionResult> {
  const sub = await getSubscription(env, accountId);
  const tier = getTier(sub.tier);
  const active = await countActiveSlots(env, accountId);
  if (active >= tier.maxConcurrentSandboxes) {
    return {
      allowed: false,
      reason: "concurrency",
      detail: `concurrency limit reached (${active}/${tier.maxConcurrentSandboxes} sandboxes on the ${tier.label} tier)`,
    };
  }
  return ALLOW;
}

/**
 * Tier-feature check: is `feature` included in the account's tier? `"byok"` maps
 * to `includedLlmModel === "byok"`; `"messaging"` to `messagingAddonEligible`.
 * Denied features are FAIL-CLOSED (a feature you don't pay for stays off).
 */
export async function checkTierFeature(
  env: Env,
  accountId: string,
  feature: TierFeature,
): Promise<AdmissionResult> {
  const sub = await getSubscription(env, accountId);
  const tier = getTier(sub.tier);
  const allowed =
    feature === "byok"
      ? tier.includedLlmModel === "byok"
      : tier.messagingAddonEligible;
  if (!allowed) {
    return {
      allowed: false,
      reason: "tier_feature",
      detail: `the ${feature} feature is not available on the ${tier.label} tier`,
    };
  }
  return ALLOW;
}

/**
 * Composite gate for booting a sandbox run: cost cap THEN concurrency. Returns the
 * FIRST failing check (with its `reason`), or allowed. Wrapped so an UNKNOWN error
 * in any check FAILS OPEN (allow + console.warn) - a metering/KV fault must never
 * silently brick a paying user (§8.4). A determined cap/concurrency breach still
 * denies (fail-closed); only an unexpected throw degrades to allow.
 */
export async function admitSandboxRun(
  env: Env,
  accountId: string,
): Promise<AdmissionResult> {
  try {
    const cap = await checkCostCap(env, accountId);
    if (!cap.allowed) return cap;
    const concurrency = await checkConcurrency(env, accountId);
    if (!concurrency.allowed) return concurrency;
    return ALLOW;
  } catch (err) {
    // FAIL-OPEN: an admission fault is an observability problem, not a reason to
    // brick the user. Log loudly so the glitch is visible.
    console.warn(
      `admitSandboxRun failed open for account ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ALLOW;
  }
}
