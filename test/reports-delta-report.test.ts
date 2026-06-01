import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuditEmitTarget, AuditEmitter } from "../src/audit/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import {
  type DeltaReportDeps,
  generateDeltaReport,
} from "../src/reports/delta-report.ts";
import {
  canonicalizeFindings,
  type Fact,
  type Findings,
  findingsFromReport,
} from "../src/reports/findings.ts";
import { generateReport } from "../src/reports/generate.ts";
import {
  CodeInterpreter,
  type InterpreterSandbox,
  type RawExecutionResult,
} from "../src/reports/interpreter.ts";
import { __resetPythonEnvForTest } from "../src/reports/python-env.ts";
import type { GeneratedReport, ReportInput } from "../src/reports/types.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// MNEMO-26: the delta-aware orchestration. The workers pool can't boot a container,
// so we mock the prior loader + current-findings derivation and inject a `generate`
// that captures the assembled ReportInput then runs the REAL generateReport over a
// fake Code Interpreter + spy sandbox (mirroring reports-generate.test.ts). That lets
// us assert (a) the report LEADS with a "What changed" section reflecting the delta,
// (b) the persisted markdown round-trips the current findings (the next baseline), and
// (c) the report.generated audit payload carries the delta counts - plus the
// skip-when-unchanged and first-run (no prior) paths.

const KNOWN_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KNOWN_PNG_B64 = btoa(String.fromCharCode(...KNOWN_BYTES));

function makeCtx(id = "ctx-1") {
  return {
    id,
    language: "python",
    cwd: "/workspace",
    createdAt: new Date(),
    lastUsed: new Date(),
  };
}

/** Fake Beta Code-Interpreter: one context, a fixed PNG for any cell. */
function fakeInterpreter(): CodeInterpreter {
  const handle: InterpreterSandbox = {
    createCodeContext: async () => makeCtx(),
    runCode: async (): Promise<RawExecutionResult> => ({
      logs: { stdout: [], stderr: [] },
      results: [{ png: KNOWN_PNG_B64 }],
    }),
  };
  return new CodeInterpreter(handle);
}

/** Recording SandboxLike capturing the `.md` + PNG writes the report path makes. */
class RecordingSandbox implements SandboxLike {
  readonly writes: Array<{ path: string; content: string }> = [];
  exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });
  async readFile() {
    return { content: "" };
  }
  async writeFile(path: string, content: string) {
    this.writes.push({ path, content });
    return { success: true };
  }
  async mkdir() {
    return { success: true };
  }
}

function spyEmitter(): { emitter: AuditEmitter; events: AuditInput[] } {
  const events: AuditInput[] = [];
  const target: AuditEmitTarget = {
    emit: (input) => {
      events.push(input);
    },
  };
  return { emitter: AuditEmitter.withSession(target, "run-1"), events };
}

function fact(key: string, value: string, label?: string): Fact {
  return { key, label: label ?? key, value };
}

function findings(...facts: Fact[]): Findings {
  return { facts };
}

/**
 * Wire generateDeltaReport with injected mocks: a fixed prior + current, a capturing
 * `generate` delegating to the real generateReport, the fake interpreter + recording
 * sandbox, and a spy emitter. Returns the captured input/result + the audit events.
 */
async function run(
  prior: Findings | null,
  current: Findings,
  opts: Parameters<typeof generateDeltaReport>[3] = {},
) {
  const recording = new RecordingSandbox();
  const { emitter, events } = spyEmitter();
  let capturedInput: ReportInput | undefined;
  let generateCalls = 0;

  const deps: DeltaReportDeps = {
    loadPriorFindings: async () => prior,
    computeCurrentFindings: async () => current,
    generate: (e, a, input, gdeps): Promise<GeneratedReport> => {
      generateCalls++;
      capturedInput = input;
      return generateReport(e, a, input, gdeps);
    },
    emitter,
    generateDeps: {
      interpreter: fakeInterpreter(),
      sandbox: new SandboxClient(recording),
    },
  };

  const result = await generateDeltaReport(env, "agent-123", {}, opts, deps);
  return { result, capturedInput, events, generateCalls };
}

