import { describe, expect, it } from "vitest";
import {
  SandboxClient,
  SandboxError,
  type SandboxLike,
} from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - the workers-pool env can't boot a real container, so
// these exercise the wrapper logic against an injected `SandboxLike` mock. The
// behavior against the real container is verified in the manual checkpoint.

/**
 * In-memory `SandboxLike`: a tiny FS map plus an `echo`/`false` command shim -
 * just enough to round-trip files and exercise exit codes through the wrapper.
 */
class FakeSandbox implements SandboxLike {
  readonly files = new Map<string, string>();
  destroyed = false;

  async exec(command: string) {
    if (command.startsWith("echo ")) {
      return { stdout: `${command.slice(5)}\n`, stderr: "", exitCode: 0 };
    }
    // `false` (and unknown commands) model a failing process - non-zero exit.
    if (command === "false") {
      return { stdout: "", stderr: "boom\n", exitCode: 1 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return { content };
  }

  async writeFile(path: string, content: string) {
    this.files.set(path, content);
    return { success: true };
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }) {
    return { success: true };
  }

  async destroy() {
    this.destroyed = true;
  }
}

/** A handle that throws on the run/read methods - exercises error normalization. */
function throwingSandbox(): SandboxLike {
  const fail = () => {
    throw new Error("rpc transport died");
  };
  return {
    exec: async () => fail(),
    readFile: async () => fail(),
    writeFile: async () => ({ success: true }),
    mkdir: async () => ({ success: true }),
  };
}

describe("SandboxClient - method surface", () => {
  it("round-trips a file: writeFile then readFile", async () => {
    const client = new SandboxClient(new FakeSandbox());
    await client.writeFile("/brain/note.md", "hello brain");
    expect(await client.readFile("/brain/note.md")).toBe("hello brain");
  });

  it("run returns stdout + exitCode 0 for a successful command", async () => {
    const client = new SandboxClient(new FakeSandbox());
    const result = await client.run("echo hi");
    expect(result.stdout).toContain("hi");
    expect(result.exitCode).toBe(0);
  });

  it("a failing command surfaces a non-zero exitCode (returned, not thrown)", async () => {
    const client = new SandboxClient(new FakeSandbox());
    const result = await client.run("false");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("boom");
  });

  it("mkdir and stop delegate without throwing", async () => {
    const fake = new FakeSandbox();
    const client = new SandboxClient(fake);
    await client.mkdir("/brain");
    await client.stop();
    expect(fake.destroyed).toBe(true);
  });

  it("stop is a no-op when the handle has no destroy() (Beta feature-detect)", async () => {
    // A handle missing the optional `destroy` must not crash idle-down.
    const minimal: SandboxLike = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => ({ content: "" }),
      writeFile: async () => ({ success: true }),
      mkdir: async () => ({ success: true }),
    };
    await expect(new SandboxClient(minimal).stop()).resolves.toBeUndefined();
  });
});

describe("SandboxClient - error normalization", () => {
  it("normalizes an SDK throw to a typed SandboxError tagged with the op", async () => {
    const client = new SandboxClient(throwingSandbox());

    const runErr = await client.run("echo hi").catch((e) => e);
    expect(runErr).toBeInstanceOf(SandboxError);
    expect((runErr as SandboxError).op).toBe("run");
    expect((runErr as SandboxError).message).toContain("rpc transport died");

    const readErr = await client.readFile("/x").catch((e) => e);
    expect(readErr).toBeInstanceOf(SandboxError);
    expect((readErr as SandboxError).op).toBe("readFile");
  });
});
