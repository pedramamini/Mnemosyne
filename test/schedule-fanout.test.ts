import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { runDueAgents } from "../src/schedule/fanout.ts";

// MNEMO-27: the cron fan-out (the platform heartbeat's worker). Seeds agents in
// the real (Miniflare) D1 `agents` registry + SCHEDULE_KV last-run markers, then
// drives runDueAgents against them. The `AGENT` DO + `DB`/`SCHEDULE_KV` bindings
// come from wrangler.toml, keyed by name in the workers pool.

/** A minute-boundary "now" so the every-minute cron math is exact. */
const NOW = Date.UTC(2026, 4, 24, 12, 0, 0);
/** 5 minutes before NOW - a "stale" marker that makes an every-minute cron due. */
const STALE = NOW - 5 * 60_000;

/** Seed an account + an active agent carrying `cron`; return its id. */
async function seedAgent(cron: string): Promise<string> {
  const account = await createAccount(env, {
    email: `fanout-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Scheduled agent",
    schedule_cron: cron,
  });
  return agent.id;
}

/** Set an agent's platform-side last-run marker in SCHEDULE_KV. */
async function setLastRun(agentId: string, ts: number): Promise<void> {
  await env.SCHEDULE_KV.put(`lastrun:${agentId}`, String(ts));
}

/** Read an agent's platform-side last-run marker (or null). */
async function getLastRun(agentId: string): Promise<string | null> {
  return env.SCHEDULE_KV.get(`lastrun:${agentId}`);
}

describe("runDueAgents (cron fan-out)", () => {
  it("triggers only due agents, isolates failures, and advances the marker", async () => {
    // A: due + its run succeeds (default stub runner).
    const aId = await seedAgent("* * * * *");
    await setLastRun(aId, STALE);
    // B: NOT due - its marker is fresh, so the next minute hasn't arrived.
    const bId = await seedAgent("* * * * *");
    await setLastRun(bId, NOW);
    // C: due, but its scheduled run throws - must not abort the batch.
    const cId = await seedAgent("* * * * *");
    await setLastRun(cId, STALE);
    await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(cId)),
      (inst: MnemosyneAgent) => {
        inst.scheduledRunner = () => Promise.reject(new Error("boom"));
      },
    );

    const first = await runDueAgents(env, NOW);

    // Only the due, succeeding agent is reported triggered.
    expect(first.triggered).toContain(aId);
    expect(first.triggered).not.toContain(bId); // not due
    expect(first.triggered).not.toContain(cId); // due but threw

    // A's failure-free run advanced its marker; C's failed run did NOT (so the
    // next heartbeat retries it).
    expect(await getLastRun(aId)).toBe(String(NOW));
    expect(await getLastRun(cId)).toBe(String(STALE));

    // An immediate second tick at the same NOW does not re-trigger A - its
    // marker now sits at NOW, so the next fire is in the future.
    const second = await runDueAgents(env, NOW);
    expect(second.triggered).not.toContain(aId);
  });

  it("triggers a never-run agent (no marker) then records it", async () => {
    const id = await seedAgent("* * * * *");
    // No SCHEDULE_KV marker → treated as never-run → due on the first tick.
    expect(await getLastRun(id)).toBeNull();

    const { triggered } = await runDueAgents(env, NOW);
    expect(triggered).toContain(id);
    expect(await getLastRun(id)).toBe(String(NOW));
  });
});

describe("MnemosyneAgent schedule arming", () => {
  it("enableSchedule arms a runScheduled timer; disableSchedule cancels it", async () => {
    const id = await seedAgent("0 9 * * *");
    const stub = env.AGENT.get(env.AGENT.idFromName(id));

    const enabled = await stub.enableSchedule("0 9 * * *");
    expect(enabled).toEqual({ cron: "0 9 * * *", enabled: true });

    // A single delayed `runScheduled` alarm is now armed.
    const armed = await runInDurableObject(
      stub,
      async (inst: MnemosyneAgent) => {
        const schedules = await inst.listSchedules({ type: "delayed" });
        return schedules.filter((s) => s.callback === "runScheduled");
      },
    );
    expect(armed).toHaveLength(1);

    const disabled = await stub.disableSchedule();
    expect(disabled.enabled).toBe(false);

    // The timer is cancelled.
    const afterDisable = await runInDurableObject(
      stub,
      async (inst: MnemosyneAgent) => {
        const schedules = await inst.listSchedules({ type: "delayed" });
        return schedules.filter((s) => s.callback === "runScheduled");
      },
    );
    expect(afterDisable).toHaveLength(0);
  });
});
