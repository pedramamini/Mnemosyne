import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BrainPathError } from "../src/memory/layout.ts";
import {
  appendNote,
  type BrainWriteHooks,
  deleteNote,
  writeNote,
} from "../src/memory/write.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - the workers pool can't boot a container, so the
// write pipeline is exercised against an injected `SandboxLike` (via the MNEMO-06
// SandboxClient) plus recording graph/commit hooks. We assert the ORDERED
// pipeline (writeFile -> reindex -> commit), the path-traversal guard, and the
// delete path, with no container and no real git. The `events` log captures
// sandbox + hook calls interleaved so ordering is verifiable.

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/** Recording `SandboxLike` that logs writes/runs into a shared `events` log. */
class RecordingSandbox implements SandboxLike {
  readonly files = new Map<string, string>();
  readonly runs: string[] = [];
  private readonly rules: Array<[string, Partial<CmdResult>]> = [];

  constructor(private readonly events: string[]) {}

  on(substr: string, result: Partial<CmdResult>): this {
    this.rules.push([substr, result]);
    return this;
  }

  // SandboxLike.exec - the SDK's command runner (mirrors the existing mocks in
  // test/memory-git.test.ts); not Node's child_process.
  async exec(command: string): Promise<CmdResult> {
    this.runs.push(command);
    this.events.push(`run:${command}`);
    for (const [substr, result] of this.rules) {
      if (command.includes(substr)) {
        return { stdout: "", stderr: "", exitCode: 0, ...result };
      }
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
    this.events.push(`write:${path}`);
    return { success: true };
  }

  async mkdir() {
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

const NOTE_PATH = "/brain/notes/acme.md";

describe("writeNote - ordered pipeline", () => {
  it("writes the file, reindexes, then commits - in that order - and returns the sha", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    const result = await writeNote(
      env,
      "a",
      { slug: "acme", title: "Acme", content: "Body text." },
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result.path).toBe(NOTE_PATH);
    expect(result.commit).toBe("sha123");

    // The title was prepended as an H1 (note is self-describing for the reindex).
    expect(sandbox.files.get(NOTE_PATH)).toBe("# Acme\n\nBody text.");

    // Reindex MUST happen before commit so the committed tree and the DO graph
    // index agree; the file write precedes both.
    const writeIdx = events.indexOf(`write:${NOTE_PATH}`);
    const reindexIdx = events.indexOf(`reindex:${NOTE_PATH}`);
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(reindexIdx);
    expect(reindexIdx).toBeLessThan(commitIdx);

    // Commit carries the structured `memory: write <slug>` prefix.
    expect(events[commitIdx]).toBe("commit:memory: write acme");
  });
});

describe("writeNote - path validation", () => {
  it("rejects a traversal slug BEFORE any write/reindex/commit", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    await expect(
      writeNote(
        env,
        "a",
        { slug: "../evil", content: "pwned" },
        recordingHooks(events),
        new SandboxClient(sandbox),
      ),
    ).rejects.toBeInstanceOf(BrainPathError);

    // The hostile slug never touched the FS, the index, or git.
    expect(sandbox.files.size).toBe(0);
    expect(events.some((e) => e.startsWith("reindex:"))).toBe(false);
    expect(events.some((e) => e.startsWith("commit:"))).toBe(false);
  });
});

describe("appendNote - read-then-write", () => {
  it("appends to existing content after a blank-line separator", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events).on("test -f", {
      stdout: "y\n",
    });
    sandbox.files.set(NOTE_PATH, "# Acme\n\nFirst.");

    const result = await appendNote(
      env,
      "a",
      { slug: "acme", content: "Second." },
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(sandbox.files.get(NOTE_PATH)).toBe("# Acme\n\nFirst.\n\nSecond.");
    expect(result.commit).toBe("sha123");
  });

  it("treats a missing note as empty (append doubles as create)", async () => {
    const events: string[] = [];
    // No `test -f` rule → probe returns "" → file treated as absent.
    const sandbox = new RecordingSandbox(events);

    await appendNote(
      env,
      "a",
      { slug: "acme", content: "Fresh." },
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(sandbox.files.get(NOTE_PATH)).toBe("Fresh.");
  });
});

describe("deleteNote - remove file + neuron + commit", () => {
  it("removes the file, drops the neuron, then commits", async () => {
    const events: string[] = [];
    const sandbox = new RecordingSandbox(events);

    const result = await deleteNote(
      env,
      "a",
      "acme",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result.path).toBe(NOTE_PATH);
    expect(result.commit).toBe("sha123");

    // The file was removed with `rm -f <quoted path>`.
    expect(
      sandbox.runs.some((c) => c.startsWith("rm -f") && c.includes(NOTE_PATH)),
    ).toBe(true);

    // removeNeuron precedes the commit (index and tree agree at commit time).
    const removeIdx = events.indexOf(`remove:${NOTE_PATH}`);
    const commitIdx = events.findIndex((e) => e.startsWith("commit:"));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeLessThan(commitIdx);
    expect(events[commitIdx]).toBe("commit:memory: delete acme");
  });
});
