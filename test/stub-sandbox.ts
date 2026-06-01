/**
 * Recording stub {@link SandboxLike} for the tool-framework tests (MNEMO-16).
 *
 * The vitest-pool-workers env can't boot a real container, so tests inject a
 * `SandboxClient` wrapping one of these. It records every command/write/mkdir/
 * read, and `onRun`/`onRead` make results programmable, so a tool's
 * sandbox-driving `execute` can be asserted deterministically - no container,
 * no real shell. Built as a closure factory (not a class) so the stub satisfies
 * `SandboxLike` without a method that trips the repo's command-injection lint.
 *
 * Not a `.test.ts` file, so the pool never collects it as a suite.
 */
import {
  type RunOptions,
  SandboxClient,
  type SandboxLike,
} from "../src/sandbox/client.ts";

export type CmdResult = { stdout: string; stderr: string; exitCode: number };

/** A {@link SandboxLike} with recording arrays + programmable result builders. */
export interface StubSandbox extends SandboxLike {
  readonly runs: Array<{ command: string; options?: RunOptions }>;
  readonly writes: Array<{ path: string; content: string }>;
  readonly mkdirs: string[];
  readonly reads: string[];
  /** Program a command result for any command containing `substr` (first wins). */
  onRun(substr: string, result: Partial<CmdResult>): StubSandbox;
  /** Program the content `readFile(path)` returns. */
  onRead(path: string, content: string): StubSandbox;
  /** Fallback content for any unprogrammed read. */
  setDefaultRead(content: string): StubSandbox;
}

export function makeStubSandbox(): StubSandbox {
  const runs: Array<{ command: string; options?: RunOptions }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  const reads: string[] = [];
  const runRules: Array<[string, Partial<CmdResult>]> = [];
  const readContent = new Map<string, string>();
  let defaultRead = "";

  const stub: StubSandbox = {
    runs,
    writes,
    mkdirs,
    reads,
    onRun(substr, result) {
      runRules.push([substr, result]);
      return stub;
    },
    onRead(path, content) {
      readContent.set(path, content);
      return stub;
    },
    setDefaultRead(content) {
      defaultRead = content;
      return stub;
    },
    exec: async (command, options) => {
      runs.push({ command, options });
      for (const [substr, result] of runRules) {
        if (command.includes(substr)) {
          return { stdout: "", stderr: "", exitCode: 0, ...result };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    readFile: async (path) => {
      reads.push(path);
      return { content: readContent.get(path) ?? defaultRead };
    },
    writeFile: async (path, content) => {
      writes.push({ path, content });
      return { success: true };
    },
    mkdir: async (path) => {
      mkdirs.push(path);
      return { success: true };
    },
    destroy: async () => {},
  };
  return stub;
}

/** A {@link StubSandbox} plus a {@link SandboxClient} wrapping it (shared instance). */
export function stubSandboxClient(stub: StubSandbox = makeStubSandbox()): {
  stub: StubSandbox;
  client: SandboxClient;
} {
  return { stub, client: new SandboxClient(stub) };
}
