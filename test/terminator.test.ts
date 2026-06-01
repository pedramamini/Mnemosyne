import { describe, expect, it } from "vitest";
import type { AuditInput } from "../src/audit/types.ts";
import type { Env } from "../src/env.ts";
import {
  FinalReport,
  type FinalReportData,
} from "../src/tools/reportSchema.ts";
import { makeTerminator } from "../src/tools/terminator.ts";
import type { MnemosyneTool, ToolContext } from "../src/tools/types.ts";
import { stubSandboxClient } from "./stub-sandbox.ts";

// MNEMO-18: the terminator tool's inputSchema IS the final-report schema, and a
// per-run closure captures the submitted report. Before it fires, getResult() is
// null and wasCalled() is false; after a valid execute it captures the payload
// and emits a `report.generated` audit event. Zod rejects a malformed report.

function makeCtx(sessionId: string | null = "sess-1") {
  const { client } = stubSandboxClient();
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
  return { ctx, emitted };
}

/** Invoke a tool's execute with a minimal options object (unused by the terminator). */
function invoke(tool: MnemosyneTool, input: unknown): Promise<unknown> {
  const execute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, { toolCallId: "call-1", messages: [] });
}

/** A complete, valid final report payload. */
const VALID_REPORT: FinalReportData = {
  title: "Acme Q2 Watch",
  summary: "Acme shipped two releases and raised a round.",
  sections: [
    {
      heading: "Releases",
      body: "v2.1 and v2.2 landed with billing changes.",
      sourceUrls: ["https://acme.example/changelog"],
    },
    { heading: "Funding", body: "Series B closed at $40M." },
  ],
  keyFindings: ["Two releases", "Series B closed"],
  sources: [{ url: "https://acme.example/changelog", title: "Changelog" }],
  confidence: "medium",
};

describe("makeTerminator", () => {
  it("captures the submitted report and emits report.generated", async () => {
    const { ctx, emitted } = makeCtx();
    const term = makeTerminator(ctx);

    // Before firing: no result, not called.
    expect(term.wasCalled()).toBe(false);
    expect(term.getResult()).toBeNull();

    const result = (await invoke(term.tool, VALID_REPORT)) as {
      saved: boolean;
    };

    expect(result.saved).toBe(true);
    expect(term.wasCalled()).toBe(true);
    expect(term.getResult()).toEqual(VALID_REPORT);

    // A report.generated audit event narrates the title + section count.
    const reportEvent = emitted.find((e) => e.type === "report.generated");
    expect(reportEvent).toBeDefined();
    expect(reportEvent?.text).toContain("Acme Q2 Watch");
    expect(reportEvent?.payload?.sections).toBe(2);
    expect(reportEvent?.sessionId).toBe("sess-1");
  });

  it("uses the FinalReport schema as its inputSchema", () => {
    const { ctx } = makeCtx();
    const term = makeTerminator(ctx);
    // The tool's inputSchema is the very FinalReport schema (terminator-as-schema).
    expect(term.tool.inputSchema).toBe(FinalReport);
  });

  it("rejects an invalid report (missing summary) via the Zod schema", () => {
    // The SDK validates a tool call against inputSchema before execute runs; a
    // report missing the required `summary` field must not validate.
    const { summary: _omitted, ...missingSummary } = VALID_REPORT;
    expect(FinalReport.safeParse(missingSummary).success).toBe(false);
    expect(FinalReport.safeParse(VALID_REPORT).success).toBe(true);
  });
});
