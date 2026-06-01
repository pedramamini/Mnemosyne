import { describe, expect, it } from "vitest";
import type { AuditInput, AuditType } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import {
  type ArtifactDraft,
  buildTools,
  type MnemosyneTool,
  type ToolContext,
} from "../src/tools/index.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// The renderHtml tool: present ONLY when ctx.onArtifact is wired (the web-chat
// turn); it validates + size-caps the HTML, hands the draft to onArtifact (the
// turn archives it), and emits a `tool.ran` audit event. Drives the tool against
// a stub SandboxClient + an in-memory artifact sink (mirrors tools-registry.test).

function makeCtx(opts: { withArtifactSink?: boolean } = {}) {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  const drafts: ArtifactDraft[] = [];
  const ctx: ToolContext = {
    env: {} as unknown as Env,
    agentId: "agent-1",
    accountId: "acct-1",
    sandbox: client,
    sessionId: "sess-1",
    emit: async (e) => {
      emitted.push(e);
    },
    onArtifact: opts.withArtifactSink ? (d) => drafts.push(d) : undefined,
  };
  return { stub, ctx, emitted, drafts };
}

function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

function ranEmitted(emitted: AuditInput[], name: string): boolean {
  const t: AuditType = "tool.ran";
  return emitted.some((e) => e.type === t && e.payload?.tool === name);
}

const HTML = "<!doctype html><html><body><h1>Hi</h1></body></html>";

describe("renderHtml tool", () => {
  it("is OMITTED from the catalog when there is no artifact sink", async () => {
    const { ctx } = makeCtx({ withArtifactSink: false });
    const tools = await buildTools(ctx);
    expect(tools.renderHtml).toBeUndefined();
  });

  it("is PRESENT when the turn wires an artifact sink", async () => {
    const { ctx } = makeCtx({ withArtifactSink: true });
    const tools = await buildTools(ctx);
    expect(tools.renderHtml).toBeDefined();
  });

  it("hands inline html to onArtifact and emits tool.ran", async () => {
    const { ctx, emitted, drafts } = makeCtx({ withArtifactSink: true });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.renderHtml, {
      title: "Dashboard",
      html: HTML,
    })) as { shown: boolean; title: string; bytes: number };

    expect(result.shown).toBe(true);
    expect(result.title).toBe("Dashboard");
    expect(drafts).toEqual([{ title: "Dashboard", html: HTML }]);
    expect(ranEmitted(emitted, "renderHtml")).toBe(true);
  });

  it("reads an html file from the sandbox when given a path", async () => {
    const { stub, ctx, drafts } = makeCtx({ withArtifactSink: true });
    stub.onRead("/brain/views/report.html", HTML);
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.renderHtml, {
      title: "From file",
      path: "/brain/views/report.html",
    })) as { shown: boolean };

    expect(result.shown).toBe(true);
    expect(drafts).toEqual([{ title: "From file", html: HTML }]);
  });

  it("refuses empty content (no html, no path) without calling the sink", async () => {
    const { ctx, drafts } = makeCtx({ withArtifactSink: true });
    const tools = await buildTools(ctx);

    const result = (await invoke(tools.renderHtml, {
      title: "Nothing",
    })) as { shown: boolean; error?: string };

    expect(result.shown).toBe(false);
    expect(result.error).toBeTruthy();
    expect(drafts).toHaveLength(0);
  });

  it("refuses HTML over the 1 MiB cap", async () => {
    const { ctx, drafts } = makeCtx({ withArtifactSink: true });
    const tools = await buildTools(ctx);
    const huge = `<p>${"x".repeat(1024 * 1024 + 1)}</p>`;

    const result = (await invoke(tools.renderHtml, {
      title: "Too big",
      html: huge,
    })) as { shown: boolean; error?: string };

    expect(result.shown).toBe(false);
    expect(result.error).toContain("too large");
    expect(drafts).toHaveLength(0);
  });

  it("rejects a missing title via the Zod schema", async () => {
    const { ctx } = makeCtx({ withArtifactSink: true });
    const tools = await buildTools(ctx);
    const schema = tools.renderHtml.inputSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ html: HTML }).success).toBe(false);
    expect(schema.safeParse({ title: "ok", html: HTML }).success).toBe(true);
  });
});
