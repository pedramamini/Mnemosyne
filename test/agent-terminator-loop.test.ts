import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import type { FinalReportData } from "../src/tools/reportSchema.ts";
import { generateModel, toolThenTerminatorModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-18: the terminator is the deliberate exit of a headless deep-research
// run. When the model calls submitFinalReport, runHeadless returns its captured
// report and stopWhen ends the loop promptly. A run that finishes WITHOUT the
// terminator is the detectable soft-fail: finalReport is null and an error-level
// audit note is emitted.

const REPORT: FinalReportData = {
  title: "Repo Survey",
  summary: "Surveyed the repository and summarized its layout.",
  sections: [{ heading: "Layout", body: "src/ holds the worker + DO." }],
  keyFindings: ["Worker + DO topology"],
  sources: [{ url: "https://example.com/repo" }],
  confidence: "high",
};

async function newAgentStub() {
  const account = await createAccount(env, {
    email: `term-${crypto.randomUUID()}@example.com`,
  });
  const agent = await createAgent(env, {
    account_id: account.id,
    name: "Terminator agent",
    template: "vendor",
    system_prompt: "Survey the repo.",
  });
  return env.AGENT.get(env.AGENT.idFromName(agent.id));
}

describe("MnemosyneAgent.runHeadless - terminator exit", () => {
  it("returns the captured report and stops promptly when the terminator fires", async () => {
    const stub = await newAgentStub();

    const outcome = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const sandbox = stubSandboxClient();
        sandbox.stub.onRun("echo hi", { stdout: "hi\n", exitCode: 0 });

        const sink: AuditInput[] = [];
        instance.testAuditSink = sink;
        instance.testSandboxOverride = sandbox.client;
        // Step 1: runShell. Step 2: submitFinalReport(REPORT) → terminator fires.
        instance.testModelOverride = toolThenTerminatorModel(
          "runShell",
          { command: "echo hi" },
          REPORT,
        );

        const result = await instance.runHeadless({
          prompt: "Survey the repo and report.",
          sessionId: "run-1",
          stepBudget: 50,
        });
        return {
          result,
          sink,
          commands: sandbox.stub.runs.map((r) => r.command),
        };
      },
    );

    // The research tool ran, then the terminator captured the structured report.
    expect(outcome.commands).toContain("echo hi");
    expect(outcome.result.finalReport).toEqual(REPORT);
    // stopWhen ended the loop the moment the terminator fired - well under budget.
    expect(outcome.result.steps).toBeLessThanOrEqual(3);
    expect(outcome.result.steps).toBeGreaterThanOrEqual(2);
    // The terminator narrated a report.generated event; no soft-fail note.
    expect(outcome.sink.some((e) => e.type === "report.generated")).toBe(true);
    expect(
      outcome.sink.some((e) => e.type === "narration" && e.level === "error"),
    ).toBe(false);
  });

  it("returns null + emits an error note when the run ends without the terminator", async () => {
    const stub = await newAgentStub();

    const outcome = await runInDurableObject(
      stub,
      async (instance: MnemosyneAgent) => {
        const sink: AuditInput[] = [];
        instance.testAuditSink = sink;
        instance.testSandboxOverride = stubSandboxClient().client;
        // Finishes with prose and stops - never calls submitFinalReport.
        instance.testModelOverride = generateModel("Here is what I found.");

        const result = await instance.runHeadless({
          prompt: "Survey the repo and report.",
          sessionId: "run-2",
          stepBudget: 50,
        });
        return { result, sink };
      },
    );

    expect(outcome.result.finalReport).toBeNull();
    // The detectable soft-fail: an error-level narration note for the missing report.
    const softFail = outcome.sink.find(
      (e) => e.type === "narration" && e.level === "error",
    );
    expect(softFail).toBeDefined();
    expect(softFail?.text).toContain("without a final report");
    expect(softFail?.sessionId).toBe("run-2");
    // No report.generated, since the terminator never fired.
    expect(outcome.sink.some((e) => e.type === "report.generated")).toBe(false);
  });
});
