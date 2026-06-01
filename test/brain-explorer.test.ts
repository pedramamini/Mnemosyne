import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  BrainFileTooLargeError,
  createBrainFile,
  deleteBrainPath,
  listTree,
  MAX_READ_BYTES,
  readBrainFile,
  writeBrainFile,
} from "../src/memory/explorer.ts";
import { BrainPathError } from "../src/memory/layout.ts";
import type { BrainWriteHooks } from "../src/memory/write.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - the workers pool can't boot a container, so the
// explorer service is exercised against an injected `SandboxLike` (via the
// MNEMO-06 SandboxClient) plus recording graph/commit hooks. We assert tree
// parsing, the read size-cap + binary base64 path, that a NOTE edit reindexes +
// commits while a TOOL edit only commits, that a note delete removes the neuron,
// and that every traversal input is rejected by `assertInsideBrain` before any
// FS call. The `events` log captures sandbox + hook calls interleaved.

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Recording `SandboxLike` with programmable command responses. `on(substr, …)`
 * overrides the result for any command containing `substr` (first rule wins);
 * everything else returns a clean exit. Files written/read flow through `files`.
 * `runCommand` is the SDK's in-container command runner (mirrors the existing
 * mocks in test/memory-git.test.ts), NOT Node's child_process.
 */
class RecordingSandbox implements SandboxLike {
  readonly files = new Map<string, string>();
  readonly runs: string[] = [];
  readonly mkdirs: string[] = [];
  private readonly rules: Array<[string, Partial<CmdResult>]> = [];

  constructor(private readonly events: string[]) {}

  on(substr: string, result: Partial<CmdResult>): this {
    this.rules.push([substr, result]);
    return this;
  }

  // Satisfies SandboxLike.exec; defined as a field so it stays a single, simple
  // command runner the rules table drives.
  exec = async (command: string): Promise<CmdResult> => {
    this.runs.push(command);
    this.events.push(`run:${command}`);
    for (const [substr, result] of this.rules) {
      if (command.includes(substr)) {
        return { stdout: "", stderr: "", exitCode: 0, ...result };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    this.events.push(`read:${path}`);
    return { content };
  }

  async writeFile(path: string, content: string) {
    this.files.set(path, content);
    this.events.push(`write:${path}`);
    return { success: true };
  }

  async mkdir(path: string) {
    this.mkdirs.push(path);
    return { success: true };
  }
}

/** Recording hooks: log reindex/remove/commit into the same `events` log. */
function recordingHooks(events: string[], sha = "sha123"): BrainWriteHooks {
  return {
    reindexNote: async (path) => {
      events.push(`reindex:${path}`);
    },
    removeNeuron: (path) => {
      events.push(`remove:${path}`);
    },
    commitBrain: async (message) => {
      events.push(`commit:${message}`);
      return sha;
    },
  };
}

describe("listTree - parses find/printf output into typed entries", () => {
  it("maps the tab-separated find output to {path,type,size,modified}", async () => {
    const events: string[] = [];
    // %y \t %s \t %T@ \t %p - a dir then two files, mtime as epoch.fraction.
    const sandbox = new RecordingSandbox(events).on("find", {
      stdout:
        "d\t4096\t1716500000.0\t/brain/notes\n" +
        "f\t128\t1716500001.5\t/brain/notes/acme.md\n" +
        "f\t64\t1716500002\t/brain/tools/run.py\n",
    });

    const entries = await listTree(
      env,
      "a",
      undefined,
      new SandboxClient(sandbox),
    );

    expect(entries).toEqual([
      {
        path: "/brain/notes",
        type: "dir",
        size: 4096,
        modified: 1716500000000,
      },
      {
        path: "/brain/notes/acme.md",
        type: "file",
        size: 128,
        modified: 1716500001500,
      },
      {
        path: "/brain/tools/run.py",
        type: "file",
        size: 64,
        modified: 1716500002000,
      },
    ]);

    // The find prunes `.git` so explorer browsing never dumps git internals.
    const findCmd = sandbox.runs.find((c) => c.startsWith("find"));
    expect(findCmd).toContain(".git");
    expect(findCmd).toContain("-prune");
  });

  it("validates the subpath stays inside /brain before listing", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);
    await expect(
      listTree(env, "a", "../etc", new SandboxClient(sandbox)),
    ).rejects.toBeInstanceOf(BrainPathError);
    expect(sandbox.runs.length).toBe(0);
  });
});

