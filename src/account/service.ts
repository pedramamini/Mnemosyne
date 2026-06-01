/**
 * Account service layer - owner-profile reads/writes + DO sync.
 *
 * Mirrors the agent registry service (src/agents/service.ts): the route stays
 * thin (validate, call, respond) and this owns the D1 write plus the push of the
 * changed profile into the owner's agent DOs. Write order is D1 first (the
 * durable source of truth), then a best-effort fan-out so each always-home DO
 * refreshes its cached persona context without waiting for a cold reload.
 *
 * The owner profile is account-level (one human, possibly many agents), so a
 * single save fans out to every agent the account runs.
 */
import { getAgentStub } from "../agent/index.ts";
import {
  type AccountProfile,
  type AccountProfileUpdate,
  type AccountRow,
  listAgentsByAccount,
  updateAccountProfile,
} from "../db/index.ts";
import type { Env } from "../env.ts";

/** The owner-profile projection of an account row (never id/email/created_at). */
export function profileOf(account: AccountRow): AccountProfile {
  return {
    timezone: account.timezone,
    owner_name: account.owner_name,
    owner_notes: account.owner_notes,
  };
}

/**
 * Is `tz` a valid IANA timezone? Constructing an `Intl.DateTimeFormat` with an
 * unknown zone throws `RangeError`, so this round-trips the runtime's own ICU
 * database rather than maintaining a hand list. Empty/undefined is NOT valid
 * here - callers map "clear it" to an explicit `null` before validating.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist an account's owner-profile patch, then push the resulting profile into
 * each of the account's agent DOs. Returns the updated account row, or `null` if
 * the account is gone. The DO fan-out is best-effort: a DO that fails to refresh
 * still self-heals from D1 on its next cold load, so a transient RPC error must
 * not fail the user's save.
 */
export async function updateOwnerProfileForAccount(
  env: Env,
  accountId: string,
  patch: AccountProfileUpdate,
): Promise<AccountRow | null> {
  const updated = await updateAccountProfile(env, accountId, patch);
  if (!updated) return null;

  const profile = profileOf(updated);
  const agents = await listAgentsByAccount(env, accountId).catch(() => []);
  await Promise.allSettled(
    agents.map((a) => getAgentStub(env, a.id).updateOwnerProfile(profile)),
  );

  return updated;
}
