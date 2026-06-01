/**
 * Sandbox client - the single typed boundary over the Cloudflare Sandbox SDK.
 *
 * PRD §7.3: the sandbox is the agent's computer - an isolated Linux container,
 * one per agent, giving real shell tooling plus run-command / readFile /
 * writeFile. PRD §8.1: the SDK is GA (April 2026) but still ships a "Beta"
 * header, so EVERY raw SDK call is funnelled through this module and wrapped in
 * try/catch that normalizes failures to a typed {@link SandboxError}. Later
 * phases (brain FS MNEMO-07, tools Track C, Code Interpreter MNEMO-23) talk to
 * THIS wrapper, never the raw SDK - so the Beta surface is auditable in one file.
 *
 * SDK methods used here (the entire Beta surface this module depends on):
 *   - `getSandbox(ns, id)`  - resolve a handle keyed by idFromName(id) (§8.1).
 *   - `Sandbox.exec(cmd, opts?)`         -> ExecResult { stdout, stderr, exitCode }
 *   - `Sandbox.readFile(path)`           -> ReadFileResult { content }
 *   - `Sandbox.writeFile(path, content)` -> WriteFileResult
 *   - `Sandbox.mkdir(path, { recursive })` -> MkdirResult
 *   - `Sandbox.destroy()`                - tear the container down (idle-down).
 *
 * The wrapper is split from its handle so it is testable WITHOUT a real
 * container: `getSandbox(env, agentId)` resolves the live SDK handle, but the
 * `SandboxClient` constructor accepts any {@link SandboxLike}, so tests inject a
 * mock and assert the wrapper logic (the workers-pool test env can't boot a
 * container - see test/sandbox-client.test.ts).
 */
import { getSandbox as sdkGetSandbox } from "@cloudflare/sandbox";
import type { Env } from "../env.ts";

/** The operations the wrapper performs, used to tag normalized errors. */
export type SandboxOp = "run" | "readFile" | "writeFile" | "mkdir" | "stop";

/**
 * Typed error every wrapper method throws on an SDK failure. Isolating the
 * Beta SDK's error shapes (PRD §8.1) behind one error type means callers branch
 * on `op` + `message`, never on the SDK's internal error classes.
 */
export class SandboxError extends Error {
  constructor(
    readonly op: SandboxOp,
    readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`sandbox ${op} failed: ${detail}`);
    this.name = "SandboxError";
  }
}

/** Result of {@link SandboxClient.run} - the stable subset callers depend on. */
export interface RunResult {
  stdout: string;
  stderr: string;
  /** Process exit code; non-zero is returned (NOT thrown) - see `run`. */
  exitCode: number;
}

/** Options forwarded to the SDK's command runner; a narrow, stable subset. */
export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Maximum execution time in milliseconds. */
  timeout?: number;
  /** Per-command environment overlay. */
  env?: Record<string, string | undefined>;
}

/**
 * The minimal handle the wrapper consumes - exactly the SDK methods used above,
 * single-signature so a test mock is trivial to write. The real SDK `Sandbox`
 * (which `implements ISandbox`) is structurally assignable to this: its richer
 * return types and wider parameter types satisfy these narrower ones.
 */
export interface SandboxLike {
  exec(
    command: string,
    options?: RunOptions,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean }>;
  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<{ success: boolean }>;
  /** Tear the container down. Optional + feature-detected (Beta surface). */
  destroy?(): Promise<void>;
}

/**
 * Thin, defensive wrapper over one sandbox handle. Each method is one SDK call
 * inside a try/catch that re-throws a {@link SandboxError}; no other logic lives
 * here (persistence + lifecycle compose this wrapper, see sibling modules).
 */
export class SandboxClient {
  constructor(private readonly handle: SandboxLike) {}

  /**
   * Run a shell command. A non-zero `exitCode` is a normal result and is
   * RETURNED (commands fail all the time); only an SDK/transport failure throws
   * a {@link SandboxError}. Each call is one subrequest - respect the 1,000/req
   * cap (PRD §8.5).
   */
  run(cmd: string, opts?: RunOptions): Promise<RunResult> {
    return this.guard("run", async () => {
      const r = await this.handle.exec(cmd, opts);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    });
  }

  /** Read a UTF-8 file from the sandbox FS. */
  readFile(path: string): Promise<string> {
    return this.guard("readFile", async () => {
      const r = await this.handle.readFile(path);
      return r.content;
    });
  }

  /** Write a UTF-8 file to the sandbox FS (overwrites). */
  async writeFile(path: string, contents: string): Promise<void> {
    await this.guard("writeFile", () => this.handle.writeFile(path, contents));
  }

  /**
   * Write raw BYTES to the sandbox FS (overwrites). Binary artifacts - e.g. the
   * report chart PNGs MNEMO-23 produces - can't go through {@link writeFile}: a
   * UTF-8 round-trip would corrupt the bytes. We base64-encode and use the SDK's
   * `encoding: "base64"` write so the container decodes back to exact bytes. This
   * keeps the (Beta, §8.1) encoded-write call in the same single FS seam.
   */
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    const b64 = bytesToBase64(bytes);
    await this.guard("writeFile", () =>
      this.handle.writeFile(path, b64, { encoding: "base64" }),
    );
  }

  /** Create a directory (recursive - `mkdir -p` semantics). */
  async mkdir(path: string): Promise<void> {
    await this.guard("mkdir", () =>
      this.handle.mkdir(path, { recursive: true }),
    );
  }

  /**
   * Stop and release the container so billing stops (active-time only, §8.4).
   * `destroy` is feature-detected: the Beta SDK may rename/remove it, and a
   * missing teardown method must not crash idle-down (it just means the
   * platform's own idle-sleep reclaims the container later).
   */
  async stop(): Promise<void> {
    await this.guard("stop", async () => {
      if (typeof this.handle.destroy === "function") {
        await this.handle.destroy();
      }
    });
  }

  /** Run `fn` (one SDK call), normalizing any throw to a tagged SandboxError. */
  private async guard<T>(op: SandboxOp, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new SandboxError(op, err);
    }
  }
}

/**
 * Resolve the per-agent {@link SandboxClient}. One sandbox per agent: the SDK's
 * `getSandbox(ns, id)` keys the container DO by `idFromName(id)`, the same idiom
 * the AGENT DO uses, so agent <-> DO <-> sandbox map 1:1 (PRD §8.1).
 */
export function getSandbox(env: Env, agentId: string): SandboxClient {
  return new SandboxClient(sdkGetSandbox(env.SANDBOX, agentId));
}

/** Encode raw bytes to a base64 string (for {@link SandboxClient.writeFileBytes}). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
