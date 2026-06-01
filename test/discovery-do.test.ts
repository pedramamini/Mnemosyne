import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { generateModel, toolThenTextModel } from "./mock-model.ts";

// MNEMO-29: the Discovery stage runs inside the MnemosyneAgent DO. The model is
// MOCKED via testModelOverride (the workers pool can't swap the AI binding on a
// runtime-constructed DO), so the clarify-scope loop is deterministic and free -
// no real inference. Discovery is conversation-only: NO sandbox is warmed, so no
// testSandboxOverride is needed (unlike the research loop tests).

/** A complete, valid Discovery spec the mocked terminator finalizes with. */
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

/** A valid running self-assessment the mocked note_progress tool reports. */
const VALID_PROGRESS = {
  facetNotes: {
    subject: "Acme Corp specifically.",
    entityType: "A vendor.",
    sources: "",
    cadence: "",
    outputFormat: "",
  },
  confidence: 0.4,
};

async function freshAgentId(): Promise<string> {
  const account = await createAccount(env, {
    email: `discovery-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Discovery agent",
  });
  return agent.id;
}

describe("MnemosyneAgent Discovery", () => {
  it("startDiscovery initializes in_progress state with zero turns", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const state = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.startDiscovery({
          name: "Acme Watcher",
          description: "Track Acme Corp.",
        });
        return instance.getDiscoveryState();
      },
    );

    expect(state.status).toBe("in_progress");
    expect(state.spec).toBeNull();
    expect(state.turns).toBe(0);
  });

  it("a clarify-scope turn that does not finalize increments turns and stays in_progress", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const { reply, state } = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        // A plain text reply - the model asks a follow-up, does not finalize.
        instance.testModelOverride = generateModel(
          "Got it - which sources should I prioritize?",
        );
        instance.startDiscovery({
          name: "Acme Watcher",
          description: "Track Acme Corp.",
        });
        return instance.discoveryTurn("Watch Acme Corp's releases.");
      },
    );

    expect(reply).toContain("which sources");
    expect(state.status).toBe("in_progress");
    expect(state.spec).toBeNull();
    expect(state.turns).toBe(1);
  });

  it("refuses to finalize before the interview floor and stays in_progress", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const { reply, state } = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        // The model tries to finalize on the FIRST turn; the floor blocks it, so
        // the loop continues and it asks a follow-up instead (final text).
        instance.testModelOverride = toolThenTextModel(
          "finalize_discovery",
          VALID_SPEC,
          "Before I set this up - which sources should it watch?",
        );
        instance.startDiscovery({
          name: "Acme Watcher",
          description: "Track Acme Corp.",
        });
        return instance.discoveryTurn("Watch Acme Corp.");
      },
    );

    expect(state.status).toBe("in_progress");
    expect(state.spec).toBeNull();
    expect(state.turns).toBe(1);
    expect(reply).toContain("which sources");
  });

  it("note_progress persists a running self-assessment without finalizing", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const state = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        // The model reports progress (a tool call), then asks a question.
        instance.testModelOverride = toolThenTextModel(
          "note_progress",
          VALID_PROGRESS,
          "Which neighborhoods matter?",
        );
        instance.startDiscovery({
          name: "Acme Watcher",
          description: "Track Acme Corp.",
        });
        const turn = await instance.discoveryTurn("Watch Acme Corp.");
        return turn.state;
      },
    );

    expect(state.status).toBe("in_progress");
    expect(state.spec).toBeNull();
    expect(state.progress?.confidence).toBe(0.4);
    expect(state.progress?.facetNotes.subject).toBe("Acme Corp specifically.");
    // A facet the model does not understand yet stays an empty note (chip off).
    expect(state.progress?.facetNotes.sources).toBe("");
  });

  it("finalize_discovery flips to complete once the floor is met and persists to DO-SQLite", async () => {
    const agentId = await freshAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const state = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        instance.startDiscovery({
          name: "Acme Watcher",
          description: "Track Acme Corp.",
        });
        // Two real exchanges first - finalize is gated below DISCOVERY_MIN_TURNS.
        instance.testModelOverride = generateModel(
          "Which sources matter most?",
        );
        await instance.discoveryTurn("Watch Acme Corp's releases.");
        instance.testModelOverride = generateModel(
          "How often should it report?",
        );
        await instance.discoveryTurn("Their blog and security advisories.");
        // Third turn: floor met, the model finalizes. The run's stopWhen stops
        // the moment the terminator fires (mirrors MNEMO-18).
        instance.testModelOverride = toolThenTextModel(
          "finalize_discovery",
          VALID_SPEC,
          "All set.",
        );
        const turn = await instance.discoveryTurn(
          "Weekly is fine, a short brief.",
        );
        return turn.state;
      },
    );

    expect(state.status).toBe("complete");
    expect(state.turns).toBe(3);
    expect(state.spec?.subject).toBe(VALID_SPEC.subject);
    expect(state.spec?.entityType).toBe("vendor");

    // Re-acquire the stub by the SAME idFromName: the spec must read back from
    // DO-SQLite (proves it persisted, not just lived on the instance).
    const reread = await env.AGENT.get(
      env.AGENT.idFromName(agentId),
    ).getDiscoveryState();
    expect(reread.status).toBe("complete");
    expect(reread.spec?.name).toBe("Acme Watcher");
    expect(reread.spec?.confidence).toBe(0.92);
  });
});
