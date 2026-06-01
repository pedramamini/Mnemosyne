import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assertSafeRev,
  BadRevisionError,
  commitDiff,
  fileAtRevision,
  fileDiff,
  fileHistory,
  listHistory,
  MAX_PATCH_BYTES,
} from "../src/memory/versioning.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - the workers pool can't boot a container, so the
// versioning reads are exercised against an injected `SandboxLike` (via the
// MNEMO-06 SandboxClient) fed CANNED git output. We assert: `git log -z`/`%x1f`
// parsing (sha/author/ts/subject + derived category), that subjects/filenames
// with spaces survive the `-z`/`\x1f` handling, `--numstat` add/delete parsing,
// diff truncation past the size bound, and that every sha/path arg is shell-quoted.

type CmdResult = { stdout: string; stderr: string; exitCode: number };
const FS = "\x1f"; // field separator git emits for %x1f
const RS = "\0"; // record separator git emits with -z

/**
 * Recording `SandboxLike` with programmable command responses. `on(substr, …)`
 * overrides the result for any command containing `substr` (first rule wins);
 * everything else returns a clean exit. Mirrors test/memory-git.test.ts.
 */
class RecordingSandbox implements SandboxLike {
  readonly runs: string[] = [];
  private readonly rules: Array<[string, Partial<CmdResult>]> = [];

  on(substr: string, result: Partial<CmdResult>): this {
    this.rules.push([substr, result]);
    return this;
  }

