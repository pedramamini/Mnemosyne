import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { generateModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// The agent's recurring autonomic loops (post-onboarding): a NIGHTLY "dream"
// (memory consolidation) that runs only on nights the agent was used, and a
// WEEKLY research update that - right after it finishes - kicks off the Karpathy
// self-review. These drive the DO methods directly with a stub sandbox + mock
// model (no container, no real inference).

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
    email: `autonomic-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Autonomic agent",
  });
  return agent.id;
}

/** Replace the DO's alarm scheduler with a no-op so manual driving never races a
 * real alarm; the variant returns the recorded method names. */
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

describe("MnemosyneAgent nightly dream (used-gate)", () => {
  it("dreams when used, then skips the next night if nothing happened since", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const { runsAfterFirst, runsAfterSecond } = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const { stub: sb, client } = stubSandboxClient();
        instance.testSandboxOverride = client;
        instance.testModelOverride = generateModel("noop");
        recordAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);
        await instance.build(); // → ready; build warmed the sandbox (= "used")

        // First night: the agent was used (by build), so it dreams - warming the
        // sandbox and stamping the last-dream marker.
        await instance.runNightlyConsolidation();
        const runsAfterFirst = sb.runs.length;

        // Second night with NO activity in between: the gate skips it BEFORE any
        // warm, so the sandbox is never touched again.
        await instance.runNightlyConsolidation();
        const runsAfterSecond = sb.runs.length;

        return { runsAfterFirst, runsAfterSecond };
      },
    );

    expect(runsAfterFirst).toBeGreaterThan(0); // it actually dreamt (warmed)
    expect(runsAfterSecond).toBe(runsAfterFirst); // the next night was skipped
  });
});

describe("MnemosyneAgent weekly research update", () => {
  it("runs real research and arms the Karpathy self-review right after", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const armed = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testSandboxOverride = stubSandboxClient().client;
        instance.testModelOverride = generateModel("Nothing new this week.");
        const armed = recordAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);
        await instance.build();

        armed.length = 0; // ignore build-time arming; watch only the scheduled run
        await instance.runScheduled({ kind: "report" });
        return armed;
      },
    );

    // The research update arms the self-review (chained, not a standalone cron) and
    // re-chains the next weekly research run.
    expect(armed).toContain("runWeeklyAssessment");
    expect(armed).toContain("runScheduled");
  });
});
