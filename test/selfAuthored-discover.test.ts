import { describe, expect, it } from "vitest";
import type { AuditInput } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import { discoverSelfAuthoredTools } from "../src/tools/selfAuthored/discover.ts";
import type { MnemosyneTool, ToolContext } from "../src/tools/types.ts";
import { LARGE_OUTPUT_THRESHOLD_BYTES } from "../src/tools/types.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-19: discovery + replay of self-authored tools (procedural memory, §6.2).
// A stub FS seeds two valid tool dirs and one malformed manifest; discovery must
// register exactly the two valid tools under `brain__*`, skip the malformed one
// (with an `error` note), and each tool's execute must run the entrypoint with
// input delivered as a JSON stdin file - never interpolated into the command.

const SENTINEL = "ZZ-INJECT-SENTINEL-ZZ";

const ALPHA = {
  name: "alpha",
  description: "alpha tool",
  runtime: "python" as const,
  entrypoint: "a.py",
  inputSchema: {
    type: "object",
    properties: { marker: { type: "string" } },
    required: ["marker"],
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

const BETA = {
  name: "beta",
  description: "beta tool",
  runtime: "shell" as const,
  entrypoint: "b.sh",
  inputSchema: { type: "object" },
  createdAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

/** Seed a stub sandbox with two valid manifests + one malformed one. */
function makeSeededCtx() {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  stub.onRun("find", {
    stdout:
      "/brain/tools/alpha/tool.json\n" +
      "/brain/tools/beta/tool.json\n" +
      "/brain/tools/broken/tool.json\n",
  });
  stub.onRead("/brain/tools/alpha/tool.json", JSON.stringify(ALPHA));
  stub.onRead("/brain/tools/beta/tool.json", JSON.stringify(BETA));
  stub.onRead("/brain/tools/broken/tool.json", "{ this is not valid json");

  const ctx: ToolContext = {
    env: {} as unknown as Env,
    agentId: "agent-1",
    accountId: "acct-1",
    sandbox: client,
    sessionId: "sess-1",
    emit: async (e) => {
      emitted.push(e);
    },
  };
  return { stub, ctx, emitted };
}

function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

describe("discoverSelfAuthoredTools - registration + graceful skip", () => {
  it("registers exactly the two valid tools and skips the malformed one with an error note", async () => {
    const { ctx, emitted } = makeSeededCtx();
    const tools = await discoverSelfAuthoredTools(ctx);

    expect(Object.keys(tools).sort()).toEqual(["brain__alpha", "brain__beta"]);
    // The broken manifest was skipped via an error-level audit note, not a throw.
    expect(
      emitted.some(
        (e) =>
          e.type === "error" &&
          e.level === "error" &&
          e.text.includes("broken"),
      ),
    ).toBe(true);
  });
});

describe("brain__<name>.execute - replays the entrypoint safely", () => {
  it("delivers input via a JSON stdin file, never interpolated into the command", async () => {
    const { stub, ctx, emitted } = makeSeededCtx();
    stub.onRun("a.py", { stdout: "done\n", exitCode: 0 });
    const tools = await discoverSelfAuthoredTools(ctx);

    const result = (await invoke(tools.brain__alpha, {
      marker: SENTINEL,
    })) as { exitCode: number; stdout: { inline?: string } };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.inline).toBe("done\n");

    // The input was written to a /tmp JSON file as a stdin payload...
    const inputWrite = stub.writes.find((w) =>
      w.path.startsWith("/tmp/mnemo-tool-in-"),
    );
    expect(inputWrite).toBeDefined();
    expect(JSON.parse(inputWrite?.content ?? "{}")).toEqual({
      marker: SENTINEL,
    });

    // ...and the run command is `python3 <entry> < <inputfile>` - the entrypoint
    // is shell-quoted, input is redirected from the file, and the input VALUE is
    // never interpolated into the command string (no shell-injection surface).
    const run = stub.runs.find((r) => r.command.includes("a.py"));
    expect(run).toBeDefined();
    expect(run?.command).toContain("python3");
    expect(run?.command).toContain("'/brain/tools/alpha/a.py'");
    expect(run?.command).toContain("< '/tmp/mnemo-tool-in-");
    expect(run?.command).not.toContain(SENTINEL);
    expect(run?.options?.timeout).toBe(60_000);

    expect(
      emitted.some(
        (e) => e.type === "tool.ran" && e.payload?.tool === "brain__alpha",
      ),
    ).toBe(true);
  });

  it("rejects input that fails the manifest schema BEFORE running the script", async () => {
    const { stub, ctx } = makeSeededCtx();
    stub.onRun("a.py", { stdout: "should-not-run\n", exitCode: 0 });
    const tools = await discoverSelfAuthoredTools(ctx);

    // `marker` is required + must be a string; a number fails validation.
    const result = (await invoke(tools.brain__alpha, { marker: 123 })) as {
      error?: string;
    };
    expect(result.error).toBeDefined();
    // The script never ran, and no input file was written.
    expect(stub.runs.some((r) => r.command.includes("a.py"))).toBe(false);
    expect(
      stub.writes.some((w) => w.path.startsWith("/tmp/mnemo-tool-in-")),
    ).toBe(false);
  });

  it("spills a large output to a brain path instead of inlining it", async () => {
    const { stub, ctx } = makeSeededCtx();
    const big = "z".repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 50);
    stub.onRun("a.py", { stdout: big, exitCode: 0 });
    const tools = await discoverSelfAuthoredTools(ctx);

    const result = (await invoke(tools.brain__alpha, { marker: "ok" })) as {
      stdout: { inline?: string; path?: string };
    };
    expect(result.stdout.inline).toBeUndefined();
    expect(result.stdout.path).toContain("/brain/.tool-out/");
  });
});
