/**
 * Payment-service-provider (PSP) abstraction (MNEMO-49). The rest of billing
 * never talks to Stripe directly - it goes through the {@link BillingProvider}
 * interface, so checkout / cancel / webhook handling has ONE seam and tests run
 * against a deterministic {@link FakeBillingProvider} with NO network calls.
 *
 * A webhook is normalized into a provider-neutral {@link BillingEvent}; the route
 * (routes.ts) routes that event through `applyBillingEvent` (subscriptions.ts),
 * which is the only writer of the `subscriptions` row's tier/status. The live
 * {@link StripeBillingProvider} is a stub: it reads `STRIPE_SECRET_KEY` from env
 * and marks each live call as a TODO with the Stripe endpoint noted, so wiring it
 * up later is mechanical and the abstraction is proven by the fake today.
 */
import type { Env } from "../env.ts";
import type { TierId } from "./tiers.ts";

/** The provider-neutral lifecycle events a PSP webhook can carry. */
export type BillingEventType =
  | "subscription.activated"
  | "subscription.canceled"
  | "subscription.past_due";

/**
 * A normalized billing event - the shape `applyBillingEvent` consumes. Both the
 * fake and the real provider translate their raw webhook payload into this so the
 * subscription writer never branches on the PSP.
 */
export interface BillingEvent {
  type: BillingEventType;
  /** The Mnemosyne account the event applies to. */
  accountId: string;
  /** Tier the account should be on after this event (free on cancel). */
  tier: TierId;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  /** End of the paid period (ISO-8601), when the PSP supplies it. */
  currentPeriodEnd?: string | null;
}

/** Where to send the user to complete (or manage) payment. */
export interface CheckoutResult {
  url: string;
}

/** Input to start a checkout for a tier upgrade. */
export interface CheckoutInput {
  accountId: string;
  tier: TierId;
  /** Optional return origin (the app builds the success/cancel URLs from it). */
  returnUrl?: string;
}

/** Input to cancel an account's subscription at the PSP. */
export interface CancelInput {
  accountId: string;
  providerSubscriptionId?: string | null;
}

/**
 * The seam every billing path goes through. Implementations MUST be the only code
 * that touches the PSP's SDK / HTTP API.
 */
export interface BillingProvider {
  /** Begin a checkout for a tier upgrade; returns the URL to redirect the user to. */
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  /** Cancel the account's subscription at the PSP (idempotent / best-effort). */
  cancelSubscription(input: CancelInput): Promise<void>;
  /**
   * Verify + parse a raw webhook request into a {@link BillingEvent}, or null when
   * the event isn't one we act on. MUST verify the provider signature before
   * trusting the body.
   */
  handleWebhook(req: Request): Promise<BillingEvent | null>;
}

/**
 * Deterministic, network-free provider for tests + `wrangler dev`. Checkout
 * returns a stable fake URL; cancel is a no-op; the webhook trusts a JSON body
 * shaped like a {@link BillingEvent} (NO signature - dev only). This is what
 * proves the billing lifecycle end-to-end without a Stripe account.
 */
export class FakeBillingProvider implements BillingProvider {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const url = `https://billing.fake.local/checkout?account=${encodeURIComponent(
      input.accountId,
    )}&tier=${encodeURIComponent(input.tier)}`;
    return Promise.resolve({ url });
  }

  cancelSubscription(_input: CancelInput): Promise<void> {
    // No PSP to call - the subscription row is flipped to canceled by the route
    // via applyBillingEvent; nothing to do here.
    return Promise.resolve();
  }

  async handleWebhook(req: Request): Promise<BillingEvent | null> {
    // Dev/test only: the body IS the normalized event (no signature to verify).
    const body = (await req
      .json()
      .catch(() => null)) as Partial<BillingEvent> | null;
    if (
      !body ||
      typeof body.type !== "string" ||
      typeof body.accountId !== "string"
    ) {
      return null;
    }
    return {
      type: body.type,
      accountId: body.accountId,
      tier: (body.tier ?? "free") as TierId,
      providerCustomerId: body.providerCustomerId ?? null,
      providerSubscriptionId: body.providerSubscriptionId ?? null,
      currentPeriodEnd: body.currentPeriodEnd ?? null,
    };
  }
}

/**
 * Live Stripe provider - a STUB. It reads the secret from env and documents each
 * live call as a TODO with the Stripe endpoint, so production wiring is a fill-in
 * rather than a redesign. Selected by {@link getBillingProvider} only when
 * `STRIPE_SECRET_KEY` is present.
 */
export class StripeBillingProvider implements BillingProvider {
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {}

  createCheckout(_input: CheckoutInput): Promise<CheckoutResult> {
    // TODO(MNEMO-49 live): POST https://api.stripe.com/v1/checkout/sessions
    //   mode=subscription, line_items=[{ price: <price id for tier> }],
    //   client_reference_id=<accountId>, success_url/cancel_url from returnUrl.
    //   Authorization: Bearer ${this.secretKey}. Return session.url.
    void this.secretKey;
    throw new Error(
      "StripeBillingProvider.createCheckout not implemented (stub)",
    );
  }

  cancelSubscription(_input: CancelInput): Promise<void> {
    // TODO(MNEMO-49 live): DELETE https://api.stripe.com/v1/subscriptions/{id}
    //   (or set cancel_at_period_end=true), Authorization: Bearer ${this.secretKey}.
    throw new Error(
      "StripeBillingProvider.cancelSubscription not implemented (stub)",
    );
  }

  handleWebhook(_req: Request): Promise<BillingEvent | null> {
    // TODO(MNEMO-49 live): verify the `Stripe-Signature` header against
    //   ${this.webhookSecret} (constructEvent), then map
    //   customer.subscription.created/updated/deleted → BillingEvent. Drop the
    //   `void this.webhookSecret` below once verification is wired.
    void this.webhookSecret;
    throw new Error(
      "StripeBillingProvider.handleWebhook not implemented (stub)",
    );
  }
}

/**
 * Select the billing provider for this environment: the real Stripe provider when
 * `STRIPE_SECRET_KEY` is configured, else the deterministic fake (tests +
 * `wrangler dev`). One chooser so call sites never branch on the env themselves.
 */
export function getBillingProvider(env: Env): BillingProvider {
  if (env.STRIPE_SECRET_KEY) {
    return new StripeBillingProvider(
      env.STRIPE_SECRET_KEY,
      env.STRIPE_WEBHOOK_SECRET,
    );
  }
  return new FakeBillingProvider();
}
