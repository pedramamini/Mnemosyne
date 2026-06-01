/**
 * Shared route guard: ownership of an agent by the authenticated account.
 *
 * Used by every per-agent sub-app (`/agents/:agentId/*` - audit MNEMO-22, reports
 * MNEMO-25, …) so the 404-not-403 no-existence-leak convention lives in ONE place
 * instead of a per-route-group copy. Reuses the MNEMO-05 ownership lookup
 * ({@link getAgentOwned}), which treats a row owned by a different account as
 * absent - so an unknown id and a not-owned id are indistinguishable to a caller.
 */
import type { Context } from "hono";
import { type AppEnv, getAccountId } from "../auth/middleware.ts";
import { getAgentOwned } from "./service.ts";

/**
 * 404 (not 403) unless the calling account owns `agentId`. Returns a `Response` to
 * short-circuit the handler, or `null` to proceed. MUST be called inside a
 * `requireAuth`-protected route (it reads the authenticated account id).
 */
export async function assertOwnsAgent(
  c: Context<AppEnv>,
  agentId: string,
): Promise<Response | null> {
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);
  return null;
}