describe("readBrainFile - size cap + binary handling", () => {
  it("rejects a file over the size cap before reading its bytes", async () => {
    const events: string[] = [];
    const big = MAX_READ_BYTES + 1;
    const sandbox = new RecordingSandbox(events).on("printf 'file", {
      stdout: `file\n${big}\ntext\n`,
    });

    await expect(
      readBrainFile(env, "a", "reports/huge.bin", new SandboxClient(sandbox)),
    ).rejects.toBeInstanceOf(BrainFileTooLargeError);

    // It probed, found it too large, and never read the content.
    expect(events.some((e) => e.startsWith("read:"))).toBe(false);
    expect(sandbox.runs.some((c) => c.includes("base64 -w0"))).toBe(false);
  });

  it("base64-encodes a binary file (never marshals raw bytes as text)", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events)
      .on("printf 'file", { stdout: "file\n12\nbinary\n" })
      .on("base64 -w0", { stdout: "QklOQVJZLURBVEE=" });

    const file = await readBrainFile(
      env,
      "a",
      "reports/logo.png",
      new SandboxClient(sandbox),
    );

    expect(file).toEqual({
      path: "/brain/reports/logo.png",
      content: "QklOQVJZLURBVEE=",
      encoding: "base64",
      size: 12,
    });
  });

  it("returns text inline (utf8) for a text file", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events).on("printf 'file", {
      stdout: "file\n11\ntext\n",
    });
    sandbox.files.set("/brain/notes/acme.md", "# Acme\n\nhi");

    const file = await readBrainFile(
      env,
      "a",
      "notes/acme.md",
      new SandboxClient(sandbox),
    );
    expect(file.encoding).toBe("utf8");
    expect(file.content).toBe("# Acme\n\nhi");
  });
});

describe("writeBrainFile - notes funnel through the MNEMO-10 pipeline", () => {
  it("a note path reindexes THEN commits (identical to an agent write)", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    const result = await writeBrainFile(
      env,
      "a",
      { path: "notes/foo.md", content: "# Foo\n\nbody" },
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result.path).toBe("/brain/notes/foo.md");
    expect(result.commit).toBe("sha123");

    const writeIdx = events.indexOf("write:/brain/notes/foo.md");
    const reindexIdx = events.indexOf("reindex:/brain/notes/foo.md");
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(reindexIdx);
    expect(reindexIdx).toBeLessThan(commitIdx);
    // The commit reads as a first-class memory write, not an explorer edit.
    expect(events[commitIdx]).toBe("commit:memory: write foo.md");
  });

  it("a non-note (tools/) path commits but does NOT reindex (it's not a neuron)", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    const result = await writeBrainFile(
      env,
      "a",
      { path: "tools/bar.py", content: "print('hi')\n" },
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result.path).toBe("/brain/tools/bar.py");
    expect(sandbox.files.get("/brain/tools/bar.py")).toBe("print('hi')\n");

    // Parent dir created, file written, ONE explorer commit, NO reindex.
    expect(sandbox.mkdirs).toContain("/brain/tools");
    expect(events.some((e) => e.startsWith("reindex:"))).toBe(false);
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(events[commitIdx]).toBe("commit:explorer: edit /brain/tools/bar.py");
  });

  it("createBrainFile rejects a path that already exists", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events).on("test -e", {
      stdout: "y\n",
    });
    await expect(
      createBrainFile(
        env,
        "a",
        { path: "tools/bar.py", content: "x" },
        recordingHooks(events),
        new SandboxClient(sandbox),
      ),
    ).rejects.toThrow(/already exists/);
  });
});

describe("deleteBrainPath - note removal drops the neuron", () => {
  it("a note delete removes the neuron THEN commits", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    const result = await deleteBrainPath(
      env,
      "a",
      "notes/foo.md",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );
    expect(result.path).toBe("/brain/notes/foo.md");

    // rm ran, neuron removed before the commit, commit is a memory delete.
    expect(
      sandbox.runs.some(
        (c) => c.startsWith("rm -f") && c.includes("/brain/notes/foo.md"),
      ),
    ).toBe(true);
    const removeIdx = events.indexOf("remove:/brain/notes/foo.md");
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeLessThan(commitIdx);
    expect(events[commitIdx]).toBe("commit:memory: delete foo.md");
  });

  it("a non-note delete rm -rf's and commits an explorer delete (no neuron op)", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    await deleteBrainPath(
      env,
      "a",
      "tools/bar.py",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );
    expect(
      sandbox.runs.some(
        (c) => c.startsWith("rm -rf") && c.includes("/brain/tools/bar.py"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.startsWith("remove:"))).toBe(false);
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(events[commitIdx]).toBe(
      "commit:explorer: delete /brain/tools/bar.py",
    );
  });
});

describe("path traversal - rejected before any FS call", () => {
  for (const bad of [
    "../evil",
    "notes/../../etc/passwd",
    "/etc/passwd",
    "/brain/../x",
  ]) {
    it(`rejects ${bad}`, async () => {
      const events: string[] = [];
      const sandbox = new RecordingSandbox(events);

      await expect(
        writeBrainFile(
          env,
          "a",
          { path: bad, content: "pwned" },
          recordingHooks(events),
          new SandboxClient(sandbox),
        ),
      ).rejects.toBeInstanceOf(BrainPathError);

      // Nothing touched the FS, the index, or git.
      expect(sandbox.files.size).toBe(0);
      expect(sandbox.runs.length).toBe(0);
      expect(events.length).toBe(0);
    });
  }
});
