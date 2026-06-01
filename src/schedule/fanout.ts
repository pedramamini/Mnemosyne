/**
 * Cron fan-out (MNEMO-27, PRD §7.4/§8.5) - the platform heartbeat's worker.
 *
 * The Worker `scheduled` handler (src/index.ts) calls {@link runDueAgents} on
 * each cron tick. It is the SAFETY NET for the per-agent DO timer
 * (`MnemosyneAgent.scheduleNextRun`): a DO evicted before its own
 * `this.schedule` alarm fired would otherwise miss its run, so this independent
 * Worker-side sweep wakes any agent that is due.
 *
 * Crucially it decides due-ness WITHOUT waking every DO: it lists candidates from
 * the D1 `agents` registry, then checks each against a platform-side last-run
 * marker in SCHEDULE_KV (NOT the DO's own `agent_meta` marker). Only a genuinely
 * due agent gets its DO woken (via the `runScheduled` RPC). Per-agent failures
 * are isolated (one bad agent never aborts the batch) and concurrency is bounded.
 */
import { getAgentStub } from "../agent/index.ts";
import { listScheduledAgents } from "../db/index.ts";
import type { Env } from "../env.ts";
import { type AgentSchedule, isDue } from "./types.ts";

/** Max DOs woken concurrently per tick - bounds load on a busy heartbeat. */
const FANOUT_CONCURRENCY = 10;

/** SCHEDULE_KV key for an agent's platform-side last-run marker (epoch ms). */
function lastRunKey(agentId: string): string {
  return `lastrun:${agentId}`;
}

/** Read the platform-side last-run epoch ms for an agent, or null if never run. */
async function getLastRun(env: Env, agentId: string): Promise<number | null> {
  const raw = await env.SCHEDULE_KV.get(lastRunKey(agentId));
  if (raw === null) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}

/** Advance the platform-side last-run marker so the next tick won't re-fire it. */
async function setLastRun(
  env: Env,
  agentId: string,
  ts: number,
): Promise<void> {
  await env.SCHEDULE_KV.put(lastRunKey(agentId), String(ts));
}

/** Split `items` into chunks of at most `size` (for bounded concurrency). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Trigger every agent that is due as of `nowTs`. Returns the ids actually
 * triggered. For each candidate: read its platform-side last-run marker, decide
 * `isDue`, and if so wake its DO via `runScheduled` and advance the marker. A
 * single agent throwing (RPC failure, run error) is logged and skipped - it does
 * NOT abort the batch, and its marker is left unadvanced so the next tick retries.
 */
export async function runDueAgents(
  env: Env,
  nowTs: number,
): Promise<{ triggered: string[] }> {
  const candidates = await listScheduledAgents(env);
  const triggered: string[] = [];

  for (const batch of chunk(candidates, FANOUT_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (agent) => {
        try {
          const lastRunAt = await getLastRun(env, agent.id);
          // The fan-out only lists agents with a non-null cron; `enabled` is
          // implied by presence in the active registry listing.
          const schedule: AgentSchedule = {
            cron: agent.schedule_cron,
            enabled: true,
          };
          if (!isDue(schedule, nowTs, lastRunAt)) return;

          await getAgentStub(env, agent.id).runScheduled({
            kind: "report",
            scheduledFor: nowTs,
          });
          // Advance the marker ONLY after a successful trigger, so a failed run
          // is retried on the next heartbeat rather than skipped.
          await setLastRun(env, agent.id, nowTs);
          triggered.push(agent.id);
        } catch (err) {
          // Per-agent isolation: never let one agent's failure abort the batch.
          console.warn(
            `[schedule] fan-out failed for agent ${agent.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }

  return { triggered };
}
