/**
 * Twilio number provisioning (MNEMO-47, PRD §9.1).
 *
 * Buys a dedicated Twilio long-code for an opted-in agent and wires its inbound
 * SMS webhook to the MNEMO-45 gateway in the SAME purchase call, so the number is
 * live the moment it is bought. Reuses the {@link TwilioSmsChannel} Basic-auth +
 * `apiBase` pattern (via src/messaging/twilioRest.ts) and NEVER throws - every
 * outcome (no number available, a non-2xx purchase, a transport error) is returned
 * as a typed result the caller audits, mirroring the messaging seam's convention.
 *
 * Provisioning is the PAID add-on's spend trigger: each number is ~$1.15/mo + usage
 * (§9.2). The billing/entitlement gate is MNEMO-49 - the `// MNEMO-49` marker at the
 * call boundary (the enable route) is where that check lands; this module assumes
 * it has already been authorized.
 */
import {
  type AgentNumberRow,
  addAgentNumber,
  getAgentNumber,
  removeAgentNumber,
} from "../db/index.ts";
import type { Env } from "../env.ts";
import { attachNumberToCampaign } from "./a2p.ts";
import { twilioAccountUrl, twilioAuthHeader } from "./twilioRest.ts";

/** Inputs to {@link provisionAgentNumber}. */
export interface ProvisionInput {
  /** The agent to provision a number for. */
  agentId: string;
  /** Optional preferred area code (e.g. "415"); omitted ⇒ any in-country number. */
  areaCode?: string;
  /** ISO country for the AvailablePhoneNumbers search; defaults to "US". */
  country?: string;
}

/**
 * The typed result - success carries the bought number + its Twilio SID; failure
 * carries a reason and the HTTP `status` when Twilio answered non-2xx. Never thrown.
 */
export type ProvisionResult =
  | { ok: true; e164: string; sid: string }
  | { ok: false; error: string; status?: number };

/** Twilio AvailablePhoneNumbers search response (the fields we read). */
interface AvailableNumbersResponse {
  available_phone_numbers?: { phone_number?: string }[];
}

/** Twilio IncomingPhoneNumbers purchase response (the fields we read). */
interface PurchaseResponse {
  sid?: string;
  phone_number?: string;
}

/**
 * Provision a dedicated SMS number for `agentId`: search Twilio for an SMS-enabled
 * local number (optionally in `areaCode`), purchase it with its inbound webhook
 * pointed at the gateway, persist it, and attach it to the shared A2P campaign.
 * Returns a typed {@link ProvisionResult}; never throws.
 */
export async function provisionAgentNumber(
  env: Env,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const country = input.country ?? "US";
  try {
    // (1) Search for an SMS-capable local number.
    const candidate = await findAvailableNumber(env, country, input.areaCode);
    if (!candidate.ok) return candidate;

    // (2) Purchase it, wiring SmsUrl to the inbound gateway in the same call (so
    // inbound is live immediately, MNEMO-45).
    const purchased = await purchaseNumber(env, candidate.phoneNumber);
    if (!purchased.ok) return purchased;

    // (3) Persist the registry row (number → agent, SID for later release) and
    // attach to the shared A2P campaign (best-effort - see attachNumberToCampaign).
    await addAgentNumber(env, input.agentId, purchased.e164, purchased.sid);
    await attachNumberToCampaign(env, purchased.sid).catch(() => {
      // A failed attach must not fail provisioning - the number is bought and
      // inbound-wired; campaign attachment is async/retryable (§9.2 days-not-minutes).
    });

    return { ok: true, e164: purchased.e164, sid: purchased.sid };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Search Twilio for the first SMS-enabled local number (optional area code). */
async function findAvailableNumber(
  env: Env,
  country: string,
  areaCode?: string,
): Promise<
  | { ok: true; phoneNumber: string }
  | { ok: false; error: string; status?: number }
> {
  const params = new URLSearchParams({ SmsEnabled: "true" });
  if (areaCode) params.set("AreaCode", areaCode);
  const url = `${twilioAccountUrl(
    env,
    `AvailablePhoneNumbers/${country}/Local.json`,
  )}?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Authorization: twilioAuthHeader(env) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      error: `twilio search ${res.status}: ${detail}`.trim(),
      status: res.status,
    };
  }
  const body = (await res.json().catch(() => ({}))) as AvailableNumbersResponse;
  const phoneNumber = body.available_phone_numbers?.[0]?.phone_number;
  if (!phoneNumber) {
    return { ok: false, error: "no available numbers matched the search" };
  }
  return { ok: true, phoneNumber };
}

/** Purchase a specific number, wiring its inbound SMS webhook to the gateway. */
async function purchaseNumber(
  env: Env,
  phoneNumber: string,
): Promise<
  | { ok: true; e164: string; sid: string }
  | { ok: false; error: string; status?: number }
> {
  const smsUrl = `${(env.APP_BASE_URL || "").replace(
    /\/+$/,
    "",
  )}/webhooks/twilio/sms`;
  const form = new URLSearchParams({
    PhoneNumber: phoneNumber,
    SmsUrl: smsUrl,
    SmsMethod: "POST",
  });

  const res = await fetch(twilioAccountUrl(env, "IncomingPhoneNumbers.json"), {
    method: "POST",
    headers: {
      Authorization: twilioAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      error: `twilio purchase ${res.status}: ${detail}`.trim(),
      status: res.status,
    };
  }
  const body = (await res.json().catch(() => ({}))) as PurchaseResponse;
  if (!body.sid || !body.phone_number) {
    return {
      ok: false,
      error: "twilio purchase 2xx without sid/phone_number",
      status: res.status,
    };
  }
  return { ok: true, e164: body.phone_number, sid: body.sid };
}

/**
 * Release an agent's provisioned number at Twilio (DELETE the IncomingPhoneNumber)
 * and remove the registry row - the messaging-disable path. Best-effort on the
 * Twilio call (a number with no SID, or a non-2xx, still drops the local row so the
 * agent is no longer reachable). Never throws.
 */
export async function releaseAgentNumber(
  env: Env,
  agentId: string,
): Promise<{ ok: boolean; released: boolean }> {
  const existing: AgentNumberRow | null = await getAgentNumber(env, agentId);
  let released = false;
  if (existing?.twilio_sid) {
    try {
      const res = await fetch(
        twilioAccountUrl(
          env,
          `IncomingPhoneNumbers/${existing.twilio_sid}.json`,
        ),
        { method: "DELETE", headers: { Authorization: twilioAuthHeader(env) } },
      );
      released = res.ok;
    } catch {
      released = false;
    }
  }
  // Drop the local registry row regardless, so the agent stops accepting inbound.
  await removeAgentNumber(env, agentId);
  return { ok: true, released };
}
