import { describe, expect, it } from "vitest";
import type { AuditInput } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import { buildAuthoringTools } from "../src/tools/selfAuthored/authoring.ts";
import { ToolManifest } from "../src/tools/selfAuthored/manifest.ts";
import type { MnemosyneTool, ToolContext } from "../src/tools/types.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-19: the authoring meta-tools (authorTool/listTools/deleteTool). Built
// over a stub sandbox + a stub commit helper so we can assert the brain writes,
// the commit message, the version bump, and the `tool.authored` audit events
// without a real container or git repo.

function makeAuthCtx() {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  const commits: string[] = [];
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
  const commit = async (message: string) => {
    commits.push(message);
    return "deadbeef";
  };
  return { stub, ctx, emitted, commits, commit };
}

function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

const AUTHOR_INPUT = {
  name: "counter",
  description: "counts lines",
  runtime: "python" as const,
  entrypoint: "main.py",
  code: "import sys,json; print(len(json.load(sys.stdin)))",
  inputSchema: { type: "object" },
};

describe("authorTool - persists a script + manifest, commits, and narrates", () => {
  it("writes both files, calls commit with the right message, emits tool.authored", async () => {
    const { stub, ctx, emitted, commits, commit } = makeAuthCtx();
    const tools = buildAuthoringTools(ctx, { commit });

    const result = (await invoke(tools.authorTool, AUTHOR_INPUT)) as {
      saved: boolean;
      name: string;
      version: number;
    };

    expect(result).toEqual({ saved: true, name: "counter", version: 1 });

    // The script landed at the entrypoint inside the tool dir...
    expect(stub.writes).toContainEqual({
      path: "/brain/tools/counter/main.py",
      content: AUTHOR_INPUT.code,
    });
    // ...and a VALID manifest landed at tool.json.
    const mw = stub.writes.find(
      (w) => w.path === "/brain/tools/counter/tool.json",
    );
    expect(mw).toBeDefined();
    const parsed = ToolManifest.safeParse(JSON.parse(mw?.content ?? ""));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.version).toBe(1);

    expect(commits).toContain("tool: author counter");
    expect(emitted.some((e) => e.type === "tool.authored")).toBe(true);
  });

  it("re-authoring the same name bumps version and preserves createdAt", async () => {
    const { stub, ctx, commit } = makeAuthCtx();
    const tools = buildAuthoringTools(ctx, { commit });

    await invoke(tools.authorTool, AUTHOR_INPUT);
    const first = stub.writes.find(
      (w) => w.path === "/brain/tools/counter/tool.json",
    );
    const firstManifest = first?.content ?? "";

    // Simulate the first manifest now being discoverable on the FS, so the second
    // author finds the prior version and bumps it.
    stub.onRun("find", { stdout: "/brain/tools/counter/tool.json\n" });
    stub.onRead("/brain/tools/counter/tool.json", firstManifest);

    const result = (await invoke(tools.authorTool, {
      ...AUTHOR_INPUT,
      description: "counts lines (v2)",
    })) as { version: number };
    expect(result.version).toBe(2);

    const latest = [...stub.writes]
      .reverse()
      .find((w) => w.path === "/brain/tools/counter/tool.json");
    const reparsed = ToolManifest.safeParse(JSON.parse(latest?.content ?? ""));
    expect(reparsed.success).toBe(true);
    if (reparsed.success && first) {
      const original = JSON.parse(firstManifest);
      expect(reparsed.data.version).toBe(2);
      expect(reparsed.data.createdAt).toBe(original.createdAt);
    }
  });
});

describe("deleteTool - removes the dir and commits a restorable delete", () => {
  it("rm -rf's the tool dir, commits, and emits a deletion event", async () => {
    const { stub, ctx, emitted, commits, commit } = makeAuthCtx();
    const tools = buildAuthoringTools(ctx, { commit });

    const result = (await invoke(tools.deleteTool, { name: "counter" })) as {
      deleted: boolean;
      name: string;
    };
    expect(result).toEqual({ deleted: true, name: "counter" });

    expect(
      stub.runs.some(
        (r) =>
          r.command.includes("rm -rf") &&
          r.command.includes("/brain/tools/counter"),
      ),
    ).toBe(true);
    expect(commits).toContain("tool: delete counter");
    expect(
      emitted.some(
        (e) => e.type === "tool.authored" && e.payload?.deleted === true,
      ),
    ).toBe(true);
  });
});

describe("listTools - reflects the manifests present in the brain", () => {
  it("returns name + description for each discovered manifest", async () => {
    const { stub, ctx, commit } = makeAuthCtx();
    const tools = buildAuthoringTools(ctx, { commit });

    stub.onRun("find", { stdout: "/brain/tools/foo/tool.json\n" });
    stub.onRead(
      "/brain/tools/foo/tool.json",
      JSON.stringify({
        name: "foo",
        description: "the foo tool",
        runtime: "shell",
        entrypoint: "run.sh",
        inputSchema: { type: "object" },
        createdAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      }),
    );

    const result = (await invoke(tools.listTools, {})) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(result.tools).toContainEqual({
      name: "foo",
      description: "the foo tool",
    });
  });
});
