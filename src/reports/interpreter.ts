/**
 * CodeInterpreter - the SINGLE seam over the Sandbox Code Interpreter (MNEMO-23).
 *
 * PRD §8.1 caveat: the `@cloudflare/sandbox` SDK is GA (April 2026) but its Code
 * Interpreter methods (`createCodeContext` / `runCode`) still ship under a "Beta"
 * doc header. Per the §8.1 discipline - "don't pin business-critical behavior to
 * an undocumented method without a test" - EVERY call to those methods is funnelled
 * through this one module, and the reporting tests (`test/reports-interpreter.test.ts`)
 * pin the normalization. The rest of `src/reports/` (and MNEMO-24) talks to THIS
 * wrapper, never the raw SDK; the §8.1 risk is auditable in one file.
 *
 * (This is the Code-Interpreter twin of `src/sandbox/client.ts`, which is the seam
 * for the SDK's `exec`/`readFile`/`writeFile` surface. createCodeContext/runCode
 * are NOT in that wrapper's surface, so this file owns them.)
 *
 * Python contexts are **per-agent and reused** across a run: `getContext(agentId)`
 * lazily calls `createCodeContext` ONCE per agent and caches the handle, so
 * matplotlib/pandas imports and loaded dataframes persist between `runCode` calls
 * (the warm sandbox amortizes import cost - PRD §6.4/§7.3). No chart logic lives
 * here: this is a pure context/exec wrapper. The chart→PNG pipeline is `charts.ts`.
 */
import {
  type CreateContextOptions,
  getSandbox as sdkGetSandbox,
} from "@cloudflare/sandbox";
import type { Env } from "../env.ts";
import type { CodeRunner, CtxHandle, RunResult } from "./types.ts";

/**
 * The minimal Beta Code-Interpreter surface this wrapper depends on - exactly the
 * two SDK methods used. The real SDK `Sandbox` is structurally assignable (its
 * wider param/return types satisfy these narrower ones), so production passes a
 * real handle and tests inject a fake without booting a container (the
 * vitest-pool-workers env cannot start one).
 */
export interface InterpreterSandbox {
  createCodeContext(options?: CreateContextOptions): Promise<CtxHandle>;
  runCode(
    code: string,
    options?: { context?: CtxHandle },
  ): Promise<RawExecutionResult>;
}

/**
 * The subset of the SDK's `ExecutionResult` this wrapper reads. Declared locally
 * (not imported) so the normalization target is explicit and the SDK shape can
 * drift behind this seam without leaking. `runCode` returns `{ logs, error,
 * results }`; we collapse `logs.std*: string[]` to strings and map the rich
 * outputs to {@link import("./types.ts").RichResult}.
 */
export interface RawExecutionResult {
  logs?: { stdout?: string[]; stderr?: string[] };
  error?: { name: string; message: string; traceback?: string[] };
  results?: Array<{
    text?: string;
    png?: string;
    jpeg?: string;
    svg?: string;
  }>;
}

export class CodeInterpreter implements CodeRunner {
  private readonly handle: InterpreterSandbox;
  /** One Python context per agentId - created lazily, reused for the run. */
  private readonly contexts = new Map<string, CtxHandle>();

  constructor(handle: InterpreterSandbox) {
    this.handle = handle;
  }

  /**
   * Get (creating once) the agent's persistent Python context. The first call
   * for an `agentId` calls the Beta `createCodeContext`; every later call returns
   * the cached handle, so a run's matplotlib/pandas state survives across
   * `runCode` calls (PRD §6.4). Concurrent first-calls are de-duped via a stored
   * in-flight promise so we never create two contexts for one agent.
   */
  async getContext(agentId: string): Promise<CtxHandle> {
    const cached = this.contexts.get(agentId);
    if (cached) return cached;
    // §8.1 Beta method - isolated to this file (the one seam + the thing the
    // tests pin). Default language is Python; chart deps are set up by
    // `python-env.ts:ensureCharting` on first use, not here.
    const ctx = await this.handle.createCodeContext();
    this.contexts.set(agentId, ctx);
    return ctx;
  }

  /**
   * Run `code` in `ctx` and normalize the SDK's `ExecutionResult` into the stable
   * {@link RunResult} shape. A Python error is RETURNED in `error` (not thrown) -
   * a failing cell is a normal result, mirroring how the shell wrapper returns a
   * non-zero exit code. Only a transport/SDK throw propagates.
   */
  async runCode(ctx: CtxHandle, code: string): Promise<RunResult> {
    // §8.1 Beta method - the second (and last) raw Code-Interpreter call site.
    const raw = await this.handle.runCode(code, { context: ctx });
    return normalize(raw);
  }
}

/** Collapse the SDK's `ExecutionResult` into the stable {@link RunResult}. */
function normalize(raw: RawExecutionResult): RunResult {
  const stdout = (raw.logs?.stdout ?? []).join("");
  const stderr = (raw.logs?.stderr ?? []).join("");
  const error = raw.error
    ? {
        name: raw.error.name,
        message: raw.error.message,
        traceback: raw.error.traceback,
      }
    : null;
  const results = (raw.results ?? []).map((r) => ({
    text: r.text,
    png: r.png,
    jpeg: r.jpeg,
    svg: r.svg,
  }));
  return { stdout, stderr, error, results };
}

/**
 * Resolve the per-agent {@link CodeInterpreter}. Like the MNEMO-06 sandbox
 * accessor, the SDK's `getSandbox(ns, id)` keys the container DO by
 * `idFromName(id)`, so agent ↔ container map 1:1 and code runs in the SAME
 * container whose `/brain` the FS wrapper writes to (PRD §8.1).
 */
export function getCodeInterpreter(env: Env, agentId: string): CodeInterpreter {
  return new CodeInterpreter(sdkGetSandbox(env.SANDBOX, agentId));
}
