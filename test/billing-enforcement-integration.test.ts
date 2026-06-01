import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { countActiveSlots } from "../src/billing/concurrency.ts";
import { recordUsage } from "../src/billing/meter.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { generateModel } from "./mock-model.ts";
import { makeStubSandbox, stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-49: enforcement wired into the agent loop (DO + D1 + KV; sandbox + model
// mocked). An over-cap account is blocked BEFORE booting the sandbox or calling
// the model; a within-budget run boots (leases a slot), meters its LLM tokens,
// then releases the slot + meters sandbox-seconds on teardown.

interface SeededAgent {
  accountId: string;
  agentId: string;
}

async function seedAgent(): Promise<SeededAgent> {
  const account = await createAccount(env, {
    email: `enforce-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Enforcement agent",
    template: "vendor",
    system_prompt: "Track releases.",
  });
  return { accountId: account.id, agentId: agent.id };
}

async function countUsage(accountId: string, kind: string): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM usage_events WHERE account_id = ? AND kind = ?",
  )
    .bind(accountId, kind)
    .all<{ n: number }>();
  return results[0].n;
}

describe("billing enforcement in the agent loop", () => {
  it("blocks an over-cap run: sandbox NOT booted, model NOT called, cost_cap + audit", async () => {
    const { accountId, agentId } = await seedAgent();
    // Push the account well past the free cap (200¢ less 25¢ headroom).
    await recordUsage(env, { accountId, kind: "sms_segment", quantity: 300 });

    const stub = makeStubSandbox();
    const model = generateModel("should never run");
    const auditSink: AuditInput[] = [];

    const result = await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (inst: MnemosyneAgent) => {
        inst.testModelOverride = model;
        inst.testSandboxOverride = stubSandboxClient(stub).client;
        inst.testAuditSink = auditSink;
        return inst.runHeadless({ prompt: "Summarize." });
      },
    );

    // The run is refused with a cost_cap admission failure.
    expect(result.admission?.allowed).toBe(false);
    expect(result.admission?.reason).toBe("cost_cap");
    expect(result.finishReason).toBe("blocked:cost_cap");

    // The model was NEVER invoked and the sandbox was NEVER booted.
    const mock = model.model as unknown as { doGenerateCalls: unknown[] };
    expect(mock.doGenerateCalls.length).toBe(0);
    expect(stub.runs.length).toBe(0);
    expect(await countActiveSlots(env, accountId)).toBe(0);

    // The user can see WHY: an error + a narration on the audit stream.
    expect(auditSink.some((e) => e.type === "error")).toBe(true);
    expect(auditSink.some((e) => e.type === "narration")).toBe(true);

    // Nothing was metered for the blocked run.
    expect(await countUsage(accountId, "llm_tokens")).toBe(0);
    expect(await countUsage(accountId, "sandbox_sec")).toBe(0);
  });

  it("admits a within-budget run: boots + leases, meters llm_tokens, then releases + meters sandbox_sec", async () => {
    const { accountId, agentId } = await seedAgent();

    const stub = makeStubSandbox();
    const stubResult = await runInDurableObject(
      env.AGENT.get(env.AGENT.idFromName(agentId)),
      async (inst: MnemosyneAgent) => {
        inst.testModelOverride = generateModel("Findings.");
        inst.testSandboxOverride = stubSandboxClient(stub).client;
        const run = await inst.runHeadless({ prompt: "Research." });
        // After the run the boot leased a concurrency slot.
        const leasedNow = await countActiveSlots(env, accountId);
        // Teardown: release the slot + meter the active sandbox-seconds.
        await inst.meterAndReleaseSandbox();
        return { run, leasedNow };
      },
    );

    // The run was admitted (no admission failure) and completed normally.
    expect(stubResult.run.admission).toBeUndefined();
    expect(stubResult.run.finishReason).toBe("stop");

    // A slot was leased during the boot, then released on teardown.
    expect(stubResult.leasedNow).toBe(1);
    expect(await countActiveSlots(env, accountId)).toBe(0);

    // Both ledgers recorded: LLM tokens for the turn + sandbox-seconds on stop.
    expect(await countUsage(accountId, "llm_tokens")).toBeGreaterThanOrEqual(1);
    expect(await countUsage(accountId, "sandbox_sec")).toBeGreaterThanOrEqual(
      1,
    );
  });
});
