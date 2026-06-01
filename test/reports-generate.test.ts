import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuditEmitTarget, AuditEmitter } from "../src/audit/index.ts";
import type { AuditInput } from "../src/audit/types.ts";
import { REPORTS_DIR } from "../src/memory/layout.ts";
import { serializeFrontMatter } from "../src/reports/front-matter.ts";
import { generateReport } from "../src/reports/generate.ts";
import {
  CodeInterpreter,
  type InterpreterSandbox,
  type RawExecutionResult,
} from "../src/reports/interpreter.ts";
import { __resetPythonEnvForTest } from "../src/reports/python-env.ts";
import type { CtxHandle, ReportInput } from "../src/reports/types.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// MNEMO-24: the report generation orchestrator. The workers pool can't boot a
// container, so we drive `generateReport` against a fake Code Interpreter (a
// `runCode` that returns a known PNG for any cell) wrapped in the REAL
// CodeInterpreter, plus a spy brain-FS SandboxClient and a spy AuditEmitter. We
// assert the assembled markdown (front matter + headings + embedded chart image +
// a [[wikilink]]), the persisted `.md` + PNG writes under /brain/reports/, the one
// report.generated milestone, and that the returned assets carry the PNG bytes.

/** A known 8-byte "PNG" + its base64 - what the fake runCode returns. */
const KNOWN_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const KNOWN_PNG_B64 = btoa(String.fromCharCode(...KNOWN_BYTES));

/** A minimal CodeContext-shaped handle. */
function makeCtx(id = "ctx-1"): CtxHandle {
  return {
    id,
    language: "python",
    cwd: "/workspace",
    createdAt: new Date(),
    lastUsed: new Date(),
  };
}

/** A fake Beta Code-Interpreter handle: one context, a fixed PNG for any cell. */
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

/**
 * Recording `SandboxLike` capturing writes (text `.md` + base64 PNG) + mkdirs.
 * `exec` is declared as an arrow property purely to satisfy the interface - the
 * report path never runs a command (it only writes files + mkdirs).
 */
class RecordingSandbox implements SandboxLike {
  readonly writes: Array<{ path: string; content: string; encoding?: string }> =
    [];
  readonly mkdirs: string[] = [];

  exec = async () => ({ stdout: "", stderr: "", exitCode: 0 });

  async readFile() {
    return { content: "" };
  }
  async writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ) {
    this.writes.push({ path, content, encoding: options?.encoding });
    return { success: true };
  }
  async mkdir(path: string) {
    this.mkdirs.push(path);
    return { success: true };
  }
}

/** A spy AuditEmitter capturing forwarded events. */
function spyEmitter(): { emitter: AuditEmitter; events: AuditInput[] } {
  const events: AuditInput[] = [];
  const target: AuditEmitTarget = {
    emit: (input) => {
      events.push(input);
    },
  };
  return { emitter: AuditEmitter.withSession(target, "run-1"), events };
}

const INPUT: ReportInput = {
  frontMatter: {
    title: "Acme Corp Vendor Review",
    type: "report",
    agentId: "agent-123",
    template: "vendor",
    tags: ["security"],
    created: "2026-05-24T12:00:00.000Z",
    source_count: 3,
  },
  sections: [
    { heading: "Overview", body: "Acme is a mid-market vendor." },
    {
      heading: "Funding",
      body: "Funding has grown steadily.",
      chart: {
        kind: "line",
        title: "Funding by Year",
        series: [{ name: "USD (M)", values: [1, 3, 7] }],
        labels: ["2021", "2022", "2023"],
      },
    },
  ],
  related: ["acme corp"],
};

beforeEach(() => {
  __resetPythonEnvForTest();
});

describe("generateReport", () => {
  it("assembles markdown, persists the artifact, audits, and returns assets", async () => {
    const interpreter = fakeInterpreter();
    const recording = new RecordingSandbox();
    const sandbox = new SandboxClient(recording);
    const { emitter, events } = spyEmitter();

    const result = await generateReport(env, "agent-123", INPUT, {
      interpreter,
      sandbox,
      emitter,
    });

    // Markdown begins with the serialized front matter.
    expect(
      result.markdown.startsWith(serializeFrontMatter(INPUT.frontMatter)),
    ).toBe(true);

    // Both section headings present.
    expect(result.markdown).toContain("## Overview");
    expect(result.markdown).toContain("## Funding");

    // An embedded chart image, referenced by a RELATIVE assets/ path.
    expect(result.markdown).toMatch(/!\[.+\]\(assets\/.+\.png\)/);

    // A [[wikilink]] back into the brain (the report is a first-class neuron).
    expect(result.markdown).toContain("[[acme corp]]");

    // The `.md` was written under /brain/reports/.
    const mdWrites = recording.writes.filter((w) => w.path.endsWith(".md"));
    expect(mdWrites).toHaveLength(1);
    expect(mdWrites[0].path).toBe(result.brainPath);
    expect(result.brainPath.startsWith(`${REPORTS_DIR}/`)).toBe(true);

    // Each chart PNG was written (base64-encoded) under /brain/reports/.
    const pngWrites = recording.writes.filter((w) => w.path.endsWith(".png"));
    expect(pngWrites).toHaveLength(1);
    expect(pngWrites[0].encoding).toBe("base64");
    expect(pngWrites[0].path.startsWith(`${REPORTS_DIR}/assets/`)).toBe(true);

    // Exactly one report.generated milestone carrying the title + brainPath.
    const reportEvents = events.filter((e) => e.type === "report.generated");
    expect(reportEvents).toHaveLength(1);
    expect(reportEvents[0].level).toBe("milestone");
    expect(reportEvents[0].payload).toMatchObject({
      title: INPUT.frontMatter.title,
      brainPath: result.brainPath,
    });

    // The returned assets carry the PNG bytes (for MNEMO-25 embedding).
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].title).toBe("Funding by Year");
    expect(Array.from(result.assets[0].bytes)).toEqual(Array.from(KNOWN_BYTES));
    expect(result.assets[0].path).toBe(pngWrites[0].path);
  });

  it("runs headless without an emitter (no audit wired)", async () => {
    const recording = new RecordingSandbox();
    const result = await generateReport(env, "agent-123", INPUT, {
      interpreter: fakeInterpreter(),
      sandbox: new SandboxClient(recording),
    });
    expect(result.brainPath.endsWith(".md")).toBe(true);
    expect(result.assets).toHaveLength(1);
  });
});