  exec = async (command: string): Promise<CmdResult> => {
    this.runs.push(command);
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

/** Build one `git log -z` record (sha/author/at/subject, %x1f-delimited). */
function logRecord(
  sha: string,
  author: string,
  at: number,
  subject: string,
): string {
  return [sha, author, String(at), subject].join(FS);
}

describe("listHistory - parses log + derives category", () => {
  it("parses sha/author/ts/subject and the category for every prefix", async () => {
    const records = [
      logRecord(
        "a".repeat(40),
        "Mnemosyne Agent",
        1716500000,
        "memory: write acme",
      ),
      logRecord(
        "b".repeat(40),
        "Mnemosyne Agent",
        1716500100,
        "consolidate: merged 3 notes",
      ),
      logRecord(
        "c".repeat(40),
        "Mnemosyne Agent",
        1716500200,
        "tool: author scrape.py",
      ),
      logRecord(
        "d".repeat(40),
        "Mnemosyne Agent",
        1716500300,
        "explorer: edit /brain/tools/x",
      ),
      logRecord(
        "e".repeat(40),
        "Mnemosyne Agent",
        1716500400,
        "init: brain layout",
      ),
      logRecord(
        "f".repeat(40),
        "Mnemosyne Agent",
        1716500500,
        "restore: notes/foo.md to abc1234",
      ),
    ].join(RS);
    const sandbox = new RecordingSandbox().on("log -z", { stdout: records });

    const page = await listHistory(env, "a", {}, new SandboxClient(sandbox));

    expect(page.entries.map((e) => e.category)).toEqual([
      "memory",
      "consolidate",
      "tool",
      "explorer",
      "init",
      "restore",
    ]);
    expect(page.entries[0]).toEqual({
      sha: "a".repeat(40),
      author: "Mnemosyne Agent",
      ts: 1716500000 * 1000, // %at seconds → epoch ms
      subject: "memory: write acme",
      category: "memory",
    });
    // The issued log uses -z + the %x1f format so parsing is delimiter-robust.
    const cmd = sandbox.runs.find((c) => c.includes("log -z"));
    expect(cmd).toContain("--pretty=format:%H");
    expect(cmd).toContain("%x1f");
  });

  it("keeps subjects with spaces/quotes intact (the -z/%x1f handling)", async () => {
    const subject = `memory: write it's a "tricky" note`;
    const records = logRecord("9".repeat(40), "Mnemosyne Agent", 1, subject);
    const sandbox = new RecordingSandbox().on("log -z", { stdout: records });

    const page = await listHistory(env, "a", {}, new SandboxClient(sandbox));
    expect(page.entries[0].subject).toBe(subject);
    expect(page.entries[0].category).toBe("memory");
  });

  it("pages: fetches limit+1 and returns a nextCursor only when more exist", async () => {
    const three = [
      logRecord("1".repeat(40), "x", 1, "memory: a"),
      logRecord("2".repeat(40), "x", 2, "memory: b"),
      logRecord("3".repeat(40), "x", 3, "memory: c"),
    ].join(RS);
    const sandbox = new RecordingSandbox().on("log -z", { stdout: three });

    const page = await listHistory(
      env,
      "a",
      { limit: 2 },
      new SandboxClient(sandbox),
    );
    // Asked for 2 → got the third as the "is there more?" probe → cursor set.
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBe("2");
    const cmd = sandbox.runs.find((c) => c.includes("log -z"));
    expect(cmd).toContain("--max-count=3"); // limit + 1
    expect(cmd).toContain("--skip=0");
  });

  it("a final page (fewer than limit) returns a null cursor", async () => {
    const one = logRecord("1".repeat(40), "x", 1, "memory: a");
    const sandbox = new RecordingSandbox().on("log -z", { stdout: one });
    const page = await listHistory(
      env,
      "a",
      { limit: 5 },
      new SandboxClient(sandbox),
    );
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});

describe("fileHistory - --follow for one path, shell-escaped", () => {
  it("follows renames and shell-quotes a path with spaces", async () => {
    const records = logRecord("a".repeat(40), "x", 5, "memory: write my note");
    const sandbox = new RecordingSandbox().on("log --follow", {
      stdout: records,
    });

    const page = await fileHistory(
      env,
      "a",
      "notes/my note.md",
      {},
      new SandboxClient(sandbox),
    );
    expect(page.entries[0].subject).toBe("memory: write my note");

    const cmd = sandbox.runs.find((c) => c.includes("log --follow"));
    expect(cmd).toContain("--follow");
    // Path is repo-relative AND single-quoted so the space can't split the arg.
    expect(cmd).toContain("-- 'notes/my note.md'");
  });
});

describe("commitDiff - --numstat add/delete counts + per-file patch", () => {
  it("parses numstat into per-file counts and attaches each file's patch", async () => {
    // -z numstat: leading empty (format=) record, then `adds\tdels\tpath` chunks.
    const numstat = `${RS}1\t0\tnotes/foo.md${RS}2\t3\ttools/run.py${RS}`;
    const patch =
      "diff --git a/notes/foo.md b/notes/foo.md\n" +
      "@@ -1 +1,2 @@\n hello\n+world\n" +
      "diff --git a/tools/run.py b/tools/run.py\n" +
      "@@ -1,3 +1,2 @@\n-old\n+new\n";
    const sandbox = new RecordingSandbox()
      .on("--numstat", { stdout: numstat })
      .on("--format= -p", { stdout: patch });

    const diff = await commitDiff(
      env,
      "a",
      "abc1234",
      new SandboxClient(sandbox),
    );

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({
      path: "notes/foo.md",
      additions: 1,
      deletions: 0,
    });
    expect(diff.files[0].patch).toContain("+world");
    expect(diff.files[1]).toMatchObject({
      path: "tools/run.py",
      additions: 2,
      deletions: 3,
    });
    expect(diff.files[1].patch).toContain("diff --git a/tools/run.py");

    // The sha is shell-quoted on both `git show` invocations.
    expect(sandbox.runs.every((c) => !c.includes("show abc1234 ")));
    expect(sandbox.runs.some((c) => c.includes("show 'abc1234'"))).toBe(true);
  });

  it("flags binary files (no counts) parsed from `-\\t-`", async () => {
    const numstat = `${RS}-\t-\treports/logo.png${RS}`;
    const sandbox = new RecordingSandbox()
      .on("--numstat", { stdout: numstat })
      .on("--format= -p", { stdout: "" });

    const diff = await commitDiff(
      env,
      "a",
      "deadbeef",
      new SandboxClient(sandbox),
    );
    expect(diff.files[0]).toMatchObject({
      path: "reports/logo.png",
      additions: 0,
      deletions: 0,
      binary: true,
    });
  });

  it("truncates a per-file patch past the size bound and flags it", async () => {
    const huge = "z".repeat(MAX_PATCH_BYTES + 100);
    const numstat = `${RS}9\t0\tnotes/big.md${RS}`;
    const patch = `diff --git a/notes/big.md b/notes/big.md\n${huge}`;
    const sandbox = new RecordingSandbox()
      .on("--numstat", { stdout: numstat })
      .on("--format= -p", { stdout: patch });

    const diff = await commitDiff(
      env,
      "a",
      "feedface",
      new SandboxClient(sandbox),
    );
    expect(diff.files[0].truncated).toBe(true);
    expect(diff.files[0].patch.length).toBe(MAX_PATCH_BYTES);
  });
});

describe("fileDiff - range vs working tree, shell-escaped", () => {
  it("diffs from..to for one file with both revs quoted", async () => {
    const sandbox = new RecordingSandbox().on("diff", {
      stdout: "diff --git a/notes/a.md b/notes/a.md\n@@\n-x\n+y\n",
    });
    const result = await fileDiff(
      env,
      "a",
      "notes/a.md",
      "aaaa111",
      "bbbb222",
      new SandboxClient(sandbox),
    );
    expect(result.toSha).toBe("bbbb222");
    expect(result.patch).toContain("+y");
    const cmd = sandbox.runs.find((c) => c.includes("diff"));
    expect(cmd).toContain("'aaaa111'..'bbbb222'");
    expect(cmd).toContain("-- 'notes/a.md'");
  });

  it("omitting toSha diffs the revision against the working tree", async () => {
    const sandbox = new RecordingSandbox().on("diff", { stdout: "" });
    const result = await fileDiff(
      env,
      "a",
      "notes/a.md",
      "aaaa111",
      undefined,
      new SandboxClient(sandbox),
    );
    expect(result.toSha).toBeNull();
    const cmd = sandbox.runs.find((c) => c.includes("diff"));
    expect(cmd).toContain("'aaaa111'");
    expect(cmd).not.toContain(".."); // no range → single rev vs worktree
  });
});

describe("fileAtRevision - git show <sha>:<path>, error on miss", () => {
  it("returns the file content at a revision (sha:relpath quoted as one word)", async () => {
    const sandbox = new RecordingSandbox().on("show", {
      stdout: "# Acme\n\nold body\n",
    });
    const at = await fileAtRevision(
      env,
      "a",
      "notes/acme.md",
      "abc1234",
      new SandboxClient(sandbox),
    );
    expect(at.content).toBe("# Acme\n\nold body\n");
    expect(at.path).toBe("/brain/notes/acme.md");
    const cmd = sandbox.runs.find((c) => c.includes("show"));
    expect(cmd).toContain("'abc1234:notes/acme.md'");
  });

  it("throws a clear error when the file didn't exist at that revision", async () => {
    const sandbox = new RecordingSandbox().on("show", {
      stdout: "",
      stderr: "fatal: path 'notes/gone.md' does not exist",
      exitCode: 128,
    });
    await expect(
      fileAtRevision(
        env,
        "a",
        "notes/gone.md",
        "abc1234",
        new SandboxClient(sandbox),
      ),
    ).rejects.toThrow(/no such file at revision/);
  });
});

describe("assertSafeRev - revision whitelist (no option injection)", () => {
  it("accepts hex shas and HEAD-relative refs", () => {
    expect(assertSafeRev("abc1234")).toBe("abc1234");
    expect(assertSafeRev("HEAD")).toBe("HEAD");
    expect(assertSafeRev("HEAD~3")).toBe("HEAD~3");
  });

  it("rejects anything that could read as a git option, before touching git", async () => {
    for (const bad of ["--upload-pack=x", "-p", "; rm -rf /", "../etc"]) {
      expect(() => assertSafeRev(bad)).toThrow(BadRevisionError);
    }
    // And the read functions reject the bad rev before issuing any command.
    const sandbox = new RecordingSandbox();
    await expect(
      commitDiff(env, "a", "--evil", new SandboxClient(sandbox)),
    ).rejects.toThrow(BadRevisionError);
    expect(sandbox.runs.length).toBe(0);
  });
});
