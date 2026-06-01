import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type RestoreHooks,
  restoreFile,
  restoreTree,
} from "../src/memory/versioning.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";
import { snapshotKey } from "../src/sandbox/persistence.ts";

// SDK is Beta (PRD §8.1) - the workers pool can't boot a container, so restore is
// exercised against an injected `SandboxLike` (via the MNEMO-06 SandboxClient)
// plus a recording DO-graph mock (the RestoreHooks). We assert the CONSERVATIVE
// restore contract (§6.9): restoreFile checks out the file then lands a NEW commit
// and reindexes the note; restoreTree snapshots to R2 first, restores the tree,
// makes ONE new commit, and reindexes everything - and NEITHER ever hard-resets
// (the restore is itself reversible because it only adds history).

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Recording `SandboxLike`. `on(substr, …)` overrides matching commands; the
 * shared `events` log interleaves sandbox runs with hook calls so ordering (e.g.
 * snapshot-before-restore) is verifiable. A dirty `status` + a `rev-parse` sha
 * let the MNEMO-07 `autoCommit` chokepoint proceed and return a new sha.
 */
class RecordingSandbox implements SandboxLike {
  readonly runs: string[] = [];
  private readonly rules: Array<[string, Partial<CmdResult>]> = [];

  constructor(private readonly events: string[]) {}

  on(substr: string, result: Partial<CmdResult>): this {
    this.rules.push([substr, result]);
    return this;
  }

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

  async readFile() {
    return { content: "" };
  }
  async writeFile() {
    return { success: true };
  }
  async mkdir() {
    return { success: true };
  }
}

/** Recording restore hooks (the DO-graph mock): log reindex calls into `events`. */
function recordingHooks(events: string[]): RestoreHooks {
  return {
    reindexNote: async (path) => {
      events.push(`reindexNote:${path}`);
    },
    reindexAll: async () => {
      events.push("reindexAll");
    },
  };
}

/** A sandbox primed so `autoCommit` sees a dirty tree and a fresh HEAD sha. */
function commitReady(events: string[]): RecordingSandbox {
  return new RecordingSandbox(events)
    .on("status --porcelain", { stdout: " M notes/x.md\n" })
    .on("rev-parse HEAD", { stdout: "newcommitsha\n" });
}

describe("restoreFile - checkout one file, NEW commit, reindex the note", () => {
  it("issues git checkout <sha> -- <path>, reindexes, then commits (no reset)", async () => {
    const events: string[] = [];
    const sandbox = commitReady(events);

    const result = await restoreFile(
      env,
      "restore-file-a",
      "notes/foo.md",
      "abcdef1234567890",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result).toEqual({
      path: "/brain/notes/foo.md",
      commit: "newcommitsha",
    });

    // The file was checked out from the revision (repo-relative, shell-quoted).
    expect(
      sandbox.runs.some((c) =>
        c.includes("checkout 'abcdef1234567890' -- 'notes/foo.md'"),
      ),
    ).toBe(true);

    // Ordering: checkout → reindexNote → commit (write-pipeline ordering).
    const checkoutIdx = events.findIndex((e) => e.includes("checkout"));
    const reindexIdx = events.indexOf("reindexNote:/brain/notes/foo.md");
    const commitIdx = events.findIndex((e) => e.includes("commit -m"));
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeLessThan(reindexIdx);
    expect(reindexIdx).toBeLessThan(commitIdx);

    // The commit reads as a restore, with the SHORT sha.
    expect(
      sandbox.runs.some(
        (c) =>
          c.includes("commit") &&
          c.includes("restore: notes/foo.md to abcdef1"),
      ),
    ).toBe(true);

    // Reversible: it only ADDS a commit - it never hard-resets/discards history.
    expect(sandbox.runs.some((c) => c.includes("reset"))).toBe(false);
  });

  it("a non-note restore (tools/) commits but does NOT reindex (not a neuron)", async () => {
    const events: string[] = [];
    const sandbox = commitReady(events);

    await restoreFile(
      env,
      "restore-file-b",
      "tools/run.py",
      "abcdef1234567890",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(events.some((e) => e.startsWith("reindexNote"))).toBe(false);
    expect(events.includes("reindexAll")).toBe(false);
    expect(
      sandbox.runs.some(
        (c) =>
          c.includes("commit") &&
          c.includes("restore: tools/run.py to abcdef1"),
      ),
    ).toBe(true);
  });
});

describe("restoreTree - snapshot, restore tree, ONE commit, reindex all", () => {
  it("snapshots to R2 BEFORE restoring, then reindexes all and commits once", async () => {
    const events: string[] = [];
    const agentId = "restore-tree-a";
    const sandbox = commitReady(events);

    const result = await restoreTree(
      env,
      agentId,
      "deadbeef",
      recordingHooks(events),
      new SandboxClient(sandbox),
    );

    expect(result.commit).toBe("newcommitsha");

    // A pre-restore recovery snapshot landed in R2 under the labeled key (§6.9).
    const snap = await env.BRAIN_BUCKET.get(
      snapshotKey(agentId, "pre-restore"),
    );
    expect(snap).not.toBeNull();

    // The tree restore is a read-tree (faithful, incl. deletions), NOT a reset.
    const restoreIdx = sandbox.runs.findIndex((c) =>
      c.includes("read-tree --reset -u 'deadbeef'"),
    );
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(sandbox.runs.some((c) => c.includes("reset --hard"))).toBe(false);

    // Snapshot (the tar archive) ran BEFORE the restore touched the tree.
    const snapshotRunIdx = sandbox.runs.findIndex((c) =>
      c.includes("tar -C /brain"),
    );
    expect(snapshotRunIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotRunIdx).toBeLessThan(restoreIdx);

    // The whole index is re-synced after the restore, before exactly one commit.
    const reindexIdx = events.indexOf("reindexAll");
    const commitIdx = events.findIndex((e) => e.includes("commit -m"));
    expect(reindexIdx).toBeGreaterThanOrEqual(0);
    expect(reindexIdx).toBeLessThan(commitIdx);
    expect(events.filter((e) => e.includes("commit -m"))).toHaveLength(1);

    // The commit reads as a whole-brain restore, with the SHORT sha (7 chars).
    expect(
      sandbox.runs.some((c) => c.includes("restore: brain to deadbee")),
    ).toBe(true);
  });
});
