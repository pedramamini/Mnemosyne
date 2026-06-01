import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MnemosyneAgent } from "../src/agent/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { createAccount, createAgent } from "../src/db/index.ts";
import {
  type RunOptions,
  SandboxClient,
  type SandboxLike,
} from "../src/sandbox/client.ts";
import { buildTools } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { toolThenTextModel } from "./mock-model.ts";

// MNEMO-19: cross-session procedural-memory replay (PRD §6.2). In one DO session a
// mock model calls `authorTool` to persist a tool to the brain; in a *later*
// session (fresh loop over the SAME brain) `buildTools` discovers it as
// `brain__<name>` and a mock model calls it and gets a result. The recording
// stub can't do this - discovery reads files back - so this test uses a tiny
// in-memory FS sandbox where writeFile/readFile/find actually round-trip.

/**
 * In-memory {@link SandboxLike}: writeFile/readFile back onto a map, `find`
 * lists the `tool.json` manifests on it, and `python3`/`sh` runs return canned
 * output (the workers pool can't run real interpreters). git/other commands are
 * clean no-ops so the brain auto-commit degrades to "nothing to commit".
 */
function makeMemSandbox() {
  const files = new Map<string, string>();
  const runs: Array<{ command: string; options?: RunOptions }> = [];
  const handle: SandboxLike = {
    exec: async (command, options) => {
      runs.push({ command, options });
      if (command.startsWith("find ")) {
        const matches = [...files.keys()].filter(
          (p) => p.startsWith("/brain/tools/") && p.endsWith("/tool.json"),
        );
        return {
          stdout: matches.map((m) => `${m}\n`).join(""),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.startsWith("python3 ") || command.startsWith("sh ")) {
        return { stdout: "replay-output\n", stderr: "", exitCode: 0 };
      }
      // git add/status/commit/rev-parse and anything else: clean no-op.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    readFile: async (path) => ({ content: files.get(path) ?? "" }),
    writeFile: async (path, content) => {
      files.set(path, content);
      return { success: true };
    },
    mkdir: async () => ({ success: true }),
    destroy: async () => {},
  };
  return { files, runs, client: new SandboxClient(handle) };
}

describe("MnemosyneAgent - self-authored tool replays across sessions", () => {
  it("authorTool in one session → brain__<name> discovered + callable in a later one", async () => {
    const account = await createAccount(env, {
      email: `replay-${crypto.randomUUID()}@example.com`,
    });
    const agent = await createAgent(env, {
      account_id: account.id,
      name: "Procedural agent",
      template: "product",
      system_prompt: "Build and reuse tools.",
    });
    const agentStub = env.AGENT.get(env.AGENT.idFromName(agent.id));

    const outcome = await runInDurableObject(
      agentStub,
      async (instance: MnemosyneAgent) => {
        const mem = makeMemSandbox();
        const sink: AuditInput[] = [];
        instance.testSandboxOverride = mem.client;
        instance.testAuditSink = sink;

        // --- Session 1: the model authors a reusable tool. ---
        instance.testModelOverride = toolThenTextModel(
          "authorTool",
          {
            name: "counter",
            description: "counts the input keys",
            runtime: "python",
            entrypoint: "main.py",
            code: "import sys,json; print(len(json.load(sys.stdin)))",
            inputSchema: { type: "object" },
          },
          "Authored the tool.",
        );
        await instance.runHeadless({
          prompt: "Author a tool.",
          sessionId: "s1",
        });

        // The script + manifest are now persisted in the brain.
        const persistedFiles = [...mem.files.keys()];

        // --- Discovery proof: a fresh buildTools over the SAME brain exposes it. ---
        const ctx: ToolContext = {
          env,
          agentId: agent.id,
          accountId: account.id,
          sandbox: mem.client,
          sessionId: "s2",
          emit: async () => {},
        };
        const discovered = Object.keys(await buildTools(ctx));

        // --- Session 2 (later loop): the model calls the discovered tool. ---
        instance.testModelOverride = toolThenTextModel(
          "brain__counter",
          { a: 1, b: 2 },
          "Ran the tool.",
        );
        const replay = await instance.runHeadless({
          prompt: "Run my counter tool.",
          sessionId: "s2",
        });

        return {
          persistedFiles,
          discovered,
          replayText: replay.text,
          ranEntrypoint: mem.runs.some((r) =>
            r.command.includes("/brain/tools/counter/main.py"),
          ),
          ranEvents: sink.filter(
            (e) =>
              e.type === "tool.ran" && e.payload?.tool === "brain__counter",
          ).length,
        };
      },
    );

    // Session 1 persisted both the script and its manifest.
    expect(outcome.persistedFiles).toContain("/brain/tools/counter/main.py");
    expect(outcome.persistedFiles).toContain("/brain/tools/counter/tool.json");
    // A later buildTools discovered the tool under the brain__ namespace.
    expect(outcome.discovered).toContain("brain__counter");
    // Session 2 actually replayed the entrypoint and finished.
    expect(outcome.ranEntrypoint).toBe(true);
    expect(outcome.ranEvents).toBeGreaterThanOrEqual(1);
    expect(outcome.replayText).toContain("Ran the tool.");
  });
});
