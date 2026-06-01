/**
 * Billing HTTP surface (MNEMO-49), mounted from src/index.ts. All `/billing/*`
 * routes are account-scoped behind `requireAuth` - EXCEPT `POST /billing/webhook`,
 * which is deliberately UNAUTHENTICATED (the PSP calls it) and trusts only a
 * verified provider signature.
 *
 *   GET  /billing/subscription   - the account's subscription + its tier limits.
 *   GET  /billing/usage          - current-period spend summary + the cost cap.
 *   POST /billing/checkout       - { tier } → a provider checkout URL.
 *   POST /billing/cancel         - cancel at the PSP + flip the row to canceled.
 *   POST /billing/addon/messaging - { agentId, enable } → add/remove the per-agent
 *                                   messaging add-on (gated on messagingAddonEligible).
 *   GET  /billing/limits         - tier limits + spend-vs-cap + concurrency-vs-max
 *                                   + a derived { canRunNow, reason? } (admitSandboxRun).
 *   POST /billing/webhook        - verify + route a PSP BillingEvent (public).
 *
 * Routes are thin: validate (Zod), call the typed lifecycle/gate helper, shape the
 * response. The PSP is reached only through getBillingProvider (provider.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import { byIp, rateLimitMiddleware } from "../abuse/rateLimit.ts";
import { getAgentOwned } from "../agents/service.ts";
import { type AppEnv, getAccountId, requireAuth } from "../auth/middleware.ts";
import { countActiveSlots } from "./concurrency.ts";
import { admitSandboxRun, checkTierFeature } from "./limits.ts";
import { getUsageSummary } from "./meter.ts";
import { getBillingProvider } from "./provider.ts";
import {
  addMessagingAddon,
  applyBillingEvent,
  getSubscription,
  hasMessagingAddon,
  removeMessagingAddon,
} from "./subscriptions.ts";
import { getTier, type TierId } from "./tiers.ts";

/** Checkout targets a PAID tier only (you don't "buy" the free tier). */
const CheckoutBody = z.object({ tier: z.enum(["pro", "scale"]) });

/** Toggle the messaging add-on for one of the caller's agents. */
const MessagingAddonBody = z.object({
  agentId: z.string().min(1),
  enable: z.boolean(),
});

export function billingRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // MNEMO-50: the webhook is public (no session), so guard it coarsely per-IP -
  // the PSP bursts legitimately, hence a high limit. Applied BEFORE the handler.
  app.use("/billing/webhook", rateLimitMiddleware("billing_webhook", byIp));

  // Gate each authenticated path independently (the webhook stays public).
  app.use("/billing/subscription", requireAuth());
  app.use("/billing/usage", requireAuth());
  app.use("/billing/checkout", requireAuth());
  app.use("/billing/cancel", requireAuth());
  app.use("/billing/addon/messaging", requireAuth());
  app.use("/billing/limits", requireAuth());

  app.get("/billing/subscription", async (c) => {
    const accountId = getAccountId(c);
    const sub = await getSubscription(c.env, accountId);
    const tier = getTier(sub.tier);
    return c.json({
      tier: sub.tier,
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      limits: tier,
    });
  });

  app.get("/billing/usage", async (c) => {
    const accountId = getAccountId(c);
    const sub = await getSubscription(c.env, accountId);
    const tier = getTier(sub.tier);
    const summary = await getUsageSummary(c.env, accountId);
    return c.json({
      period: summary.period,
      totalCents: summary.totalCents,
      byKind: summary.byKind,
      monthlyCostCapCents: tier.monthlyCostCapCents,
    });
  });

  app.post("/billing/checkout", async (c) => {
    const accountId = getAccountId(c);
    const parsed = CheckoutBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const provider = getBillingProvider(c.env);
    const { url } = await provider.createCheckout({
      accountId,
      tier: parsed.data.tier as TierId,
      returnUrl: c.env.APP_BASE_URL,
    });
    return c.json({ url });
  });

  app.post("/billing/cancel", async (c) => {
    const accountId = getAccountId(c);
    const sub = await getSubscription(c.env, accountId);
    const provider = getBillingProvider(c.env);
    await provider.cancelSubscription({
      accountId,
      providerSubscriptionId: sub.provider_subscription_id,
    });
    // Reflect the cancellation locally → free/canceled. (With a live PSP the
    // webhook would also land this; applyBillingEvent is idempotent on the row.)
    const updated = await applyBillingEvent(c.env, {
      type: "subscription.canceled",
      accountId,
      tier: "free",
    });
    return c.json({ tier: updated.tier, status: updated.status });
  });

  app.post("/billing/addon/messaging", async (c) => {
    const accountId = getAccountId(c);
    const parsed = MessagingAddonBody.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    // Ownership: 404 (not 403) for an agent the caller doesn't own (no leak).
    const owned = await getAgentOwned(c.env, accountId, parsed.data.agentId);
    if (!owned) return c.json({ error: "not found" }, 404);

    if (parsed.data.enable) {
      // Gate on tier eligibility - fail-closed (a feature you don't pay for).
      const feature = await checkTierFeature(c.env, accountId, "messaging");
      if (!feature.allowed) {
        return c.json({ error: "tier_feature", detail: feature.detail }, 403);
      }
      await addMessagingAddon(c.env, accountId, parsed.data.agentId);
    } else {
      await removeMessagingAddon(c.env, accountId, parsed.data.agentId);
    }
    const enabled = await hasMessagingAddon(
      c.env,
      accountId,
      parsed.data.agentId,
    );
    return c.json({ agentId: parsed.data.agentId, messaging: enabled });
  });

  app.get("/billing/limits", async (c) => {
    const accountId = getAccountId(c);
    const sub = await getSubscription(c.env, accountId);
    const tier = getTier(sub.tier);
    const [summary, active, admission] = await Promise.all([
      getUsageSummary(c.env, accountId),
      countActiveSlots(c.env, accountId),
      admitSandboxRun(c.env, accountId),
    ]);
    return c.json({
      tier: sub.tier,
      limits: tier,
      spendCents: summary.totalCents,
      monthlyCostCapCents: tier.monthlyCostCapCents,
      activeSandboxes: active,
      maxConcurrentSandboxes: tier.maxConcurrentSandboxes,
      canRunNow: admission.allowed,
      reason: admission.reason,
    });
  });

  // PUBLIC: the PSP posts here. The provider verifies its own signature before we
  // trust the body; an unrecognized/unsigned event yields null → 204 (ack, no-op).
  app.post("/billing/webhook", async (c) => {
    const provider = getBillingProvider(c.env);
    let event: Awaited<ReturnType<typeof provider.handleWebhook>>;
    try {
      event = await provider.handleWebhook(c.req.raw);
    } catch {
      // A signature/verification failure is a 400 - do NOT process it.
      return c.json({ error: "invalid webhook" }, 400);
    }
    if (!event) return c.body(null, 204);
    await applyBillingEvent(c.env, event);
    return c.json({ ok: true });
  });

  return app;
}
