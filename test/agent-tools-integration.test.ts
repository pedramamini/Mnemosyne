import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import { toolThenTextModel } from "./mock-model.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-16: proves the tool registry is wired into the agentic loop. A mock
// LanguageModel emits a `runShell` tool call then a final message; the SDK loop
// must execute the tool against the (stub) sandbox, feed the result back, and
// terminate under stopWhen - all driven through MnemosyneAgent.runHeadless.

describe("MnemosyneAgent - tool registry wired into the loop", () => {
  it("executes a model-issued runShell call against the sandbox, then finishes", async () => {
    const account = await createAccount(env, {
      email: `tools-${crypto.randomUUID()}@example.com`,
    });
    const agent = await createAgent(env, {
      account_id: account.id,
      name: "Tooling agent",
      template: "product",
      system_prompt: "Investigate the repository.",
    });
    const agentStub = env.AGENT.get(env.AGENT.idFromName(agent.id));

    const outcome = await runInDurableObject(
      agentStub,
      async (instance: MnemosyneAgent) => {
        const sandbox = stubSandboxClient();
        sandbox.stub.onRun("echo hi", { stdout: "hi\n", exitCode: 0 });

        // Scripted model: first call → runShell tool call; second call → text.
        instance.testModelOverride = toolThenTextModel(
          "runShell",
          { command: "echo hi" },
          "All done.",
        );
        instance.testSandboxOverride = sandbox.client;

        const result = await instance.runHeadless({
          prompt: "Run a shell command.",
          sessionId: "run-1",
        });
        return { result, commands: sandbox.stub.runs.map((r) => r.command) };
      },
    );

    // The tool actually executed against the stub sandbox...
    expect(outcome.commands).toContain("echo hi");
    // ...the result fed back into the loop, which then produced the final text...
    expect(outcome.result.text).toContain("All done.");
    // ...and the loop terminated on a model stop (under the stopWhen ceiling),
    // taking two steps: the tool round-trip then the final message.
    expect(outcome.result.finishReason).toBe("stop");
    expect(outcome.result.steps).toBeGreaterThanOrEqual(2);
  });
});
