import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { AssessmentInput } from "../src/agent/assessment/types.ts";
import type { DiscoverySpec } from "../src/agent/discovery/types.ts";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { buildSystemPrompt } from "../src/agent/prompts.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import type { ResolvedModel } from "../src/llm/getModel.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/llm/types.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// The weekly self-assessment ("Karpathy loop"): the agent reviews itself against
// its mission and SELF-ITERATES by rewriting its own operating playbook - the
// "system prompt learning" artifact the DO then folds into every later turn. Here
// we drive one review with a mock model that fires the `record_assessment`
// terminator, and assert the record is stored AND the rewritten playbook is cached
// (so subsequent turns inherit it) and mirrored to a brain note.

const VALID_SPEC: DiscoverySpec = {
  name: "Acme Watcher",
  description: "Track Acme Corp's product and security news.",
  subject: "Acme Corp, the SaaS vendor",
  entityType: "vendor",
  sources: ["acme.example/blog"],
  cadence: "weekly on Mondays",
  outputFormat: "a short markdown brief",
  confidence: 0.92,
  facetNotes: {
    subject: "Acme.",
    entityType: "Vendor.",
    sources: "Blog.",
    cadence: "Weekly.",
    outputFormat: "Brief.",
  },
  finalizedAt: "2026-05-25T00:00:00.000Z",
};

const ASSESSMENT: AssessmentInput = {
  grade: "needs_attention",
  summary: "Good coverage of releases; pricing has gone stale.",
  wins: ["Release notes are current"],
  gaps: ["Pricing page not checked in weeks"],
  lessons: ["Re-check the pricing page every run - it changes quietly"],
  adjustments: { focus: "pricing", cadence: "twice weekly" },
  operatingNotes:
    "PLAYBOOK: Always re-check acme.example/pricing first - it changes without announcement. Lead the brief with security advisories. Skip low-signal press releases.",
};

/** A model that fires the `record_assessment` terminator with a fixed assessment. */
function assessmentModel(input: AssessmentInput): ResolvedModel {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "record_assessment",
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: {
        inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  return {
    model,
    config: { provider: "workers-ai", model: DEFAULT_WORKERS_AI_MODEL },
  };
}

/**
 * Neutralize alarm-arming so the test drives the review directly without the
 * `build`-armed deep-dive alarm firing mid-test (in production the two loops run
 * on their own alarms; here we exercise `runWeeklyAssessment` in isolation).
 */
function neutralizeAlarms(instance: MnemosyneAgent): void {
  const schedule = async () => ({ id: "test-noop" });
  (instance as unknown as { schedule: typeof schedule }).schedule = schedule;
  (
    instance as unknown as { cancelSchedule: () => Promise<void> }
  ).cancelSchedule = async () => {};
}

async function builtAgentId(): Promise<string> {
  const account = await createAccount(env, {
    email: `assess-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Assessment agent",
  });
  return agent.id;
}

describe("MnemosyneAgent weekly self-assessment", () => {
  it("records a review and folds the rewritten playbook into its own context", async () => {
    const agentId = await builtAgentId();
    const stub = env.AGENT.get(env.AGENT.idFromName(agentId));

    const result = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const { stub: sb, client } = stubSandboxClient();
        instance.testSandboxOverride = client;
        neutralizeAlarms(instance);
        instance.completeDiscovery(VALID_SPEC);

        // Build (provisioning only - no model needed) so the agent is `ready`,
        // which the self-review requires.
        await instance.build();

        // No playbook before the first review.
        const before = instance.getOperatingNotes();

        instance.testModelOverride = assessmentModel(ASSESSMENT);
        await instance.runWeeklyAssessment();

        return {
          before,
          state: instance.getAssessmentState(),
          notesAfter: instance.getOperatingNotes(),
          writes: sb.writes.map((w) => w.path),
        };
      },
    );

    // No playbook before the review.
    expect(result.before).toBeNull();

    // The review was recorded (rolling history + counters).
    expect(result.state.runCount).toBe(1);
    expect(result.state.lastRecord?.grade).toBe("needs_attention");
    expect(result.state.lastRecord?.lessons).toContain(
      "Re-check the pricing page every run - it changes quietly",
    );
    expect(result.state.history).toHaveLength(1);

    // System-prompt learning: the rewritten playbook is now cached so every later
    // turn's prompt carries it.
    expect(result.notesAfter).toBe(ASSESSMENT.operatingNotes);

    // …and mirrored to a versioned brain note for the human to read.
    expect(result.writes.some((p) => p.includes("operating-playbook"))).toBe(
      true,
    );
  });

  it("injects the operating playbook into the layered system prompt", () => {
    // The wiring contract: a non-null `operatingNotes` on the persona context
    // becomes a "What you've learned…" layer (after the operator instructions,
    // before per-turn extras). This is the runtime payoff of system-prompt learning.
    const withNotes = buildSystemPrompt({
      template: "vendor",
      systemPrompt: "Track Acme.",
      operatingNotes: ASSESSMENT.operatingNotes,
    });
    expect(withNotes).toContain(
      "What you've learned about doing this job well",
    );
    expect(withNotes).toContain("Always re-check acme.example/pricing");
    // Order: operator instructions precede the learned playbook.
    expect(withNotes.indexOf("Track Acme.")).toBeLessThan(
      withNotes.indexOf("Always re-check acme.example/pricing"),
    );

    // Null/absent playbook ⇒ no learned-notes layer (the common pre-review case).
    const bare = buildSystemPrompt({ template: null, systemPrompt: null });
    expect(bare).not.toContain("What you've learned about doing this job well");
  });
});
