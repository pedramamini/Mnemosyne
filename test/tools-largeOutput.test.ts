import { describe, expect, it } from "vitest";
import type { AuditInput } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import {
  LARGE_OUTPUT_THRESHOLD_BYTES,
  spillIfLarge,
  type ToolContext,
} from "../src/tools/index.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-16: spillIfLarge is the enforcement point for PRD §7.1 context
// discipline - small outputs are inlined, large ones are written to the brain
// FS and the loop is handed a PATH + preview (never the blob). A stub
// SandboxClient records the write so we assert this deterministically.

function makeCtx(sessionId: string | null = "sess-1") {
  const { stub, client } = stubSandboxClient();
  const emitted: AuditInput[] = [];
  const ctx: ToolContext = {
    env: {} as unknown as Env, // unused by the spill logic
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

describe("spillIfLarge", () => {
  it("inlines content under the threshold (no FS write)", async () => {
    const { stub, ctx, emitted } = makeCtx();
    const content = "a short result";

    const result = await spillIfLarge(ctx, "runShell-stdout", content);

    expect(result.inline).toBe(content);
    expect(result.path).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(result.bytes).toBe(content.length);
    // Nothing spilled → no write, no mkdir, no audit note.
    expect(stub.writes).toHaveLength(0);
    expect(stub.mkdirs).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("measures size in UTF-8 bytes, not string length", async () => {
    const { ctx } = makeCtx();
    // A 3-char string that is 9 UTF-8 bytes - still under the threshold.
    const content = "€€€";

    const result = await spillIfLarge(ctx, "readFile", content);

    expect(result.inline).toBe(content);
    expect(result.bytes).toBe(9);
  });

  it("spills content at/over the threshold to a /brain/.tool-out path + preview (NOT the blob)", async () => {
    const { stub, ctx, emitted } = makeCtx("sess-42");
    const content = "x".repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 100);

    const result = await spillIfLarge(ctx, "runShell-stdout", content);

    // A spill returns a path + preview, and crucially NO inline blob.
    expect(result.inline).toBeUndefined();
    expect(result.path).toBeDefined();
    expect(result.bytes).toBe(content.length);
    expect(result.preview).toBeDefined();
    expect(result.preview?.length).toBe(500);
    expect(result.preview).toBe(content.slice(0, 500));

    // It was written under /brain/.tool-out/<sessionId>/ with the full content,
    // after mkdir-ing the session directory.
    expect(result.path).toContain("/brain/.tool-out/sess-42/");
    expect(result.path).toContain("runShell-stdout-");
    const write = stub.writes.find((w) => w.path === result.path);
    expect(write).toBeDefined();
    expect(write?.content).toBe(content);
    expect(stub.mkdirs).toContain("/brain/.tool-out/sess-42");

    // The spill narrates to the audit stream.
    const note = emitted.find((e) => e.type === "narration");
    expect(note).toBeDefined();
    expect(note?.payload?.path).toBe(result.path);
    expect(note?.payload?.bytes).toBe(content.length);
  });

  it("buckets a sessionless turn under a stable 'no-session' path", async () => {
    const { stub, ctx } = makeCtx(null);
    const content = "y".repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);

    const result = await spillIfLarge(ctx, "readFile", content);

    expect(result.path).toContain("/brain/.tool-out/no-session/");
    expect(stub.mkdirs).toContain("/brain/.tool-out/no-session");
  });
});
