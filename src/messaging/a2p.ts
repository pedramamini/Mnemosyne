/**
 * A2P 10DLC orchestration (MNEMO-47, PRD §9.1/§9.2).
 *
 * US application-to-person SMS requires carrier registration: a one-time BRAND
 * registration and a CAMPAIGN registration, after which one brand+campaign covers
 * MANY agent numbers (they are SHARED, org-level - NOT per-number). Onboarding is
 * **asynchronous and DAYS-NOT-MINUTES** (§9.2): carriers review the registration
 * over days. So nothing here BLOCKS on approval - `ensure*` submits and records the
 * state, approval lands later (a Twilio status callback / a refresh) and is read
 * back via {@link getA2pStatus}. The enable flow gates on that state rather than
 * waiting.
 *
 * The exact Twilio A2P/TrustHub resource paths shift across API versions, so every
 * Twilio A2P call is ISOLATED behind a single function carrying a
 * `// verify against current Twilio A2P API` marker - the one place to update when
 * the API moves.
 */
import {
  type A2pBrandRow,
  type A2pCampaignRow,
  createCampaign,
  getActiveCampaign,
  getBrand,
  getOrCreateBrand,
  updateBrand,
  updateCampaign,
} from "../db/index.ts";
import type { Env } from "../env.ts";
import { twilioApiBase, twilioAuthHeader } from "./twilioRest.ts";

/** Default messaging use case registered for the shared campaign. */
const DEFAULT_USE_CASE = "MIXED";

/** Statuses that count as "registration is underway or done" (the readiness bar). */
const READY_STATUSES = new Set(["submitted", "approved"]);

/** The combined A2P state {@link getA2pStatus} returns. */
export interface A2pStatus {
  brand: A2pBrandRow | null;
  campaign: A2pCampaignRow | null;
}

/**
 * Ensure the shared brand is registered. Creates the singleton brand row if
 * absent, then - unless it is already approved or already submitted - submits it to
 * Twilio and records the SID + `submitted` status. IDEMPOTENT: an approved brand is
 * returned untouched (no re-submit), an already-submitted brand is left to finish
 * its review. A Twilio failure marks the brand `failed` (surfaced via getA2pStatus)
 * rather than throwing - onboarding degrades, never blocks (§9.2).
 */
export async function ensureBrand(
  env: Env,
  kind = "sole_prop",
): Promise<A2pBrandRow> {
  const brand = await getOrCreateBrand(env, kind);
  // Idempotent: already approved, or already submitted and awaiting carrier review.
  if (brand.status === "approved") return brand;
  if (brand.status === "submitted" && brand.twilio_brand_sid) return brand;

  try {
    const sid = await createTwilioBrand(env, kind);
    return (
      (await updateBrand(env, brand.id, {
        twilio_brand_sid: sid,
        status: "submitted",
      })) ?? brand
    );
  } catch {
    return (await updateBrand(env, brand.id, { status: "failed" })) ?? brand;
  }
}

/**
 * Ensure the shared campaign is registered UNDER AN APPROVED BRAND. Returns `null`
 * when the brand is not yet approved (the campaign cannot be created before its
 * brand clears review, §9.1) - the caller treats null as "not ready yet". With an
 * approved brand it creates the campaign row if absent, then submits it to Twilio
 * (idempotent like {@link ensureBrand}). A Twilio failure marks it `failed`.
 */
export async function ensureCampaign(
  env: Env,
  useCase = DEFAULT_USE_CASE,
): Promise<A2pCampaignRow | null> {
  const brand = await getBrand(env);
  if (!brand || brand.status !== "approved") return null; // brand must clear first

  let campaign = await getActiveCampaign(env);
  if (campaign?.status === "approved") return campaign; // idempotent
  if (campaign?.status === "submitted" && campaign.twilio_campaign_sid) {
    return campaign; // already submitted, awaiting review
  }
  if (!campaign) {
    campaign = await createCampaign(env, {
      brand_id: brand.id,
      use_case: useCase,
    });
  }

  try {
    const sid = await createTwilioCampaign(env, brand, useCase);
    return (
      (await updateCampaign(env, campaign.id, {
        twilio_campaign_sid: sid,
        status: "submitted",
        use_case: useCase,
      })) ?? campaign
    );
  } catch {
    return (
      (await updateCampaign(env, campaign.id, { status: "failed" })) ?? campaign
    );
  }
}

