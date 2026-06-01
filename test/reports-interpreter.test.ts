import { describe, expect, it } from "vitest";
import {
  CodeInterpreter,
  type InterpreterSandbox,
  type RawExecutionResult,
} from "../src/reports/interpreter.ts";
import type { CtxHandle } from "../src/reports/types.ts";

// MNEMO-23: the single Code-Interpreter seam (PRD §8.1). The vitest-pool-workers
// env can't boot a real container AND MNEMO-06 exposes no Code-Interpreter test
// harness (its `testSandboxOverride`/stub-sandbox cover only exec/readFile/
// writeFile, NOT createCodeContext/runCode). So we take the MOCKED-SANDBOX path:
// inject a fake InterpreterSandbox and pin the two behaviours that matter - the
// once-per-agent context cache and the ExecutionResult→RunResult normalization.
// A live `print(1+1)` round-trip is the manual checkpoint in MNEMO-23.md.

/** A fake CodeContext-shaped handle the fake sandbox hands back. */
function ctx(id: string): CtxHandle {
  return {
    id,
    language: "python",
    cwd: "/workspace",
    createdAt: new Date(),
    lastUsed: new Date(),
  };
}

/** A fake InterpreterSandbox counting createCodeContext + recording runCode. */
function fakeSandbox(result?: RawExecutionResult): {
  sandbox: InterpreterSandbox;
  created: number;
  ran: string[];
} {
  let created = 0;
  const ran: string[] = [];
  const sandbox: InterpreterSandbox = {
    createCodeContext: async () => {
      created++;
      return ctx(`ctx-${created}`);
    },
    runCode: async (code) => {
      ran.push(code);
      return result ?? { logs: { stdout: [], stderr: [] }, results: [] };
    },
  };
  return {
    sandbox,
    get created() {
      return created;
    },
    ran,
  };
}

describe("CodeInterpreter.getContext", () => {
  it("creates a context once per agent and reuses the cached handle", async () => {
    const fake = fakeSandbox();
    const interp = new CodeInterpreter(fake.sandbox);

    const first = await interp.getContext("agent-a");
    const second = await interp.getContext("agent-a");

    expect(fake.created).toBe(1);
    expect(second).toBe(first);
  });

  it("creates a separate context per distinct agent", async () => {
    const fake = fakeSandbox();
    const interp = new CodeInterpreter(fake.sandbox);

    const a = await interp.getContext("agent-a");
    const b = await interp.getContext("agent-b");

    expect(fake.created).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe("CodeInterpreter.runCode normalization", () => {
  it("collapses logs to strings, surfaces an image/png result, and null error on success", async () => {
    const raw: RawExecutionResult = {
      logs: { stdout: ["hello ", "world"], stderr: ["warn"] },
      results: [{ text: "fig", png: "QUJD" }],
    };
    const fake = fakeSandbox(raw);
    const interp = new CodeInterpreter(fake.sandbox);
    const c = await interp.getContext("agent-a");

    const res = await interp.runCode(c, "print('hi')");

    expect(res.stdout).toBe("hello world");
    expect(res.stderr).toBe("warn");
    expect(res.error).toBeNull();
    expect(res.results).toHaveLength(1);
    expect(res.results[0].png).toBe("QUJD");
    // The code + context were forwarded to the SDK.
    expect(fake.ran).toContain("print('hi')");
  });

  it("normalizes a Python error into the error field (returned, not thrown)", async () => {
    const raw: RawExecutionResult = {
      logs: { stdout: [], stderr: [] },
      error: { name: "NameError", message: "x is not defined", traceback: [] },
      results: [],
    };
    const interp = new CodeInterpreter(fakeSandbox(raw).sandbox);
    const c = await interp.getContext("agent-a");

    const res = await interp.runCode(c, "x");
    expect(res.error).not.toBeNull();
    expect(res.error?.name).toBe("NameError");
    expect(res.error?.message).toContain("not defined");
  });

  it("tolerates a sparse SDK result (missing logs/results)", async () => {
    const interp = new CodeInterpreter(fakeSandbox({}).sandbox);
    const c = await interp.getContext("agent-a");
    const res = await interp.runCode(c, "pass");
    expect(res).toEqual({ stdout: "", stderr: "", error: null, results: [] });
  });
});
