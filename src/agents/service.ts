/**
 * Agent registry service layer - the seam between routes and storage.
 *
 * This is the direct-service-layer pattern (PRD §6.3): routes stay thin (parse,
 * call, respond) and this module owns both the D1 registry writes and the sync
 * of the operational subset into the per-agent DO. Write order is always D1
 * first (the durable, cross-agent source of truth for listing/search), then the
 * DO mirror (template / system prompt / schedule) so the registry and the
 * always-home DO stay consistent.
 *
 * Every read/write is ownership-scoped to the calling account: a row owned by a
 * different account is treated as absent (returns `null`) so the route layer can
 * 404 rather than 403 - never leaking the existence of someone else's agent.
 */
import type { AgentSettings } from "../agent/index.ts";
import { getAgentStub } from "../agent/index.ts";
import {
  type AgentRow,
  type AgentUpdate,
  createAgent,
  deleteAgent,
  getAgent,
  listAgentsByAccount,
  updateAgent,
} from "../db/index.ts";
import type { Env } from "../env.ts";
import type { CreateAgentBody } from "./schemas.ts";

/**
 * Push the operational subset of a registry row into its DO. Only the DO-mirrored
 * fields are touched here; `model` is resolved elsewhere (Track C) and left alone.
 * `updateSettings` merges, so passing the current values is safe and idempotent.
 */
async function syncSettingsToDO(
  env: Env,
  agentId: string,
  settings: Partial<AgentSettings>,
): Promise<void> {
  if (Object.keys(settings).length === 0) return;
  await getAgentStub(env, agentId).updateSettings(settings);
}

/**
 * Create an agent for `accountId`: insert the registry row (the id is generated
 * by the D1 layer), then seed the DO's settings + schedule from the created row
 * so the always-home DO knows its persona before it ever wakes the sandbox.
 */
export async function createAgentForAccount(
  env: Env,
  accountId: string,
  body: CreateAgentBody,
): Promise<AgentRow> {
  const row = await createAgent(env, {
    account_id: accountId,
    name: body.name,
    description: body.description ?? null,
    template: body.template ?? null,
  });

  await syncSettingsToDO(env, row.id, {
    template: row.template,
    systemPrompt: row.system_prompt,
  });
  await getAgentStub(env, row.id).updateScheduleConfig({
    cron: row.schedule_cron,
  });

  return row;
}

/** All agents owned by `accountId`, newest first. */
export function listAgents(env: Env, accountId: string): Promise<AgentRow[]> {
  return listAgentsByAccount(env, accountId);
}

/**
 * Fetch an agent only if it belongs to `accountId`; otherwise `null`. The
 * not-found and not-owned cases are deliberately indistinguishable so the route
 * 404s for both (no existence leak across accounts).
 */
export async function getAgentOwned(
  env: Env,
  accountId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const row = await getAgent(env, agentId);
  if (!row || row.account_id !== accountId) return null;
  return row;
}

/**
 * Patch an agent the caller owns: ownership-check, update D1, then sync the
 * changed operational fields into the DO. Returns the updated row, or `null` if
 * the agent is absent or owned by another account.
 */
export async function updateAgentOwned(
  env: Env,
  accountId: string,
  agentId: string,
  patch: AgentUpdate,
): Promise<AgentRow | null> {
  const owned = await getAgentOwned(env, accountId, agentId);
  if (!owned) return null;

  const updated = await updateAgent(env, agentId, patch);
  if (!updated) return null;

  // Mirror only the operational fields that were actually in the patch - a
  // `null` clears the value, so we test presence (`!== undefined`), not truth.
  const settings: Partial<AgentSettings> = {};
  if (patch.template !== undefined) settings.template = patch.template ?? null;
  if (patch.system_prompt !== undefined) {
    settings.systemPrompt = patch.system_prompt ?? null;
  }
  await syncSettingsToDO(env, agentId, settings);

  if (patch.schedule_cron !== undefined) {
    await getAgentStub(env, agentId).updateScheduleConfig({
      cron: patch.schedule_cron ?? null,
    });
  }

  return updated;
}

/**
 * Delete every R2 object under `prefix` from `bucket`, paging through the
 * listing so an agent with many report assets (each report is its own prefix)
 * is fully cleared, not just the first page. Best-effort: callers swallow faults
 * so a storage hiccup never blocks the registry delete (the D1 row is the
 * user-visible source of truth for "the agent is gone").
 */
async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/**
 * Permanently delete an agent the caller owns, with full teardown across all
 * three stores the agent occupies (PRD §7.4): the per-agent DO (its SQLite brain
 * index, chat/audit log, schedule + idle alarm, and the live sandbox container),
 * the R2 brain snapshots + published-report blobs, and finally the D1 registry
 * row + dependent rows. Returns `false` if the agent is absent or owned by
 * another account (the route 404s for both - no existence leak), `true` once the
 * D1 delete succeeds.
 *
 * DO + R2 teardown is best-effort and runs BEFORE the D1 delete (so the DO can
 * still rehydrate its owning account from D1 to meter a final sandbox slot); a
 * fault there is swallowed rather than aborting the delete. In particular the DO
 * `teardownForDelete` aborts its own isolate, so its RPC routinely rejects even
 * on success - that rejection is expected and ignored.
 */
export async function deleteAgentOwned(
  env: Env,
  accountId: string,
  agentId: string,
): Promise<boolean> {
  const owned = await getAgentOwned(env, accountId, agentId);
  if (!owned) return false;

  try {
    await getAgentStub(env, agentId).teardownForDelete();
  } catch {
    // Expected: destroy() aborts the DO isolate, so the RPC may reject on success.
  }

  try {
    await deleteR2Prefix(env.BRAIN_BUCKET, `brains/${agentId}/`);
    await deleteR2Prefix(env.BRAIN_BUCKET, `snapshots/${agentId}/`);
    await deleteR2Prefix(env.REPORTS_BUCKET, `agents/${agentId}/reports/`);
  } catch {
    // Best-effort: orphaned blobs are a minor storage cost, not a failed delete.
  }

  await deleteAgent(env, agentId);
  return true;
}