/**
 * Attach a provisioned number (its Twilio SID) to the shared campaign so its SMS is
 * registered traffic (un-throttled). A NO-OP when no campaign with a SID exists yet
 * - provisioning calls this best-effort, and a number can be attached later once
 * the campaign is approved (§9.2 days-not-minutes). Throws only on a Twilio error
 * the caller chooses to handle.
 */
export async function attachNumberToCampaign(
  env: Env,
  numberSid: string,
): Promise<void> {
  const campaign = await getActiveCampaign(env);
  if (!campaign?.twilio_campaign_sid) return; // nothing to attach to yet
  await attachToTwilioCampaign(env, campaign.twilio_campaign_sid, numberSid);
}

/** The current shared A2P state (read-only - does not create or submit anything). */
export async function getA2pStatus(env: Env): Promise<A2pStatus> {
  const [brand, campaign] = await Promise.all([
    getBrand(env),
    getActiveCampaign(env),
  ]);
  return { brand, campaign };
}

/**
 * Is the shared 10DLC registration far enough along for a number to be provisioned
 * (§9.1)? Both the brand AND a campaign must be at least `submitted` - provisioning
 * an unregistered number gets it throttled/blocked, so the enable flow gates here.
 */
export function isA2pReady(status: A2pStatus): boolean {
  return (
    status.brand !== null &&
    READY_STATUSES.has(status.brand.status) &&
    status.campaign !== null &&
    READY_STATUSES.has(status.campaign.status)
  );
}

// ─── Isolated Twilio A2P/TrustHub calls ───────────────────────────────────────
// The A2P resources live on Twilio's Messaging/TrustHub API (NOT the classic
// 2010-04-01 REST base), and their exact paths shift across API versions. Every
// Twilio A2P call is isolated below so there is ONE place to fix when the API
// moves. Each carries the `// verify against current Twilio A2P API` marker.

/** Twilio A2P API base. Real Twilio routes these on messaging.twilio.com; a test
 * can repoint via TWILIO_API_BASE (then it derives `${base}/v1`). */
function a2pBase(env: Env): string {
  const base = twilioApiBase(env);
  return base === "https://api.twilio.com"
    ? "https://messaging.twilio.com/v1"
    : `${base}/v1`;
}

/** A2P responses we read carry a resource `sid`. */
interface A2pSidResponse {
  sid?: string;
}

/** Create the shared brand registration; returns its Twilio brand SID. */
async function createTwilioBrand(env: Env, kind: string): Promise<string> {
  // verify against current Twilio A2P API
  const res = await fetch(`${a2pBase(env)}/a2p/BrandRegistrations`, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ BrandType: kind }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `twilio brand ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as A2pSidResponse;
  if (!body.sid) throw new Error("twilio brand 2xx without a sid");
  return body.sid;
}

/** Create the shared campaign under `brand`; returns its Twilio campaign SID. */
async function createTwilioCampaign(
  env: Env,
  brand: A2pBrandRow,
  useCase: string,
): Promise<string> {
  // verify against current Twilio A2P API
  const res = await fetch(`${a2pBase(env)}/a2p/Campaigns`, {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      BrandRegistrationSid: brand.twilio_brand_sid ?? "",
      UseCase: useCase,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `twilio campaign ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as A2pSidResponse;
  if (!body.sid) throw new Error("twilio campaign 2xx without a sid");
  return body.sid;
}

/** Attach a number (its SID) to the campaign (its SID). */
async function attachToTwilioCampaign(
  env: Env,
  campaignSid: string,
  numberSid: string,
): Promise<void> {
  // verify against current Twilio A2P API
  const res = await fetch(
    `${a2pBase(env)}/a2p/Campaigns/${campaignSid}/PhoneNumbers`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(env),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ PhoneNumberSid: numberSid }).toString(),
    },
  );
  if (!res.ok) {
    throw new Error(
      `twilio attach ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
}
