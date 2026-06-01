import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { defaultSchedule, defaultSettings } from "../src/agent/index.ts";

// DO binding `AGENT` (class MnemosyneAgent) is configured in wrangler.toml and
// declared in the `main` worker, so the vitest-pool-workers DO helpers
// (runInDurableObject, abortAllDurableObjects) can drive it. Each test uses a
// distinct idFromName so DO state doesn't collide.

describe("MnemosyneAgent Durable Object", () => {
  it("returns defaults on a fresh DO, then persists settings through SQLite", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("agent-settings"));

    // (b) Fresh DO → defaults. runInDurableObject gives direct instance access.
    const fresh = await runInDurableObject(stub, (instance: MnemosyneAgent) =>
      instance.getSettings(),
    );
    expect(fresh).toEqual(defaultSettings());

    // (c) Write through the RPC boundary (the exact path the debug route uses),
    // then read back and confirm the value persisted.
    const updated = await stub.updateSettings({ template: "vendor" });
    expect(updated.template).toBe("vendor");
    expect(await stub.getSettings()).toEqual({
      ...defaultSettings(),
      template: "vendor",
    });
  });

  it("merges patches without clobbering untouched fields", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("agent-merge"));
    await stub.updateSettings({ template: "founder" });
    await stub.updateSettings({ model: "anthropic/claude-opus-4" });

    // The second patch must not reset `template` set by the first.
    expect(await stub.getSettings()).toEqual({
      model: "anthropic/claude-opus-4",
      template: "founder",
      systemPrompt: null,
      enabledTools: [],
    });
  });

  it("idFromName is stable: re-acquiring the stub by name sees the same state", async () => {
    // (d) Same name → same DO. Prove a new stub handle reads prior writes.
    const first = env.AGENT.get(env.AGENT.idFromName("agent-stable"));
    await first.updateSettings({ systemPrompt: "Track competitor launches." });

    const second = env.AGENT.get(env.AGENT.idFromName("agent-stable"));
    expect((await second.getSettings()).systemPrompt).toBe(
      "Track competitor launches.",
    );
  });

  it("round-trips the run schedule", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("agent-schedule"));
    expect(await stub.getScheduleConfig()).toEqual(defaultSchedule());

    const updated = await stub.updateScheduleConfig({
      cron: "0 9 * * *",
      enabled: true,
    });
    expect(updated).toEqual({ cron: "0 9 * * *", enabled: true });
    expect(await stub.getScheduleConfig()).toEqual({
      cron: "0 9 * * *",
      enabled: true,
    });
  });

  // PRD §7.1 - hibernation survival is a hard requirement of the harness host.
  // State must live in `ctx.storage.sql`, not in-memory instance fields that
  // vanish on hibernation. `abortAllDurableObjects()` tears down live instances
  // WITHOUT deleting persisted SQLite - i.e. exactly a hibernation/eviction
  // event. Reading the values back from a freshly-woken instance proves they
  // round-tripped through SQLite, not volatile memory.
  it("survives hibernation: state lives in ctx.storage.sql", async () => {
    const name = "agent-hibernate";
    const before = env.AGENT.get(env.AGENT.idFromName(name));
    await before.updateSettings({
      template: "investor",
      systemPrompt: "Watch funding rounds.",
    });
    await before.updateScheduleConfig({ cron: "0 6 * * 1", enabled: true });

    await abortAllDurableObjects();

    const after = env.AGENT.get(env.AGENT.idFromName(name));
    expect(await after.getSettings()).toEqual({
      model: null,
      template: "investor",
      systemPrompt: "Watch funding rounds.",
      enabledTools: [],
    });
    expect(await after.getScheduleConfig()).toEqual({
      cron: "0 6 * * 1",
      enabled: true,
    });
  });
});
