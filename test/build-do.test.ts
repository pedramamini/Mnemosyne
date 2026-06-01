import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent, getAgent } from "../src/db/index.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-30: the Build stage runs inside the MnemosyneAgent DO. The sandbox is
// MOCKED via testSandboxOverride (the workers pool can't boot a container), so
// provisionFilesystem drives the recording stub instead of a real container, and
// the D1 registry update lands in the real (Miniflare) `agents` table. No model
// is used - Build is provisioning, not research.

/** A complete, valid Discovery spec the agent has already finalized. */
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
    email: `build-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Build agent",
  });
  return agent.id;
}

describe("MnemosyneAgent Build", () => {
  it("refuses to build before Discovery is complete and writes nothing", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const { status, runs, mkdirs, writes } = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const { stub: sb, client } = stubSandboxClient();
        instance.testSandboxOverride = client;
        const status = await instance.build();
        return {
          status,
          runs: sb.runs.length,
          mkdirs: sb.mkdirs.length,
          writes: sb.writes.length,
        };
      },
    );

    // Typed "needs finalized spec" failure.
    expect(status.phase).toBe("failed");
    expect(status.error).toContain("Discovery");
    expect(status.completed).toEqual([]);

    // The sandbox was never touched (no provisioning before the spec gate).
    expect(runs).toBe(0);
    expect(mkdirs).toBe(0);
    expect(writes).toBe(0);

    // Nothing persisted: settings + build status stay at their defaults.
    const fresh = env.AGENT.get(env.AGENT.idFromName(agentId));
    expect((await fresh.getSettings()).systemPrompt).toBeNull();
    expect((await fresh.getBuildStatus()).phase).toBe("not_started");
  });

  it("provisions, configures, and goes live from a finalized spec - and is idempotent", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const result = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const { stub: sb, client } = stubSandboxClient();
        instance.testSandboxOverride = client;
        // The agent has already finalized Discovery.
        instance.completeDiscovery(VALID_SPEC);

        const first = await instance.build();
        const mkdirsAfterFirst = sb.mkdirs.slice();
        // Idempotence: a second build must not re-run the filesystem steps.
        const second = await instance.build();
        const mkdirsAfterSecond = sb.mkdirs.slice();

        return { first, second, mkdirsAfterFirst, mkdirsAfterSecond };
      },
    );

    // (b) Build reached ready with every step completed.
    expect(result.first.phase).toBe("ready");
    expect(result.first.error).toBeNull();
    expect(result.first.builtAt).not.toBeNull();
    expect(result.first.completed).toEqual(
      expect.arrayContaining([
        "fs_init",
        "git_init",
        "template_applied",
        "system_prompt",
        "tools_enabled",
        "schedule_defaults",
        "registry_synced",
      ]),
    );

    // The mocked sandbox received the brain-layout creation calls.
    expect(result.mkdirsAfterFirst).toContain("/brain/notes");
    expect(result.mkdirsAfterFirst).toContain("/brain/tools");

    // (c) Idempotence: the second build did not error and did not double the
    // filesystem work - the mkdir call count is unchanged.
    expect(result.second.phase).toBe("ready");
    expect(result.second.error).toBeNull();
    expect(result.mkdirsAfterSecond).toEqual(result.mkdirsAfterFirst);

    // Settings now carry a non-empty system prompt + the template + tool set.
    const fresh = env.AGENT.get(env.AGENT.idFromName(agentId));
    const settings = await fresh.getSettings();
    expect(settings.systemPrompt).toBeTruthy();
    expect(settings.systemPrompt).toContain(VALID_SPEC.subject);
    expect(settings.template).toBe("vendor");
    expect(settings.enabledTools.length).toBeGreaterThan(0);

    // Schedule defaults are enabled with the template's default cadence.
    const schedule = await fresh.getScheduleConfig();
    expect(schedule.cron).toBe("0 13 * * 1");
    expect(schedule.enabled).toBe(true);

    // Build status reads back ready.
    expect((await fresh.getBuildStatus()).phase).toBe("ready");

    // The D1 registry row is promoted to operational and mirrors the build.
    const row = await getAgent(env, agentId);
    expect(row?.status).toBe("operational");
    expect(row?.template).toBe("vendor");
    expect(row?.schedule_cron).toBe("0 13 * * 1");
    expect(row?.system_prompt).toBeTruthy();
  });
});