beforeEach(() => {
  __resetPythonEnvForTest();
});

describe("generateDeltaReport", () => {
  it("leads with a What-changed section, round-trips findings, audits the delta", async () => {
    const prior = findings(
      fact("funding.stage", "Series A"),
      fact("metrics.arr", "$10M", "ARR"),
    );
    const current = findings(
      fact("funding.stage", "Series A"), // unchanged
      fact("metrics.arr", "$25M", "ARR"), // changed (numeric → chart)
      fact("team.size", "20", "Headcount"), // added
    );

    const { result, capturedInput, events } = await run(prior, current);
    expect(result).not.toBeNull();
    const input = capturedInput as ReportInput;

    // (a) The report LEADS with a "What changed" section reflecting exactly the delta.
    expect(input.sections[0].heading).toBe("What changed");
    const body = input.sections[0].body;
    expect(body).toContain("### New");
    expect(body).toContain("Headcount");
    expect(body).toContain("`team.size`");
    expect(body).toContain("### Changed");
    expect(body).toContain("$10M → $25M");
    // Removed list omitted (nothing removed), and the unchanged fact is not echoed.
    expect(body).not.toContain("### Removed");
    expect(body).not.toContain("funding.stage");

    // A prior-vs-current chart was attached for the numeric change.
    expect(input.sections[0].chart?.kind).toBe("bar");

    // (b) The persisted report embeds the CURRENT findings (next-run baseline).
    expect(input.findings).toEqual(current);
    const md = (result as GeneratedReport).markdown;
    expect(findingsFromReport(null, md)).toEqual(canonicalizeFindings(current));

    // (c) The report.generated audit payload carries the delta counts + headline.
    const reportEvent = events.find((e) => e.type === "report.generated");
    expect(reportEvent).toBeDefined();
    expect(reportEvent?.payload?.delta).toMatchObject({
      added: 1,
      changed: 1,
      removed: 0,
      headline: "1 new fact, 1 changed, 0 removed since last report",
    });
  });

  it("skips (returns null + audits) when nothing changed and skipWhenUnchanged is set", async () => {
    const same = findings(fact("funding.stage", "Series A"));
    const { result, events, generateCalls } = await run(same, same, {
      skipWhenUnchanged: true,
      sessionId: "run-1",
    });

    expect(result).toBeNull();
    expect(generateCalls).toBe(0);

    // No report.generated; instead a milestone "no material changes" narration.
    expect(events.some((e) => e.type === "report.generated")).toBe(false);
    const skip = events.find((e) => e.text.includes("No material changes"));
    expect(skip).toBeDefined();
    expect(skip?.type).toBe("narration");
    expect(skip?.level).toBe("milestone");
    expect(skip?.payload?.skipped).toBe(true);
  });

  it("generates anyway when unchanged but skipWhenUnchanged is NOT set", async () => {
    const same = findings(fact("funding.stage", "Series A"));
    const { result, generateCalls } = await run(same, same, {
      skipWhenUnchanged: false,
    });
    expect(result).not.toBeNull();
    expect(generateCalls).toBe(1);
  });

  it("first run (no prior report) produces a full baseline - everything is New", async () => {
    const current = findings(
      fact("funding.stage", "Series A"),
      fact("metrics.arr", "$10M", "ARR"),
    );
    const { result, capturedInput } = await run(null, current, {
      skipWhenUnchanged: true,
    });

    // A first run with new facts is non-empty, so it is NOT skipped.
    expect(result).not.toBeNull();
    const input = capturedInput as ReportInput;
    expect(input.delta?.added).toHaveLength(2);
    expect(input.delta?.changed).toHaveLength(0);
    expect(input.delta?.removed).toHaveLength(0);
    expect(input.sections[0].body).toContain("### New");
    expect(input.sections[0].body).not.toContain("### Changed");
  });
});
