import { describe, expect, it } from "vitest";
import type { AuditInput, AuditType } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import {
  buildTools,
  LARGE_OUTPUT_THRESHOLD_BYTES,
  type MnemosyneTool,
  type ToolContext,
} from "../src/tools/index.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-16: buildTools returns the core sandbox-driving tools. Each execute is
// invoked against a stub SandboxClient and asserted: it drives the sandbox,
// routes output through spillIfLarge, and emits a `tool.ran` audit event. Zod
// rejects malformed input before execute ever runs.

function makeCtx(sessionId: string | null = "sess-1") {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  const ctx: ToolContext = {
    env: {} as unknown as Env,
    agentId: "agent-1",
    accountId: "acct-1",
    sandbox: client,
    sessionId,
    emit: async (e) => {
      emitted.push(e);
    },
  };
  return { stub, ctx, emitted };
}

/** Invoke a tool's execute with a minimal options object (unused by our tools). */
function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

/** True if a `tool.ran` event for `name` was emitted. */
function ranEmitted(emitted: AuditInput[], name: string): boolean {
  const t: AuditType = "tool.ran";
  return emitted.some((e) => e.type === t && e.payload?.tool === name);
}

describe("buildTools - core sandbox-driving registry", () => {
  it("exposes the core sandbox tools + web tools + MNEMO-19 authoring tools (no terminator)", async () => {
    const { ctx } = makeCtx();
    const tools = await buildTools(ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "authorTool",
      "deleteTool",
      "listDir",
      "listTools",
      "readFile",
      "runPython",
      "runShell",
      "webFetch",
      "webSearch",
      "writeFile",
    ]);
  });

  it("runShell returns the stub's exit/stdout (inlined when small) + a 60s guard", async () => {
    const { stub, ctx, emitted } = makeCtx();
    stub.onRun("echo hi", { stdout: "hi\n", stderr: "", exitCode: 0 });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.runShell, { command: "echo hi" })) as {
      exitCode: number;
      stdout: { inline?: string };
      stderr: { inline?: string };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.inline).toBe("hi\n");
    expect(result.stderr.inline).toBe("");
    // Drove the sandbox with the command + the 60s timeout guard.
    const run = stub.runs.find((r) => r.command === "echo hi");
    expect(run).toBeDefined();
    expect(run?.options?.timeout).toBe(60_000);
    expect(ranEmitted(emitted, "runShell")).toBe(true);
  });

  it("a large runShell stdout comes back as a path, not a blob", async () => {
    const { stub, ctx } = makeCtx();
    const big = "z".repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 50);
    stub.onRun("dump", { stdout: big, stderr: "", exitCode: 0 });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.runShell, { command: "dump" })) as {
      stdout: { inline?: string; path?: string };
    };

    expect(result.stdout.inline).toBeUndefined();
    expect(result.stdout.path).toContain("/brain/.tool-out/");
    expect(stub.writes.some((w) => w.path === result.stdout.path)).toBe(true);
  });

  it("writeFile reports bytesWritten and emits both memory.wrote and tool.ran", async () => {
    const { stub, ctx, emitted } = makeCtx();
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.writeFile, {
      path: "/brain/notes/acme.md",
      content: "hello",
    })) as { path: string; bytesWritten: number };

    expect(result.path).toBe("/brain/notes/acme.md");
    expect(result.bytesWritten).toBe(5);
    expect(stub.writes).toContainEqual({
      path: "/brain/notes/acme.md",
      content: "hello",
    });
    expect(emitted.some((e) => e.type === "memory.wrote")).toBe(true);
    expect(ranEmitted(emitted, "writeFile")).toBe(true);
  });

  it("readFile returns the spilled file content + emits tool.ran", async () => {
    const { stub, ctx, emitted } = makeCtx();
    stub.onRead("/brain/notes/acme.md", "# Acme\n");
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.readFile, {
      path: "/brain/notes/acme.md",
    })) as { path: string; content: { inline?: string } };

    expect(result.path).toBe("/brain/notes/acme.md");
    expect(result.content.inline).toBe("# Acme\n");
    expect(ranEmitted(emitted, "readFile")).toBe(true);
  });

  it("runPython writes the snippet to a temp file, runs python3, and spills the result", async () => {
    const { stub, ctx, emitted } = makeCtx();
    stub.onRun("python3", { stdout: "42\n", stderr: "", exitCode: 0 });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.runPython, {
      code: "print(42)",
    })) as { exitCode: number; stdout: { inline?: string } };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.inline).toBe("42\n");
    // The snippet was written to a /tmp scratch file (not shell-quoted inline).
    const pyWrite = stub.writes.find((w) =>
      w.path.startsWith("/tmp/mnemo-py-"),
    );
    expect(pyWrite?.content).toBe("print(42)");
    expect(stub.runs.some((r) => r.command.includes("python3"))).toBe(true);
    expect(ranEmitted(emitted, "runPython")).toBe(true);
  });

  it("listDir returns the spilled directory listing + emits tool.ran", async () => {
    const { stub, ctx, emitted } = makeCtx();
    stub.onRun("ls -1Ap", { stdout: "README.md\nnotes/\n", exitCode: 0 });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.listDir, { path: "/brain" })) as {
      path: string;
      exitCode: number;
      entries: { inline?: string };
    };

    expect(result.path).toBe("/brain");
    expect(result.exitCode).toBe(0);
    expect(result.entries.inline).toBe("README.md\nnotes/\n");
    // The path is shell-quoted into the ls command (injection-safe).
    expect(stub.runs.some((r) => r.command.includes("ls -1Ap '/brain'"))).toBe(
      true,
    );
    expect(ranEmitted(emitted, "listDir")).toBe(true);
  });

  it("rejects malformed input via the Zod schema (missing required field)", async () => {
    const { ctx } = makeCtx();
    const tools = await buildTools(ctx);

    // runShell requires `command`; an empty object must not validate.
    const schema = tools.runShell.inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ command: "ls" }).success).toBe(true);
    // An empty string is rejected too (min length 1).
    expect(schema.safeParse({ command: "" }).success).toBe(false);
  });
});
