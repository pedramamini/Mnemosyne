import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import {
  buildSystemPrompt,
  currentDateLayer,
  ownerProfileLayer,
} from "../src/agent/prompts.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { generateModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-15: the headless counterpart of the interactive turn - a non-streaming
// generateText loop (runHeadless) for scheduled/background work. The mock model
// is injected via testModelOverride so the loop runs hermetically.

describe("MnemosyneAgent.runHeadless", () => {
  it("returns text + finishReason and respects the supplied step budget", async () => {
    const account = await createAccount(env, {
      email: `headless-${crypto.randomUUID()}@example.com`,
    });
    const agent = await createAgent(env, {
      account_id: account.id,
      name: "Headless agent",
      template: "investor",
      system_prompt: "Watch funding rounds.",
    });
    const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));

    const result = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.testModelOverride = generateModel("Headless findings.");
        // runHeadless now builds the MNEMO-16 tool catalog over a warm sandbox;
        // inject a stub container (the workers pool can't boot a real one).
        instance.testSandboxOverride = stubSandboxClient().client;
        return instance.runHeadless({ prompt: "Summarize.", stepBudget: 5 });
      },
    );

    expect(result.text).toContain("Headless findings.");
    expect(result.finishReason).toBe("stop");
    // Empty tool map → the loop completes in one step, comfortably under (and so
    // respecting) the supplied budget of 5.
    expect(result.steps).toBeGreaterThanOrEqual(1);
    expect(result.steps).toBeLessThanOrEqual(5);
  });
});

describe("buildSystemPrompt", () => {
  it("layers the base persona, the template overlay, and the agent's own system prompt", () => {
    const prompt = buildSystemPrompt({
      template: "vendor",
      systemPrompt: "Track Acme releases.",
    });
    expect(prompt).toContain("You are Mnemosyne"); // base persona
    expect(prompt).toContain("vendor / supplier"); // template overlay
    expect(prompt).toContain("Track Acme releases."); // operator's own prompt

    // Fixed order: base → template overlay → operator instructions.
    const baseAt = prompt.indexOf("You are Mnemosyne");
    const overlayAt = prompt.indexOf("vendor / supplier");
    const ownAt = prompt.indexOf("Track Acme releases.");
    expect(baseAt).toBeLessThan(overlayAt);
    expect(overlayAt).toBeLessThan(ownAt);
  });

  it("skips null/empty overlays cleanly (base persona always present)", () => {
    const bare = buildSystemPrompt({ template: null, systemPrompt: null });
    expect(bare).toContain("You are Mnemosyne");
    expect(bare).not.toContain("vendor / supplier");
    expect(bare).not.toContain("Operator instructions");
  });

  it("injects the current date right after the persona and ties it to tool use", () => {
    const now = new Date("2026-05-25T14:30:00Z");
    const prompt = buildSystemPrompt(
      { template: null, systemPrompt: null },
      { now },
    );
    expect(prompt).toContain("Current date and time");
    expect(prompt).toContain("May 25, 2026"); // formatted UTC date
    expect(prompt).toContain("webSearch"); // steers to tools for current facts

    // Date layer sits between the base persona and any later layers.
    expect(prompt.indexOf("You are Mnemosyne")).toBeLessThan(
      prompt.indexOf("Current date and time"),
    );
  });

  it("renders the date in the owner's timezone and includes the owner profile", () => {
    const now = new Date("2026-05-25T02:30:00Z"); // still May 24 in Chicago
    const prompt = buildSystemPrompt(
      {
        template: null,
        systemPrompt: "Track Acme.",
        timezone: "America/Chicago",
        owner: { name: "Pedram", notes: "Direct, no fluff." },
      },
      { now },
    );
    expect(prompt).toContain("May 24, 2026"); // local date, not the UTC May 25
    expect(prompt).toContain("About the person you work for");
    expect(prompt).toContain("Their name is Pedram.");
    expect(prompt).toContain("Direct, no fluff.");

    // Owner layer precedes the operator instructions (who, then what they asked).
    expect(prompt.indexOf("About the person you work for")).toBeLessThan(
      prompt.indexOf("Operator instructions"),
    );
  });
});

describe("currentDateLayer", () => {
  it("falls back to UTC for an unknown timezone instead of throwing", () => {
    const now = new Date("2026-05-25T14:30:00Z");
    const layer = currentDateLayer(now, "Mars/Olympus_Mons");
    expect(layer).toContain("May 25, 2026");
    expect(layer).toContain("UTC");
  });
});

describe("ownerProfileLayer", () => {
  it("returns null when there is nothing worth stating", () => {
    expect(ownerProfileLayer({ name: null, notes: null })).toBeNull();
    expect(ownerProfileLayer({ name: "  ", notes: "" })).toBeNull();
  });

  it("includes only the fields that are present", () => {
    const notesOnly = ownerProfileLayer({ name: null, notes: "Loves charts." });
    expect(notesOnly).toContain("Loves charts.");
    expect(notesOnly).not.toContain("Their name is");
  });
});
