import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { generateModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// The initial deep dive: after Build provisions an agent, it runs a fixed
// SIX-phase initial research pass that fills the brain before the agent settles
// into its cadence. Each phase is its own alarm-driven `runHeadless` pass; here we
// drive the public `runDeepDivePhase` step directly (no alarm clock needed) with a
// mock model + stub sandbox, and assert the phase cursor advances to completion.

const VALID_SPEC: DiscoverySpec = {
  name: "Acme Watcher",
  description: "Track Acme Corp's product and security news.",
  subject: "Acme Corp, the SaaS vendor",
  entityType: "vendor",
  sources: ["acme.example/blog", "security advisories"],
  cadence: "weekly on Mondays",
  outputFormat: "a short markdown brief, newest changes first",
  confidence: 0.92,
  facetNotes: {
    subject: "Acme Corp specifically.",
    entityType: "A vendor.",
    sources: "Blog + advisories.",
    cadence: "Weekly.",
    outputFormat: "Brief, change-led.",
  },
  finalizedAt: "2026-05-25T00:00:00.000Z",
};

async function freshAgentId(): Promise<string> {
  const account = await createAccount(env, {
    email: `deepdive-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Deep dive agent",
  });
  return agent.id;
}

/**
 * Neutralize the DO's alarm-arming so a test can drive `runDeepDivePhase` by hand
 * deterministically. In production the dive advances purely via these alarms (each
 * phase arms the next - strictly sequential); a test that ALSO calls the phase
 * step manually must not have the real `build`-armed alarm fire mid-test and race
 * the manual calls.
 */
function neutralizeAlarms(instance: MnemosyneAgent): void {
  const schedule = async () => ({ id: "test-noop" });
  (instance as unknown as { schedule: typeof schedule }).schedule = schedule;
  (
    instance as unknown as { cancelSchedule: () => Promise<void> }
  ).cancelSchedule = async () => {};
}

/**
 * Like {@link neutralizeAlarms}, but records the method NAME of every armed alarm
 * so a test can assert which recurring loops were scheduled (rather than letting
 * any real alarm fire mid-test). Returns the recording array.
 */
function recordAlarms(instance: MnemosyneAgent): string[] {
  const armed: string[] = [];
  const schedule = async (_delaySec: number, method: string) => {
    armed.push(method);
    return { id: `noop-${armed.length}` };
  };
  (instance as unknown as { schedule: typeof schedule }).schedule = schedule;
  (
    instance as unknown as { cancelSchedule: () => Promise<void> }
  ).cancelSchedule = async () => {};
  return armed;
}

describe("MnemosyneAgent deep dive", () => {
  it("Build kicks off the dive; phases advance to completion", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const result = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testModelOverride = generateModel("Phase findings.");
        neutralizeAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);

        // Build arms the dive (only schedules - does not run a phase synchronously).
        await instance.build();
        const afterBuild = instance.getDeepDiveStatus();

        // Drive each phase by hand (the alarm would otherwise fire these). Six
        // phases → six steps; the last finalizes the dive.
        const total = afterBuild.phases.length;
        for (let i = 0; i < total; i++) await instance.runDeepDivePhase();

        return { afterBuild, final: instance.getDeepDiveStatus() };
      },
    );

    // Build kicked the dive into `running` with the full 6-phase plan, all pending.
    expect(result.afterBuild.phase).toBe("running");
    expect(result.afterBuild.phases).toHaveLength(6);
    expect(result.afterBuild.phases.map((p) => p.id)).toEqual([
      "orient",
      "landscape",
      "developments",
      "facets",
      "tooling",
      "synthesis",
    ]);
    expect(result.afterBuild.phases.every((p) => p.status === "pending")).toBe(
      true,
    );

    // After driving every phase, the dive is complete with a finish timestamp and
    // every phase marked complete.
    expect(result.final.phase).toBe("complete");
    expect(result.final.finishedAt).not.toBeNull();
    expect(result.final.phases.every((p) => p.status === "complete")).toBe(
      true,
    );
    expect(result.final.phases.every((p) => p.finishedAt !== null)).toBe(true);
  });

  it("arms the nightly dream when the dive completes (review is research-triggered)", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const armed = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testModelOverride = generateModel("Phase findings.");
        const armed = recordAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);

        await instance.build();
        // Drive all six phases; the final one finalizes the dive, which arms the
        // nightly dream.
        const total = instance.getDeepDiveStatus().phases.length;
        for (let i = 0; i < total; i++) await instance.runDeepDivePhase();

        return armed;
      },
    );

    // Onboarding completion arms the nightly dream - but NOT the self-review, which
    // now fires only after a weekly research update (not on its own cron).
    expect(armed).toContain("runNightlyConsolidation");
    expect(armed).not.toContain("runWeeklyAssessment");
  });

  it("startDeepDive is idempotent and never restarts a running dive", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const { first, second } = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testModelOverride = generateModel("Phase findings.");
        neutralizeAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);

        const first = await instance.startDeepDive();
        // Advance one phase so the dive is mid-flight, then re-kick.
        await instance.runDeepDivePhase();
        const second = await instance.startDeepDive();
        return { first, second };
      },
    );

    expect(first.phase).toBe("running");
    // The second kick returned the in-flight status - it did NOT reset the cursor.
    expect(second.phase).toBe("running");
    expect(second.phases[0].status).toBe("complete");
  });

  it("does nothing without a finalized Discovery spec", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const status = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = stubSandboxClient().client;
        return instance.startDeepDive();
      },
    );

    expect(status.phase).toBe("not_started");
  });
});
