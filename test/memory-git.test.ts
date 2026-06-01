import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  autoCommit,
  GIT_AUTHOR_EMAIL,
  GIT_AUTHOR_NAME,
  initBrainRepo,
  isCleanTree,
} from "../src/memory/git.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - a real git binary is exercised in the manual
// checkpoint. Here we inject a recording `SandboxLike` (via the MNEMO-06
// SandboxClient) and assert the ISSUED git command sequence + shell escaping
// deterministically, with no container and no real git.

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Recording `SandboxLike` with programmable command responses. `on(substr, …)`
 * overrides the result for any command containing `substr` (first rule wins);
 * everything else returns a clean exit. Records runs/mkdirs/writes for asserts.
 */
class GitRecordingSandbox implements SandboxLike {
  readonly runs: string[] = [];
  readonly mkdirs: string[] = [];
  readonly writes: Array<{ path: string; content: string }> = [];
  private readonly rules: Array<[string, Partial<CmdResult>]> = [];

  on(substr: string, result: Partial<CmdResult>): this {
    this.rules.push([substr, result]);
    return this;
  }

  async exec(command: string): Promise<CmdResult> {
    this.runs.push(command);
    for (const [substr, result] of this.rules) {
      if (command.includes(substr)) {
        return { stdout: "", stderr: "", exitCode: 0, ...result };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  async readFile() {
    return { content: "" };
  }

  async writeFile(path: string, content: string) {
    this.writes.push({ path, content });
    return { success: true };
  }

  async mkdir(path: string) {
    this.mkdirs.push(path);
    return { success: true };
  }
}

describe("initBrainRepo - provisioning sequence", () => {
  it("on a fresh brain: mkdir dirs, write README/.gitignore, init, identity, commit", async () => {
    const fake = new GitRecordingSandbox(); // probe returns "" → not "exists"
    const initialized = await initBrainRepo(
      env,
      "fresh",
      new SandboxClient(fake),
    );
    expect(initialized).toBe(true);

    // Created the canonical directory tree.
    expect(fake.mkdirs).toContain("/brain/notes");
    expect(fake.mkdirs).toContain("/brain/tools");
    expect(fake.mkdirs).toContain("/brain/reports");

    // Seeded README + .gitignore.
    expect(fake.writes.some((w) => w.path === "/brain/README.md")).toBe(true);
    expect(fake.writes.some((w) => w.path === "/brain/.gitignore")).toBe(true);

    // Issued init → identity → initial commit, all against `-C /brain`.
    expect(fake.runs).toContain("git -C /brain init");
    expect(
      fake.runs.some(
        (c) => c.includes("config user.name") && c.includes(GIT_AUTHOR_NAME),
      ),
    ).toBe(true);
    expect(
      fake.runs.some(
        (c) => c.includes("config user.email") && c.includes(GIT_AUTHOR_EMAIL),
      ),
    ).toBe(true);
    expect(fake.runs).toContain("git -C /brain add -A");
    expect(
      fake.runs.some(
        (c) => c.startsWith("git -C /brain commit") && c.includes("init:"),
      ),
    ).toBe(true);
  });

  it("is idempotent: no-ops when /brain/.git already exists (restored brain)", async () => {
    const fake = new GitRecordingSandbox().on(".git", { stdout: "exists\n" });
    const initialized = await initBrainRepo(
      env,
      "restored",
      new SandboxClient(fake),
    );
    expect(initialized).toBe(false);

    // Only the probe ran - nothing was created or committed.
    expect(fake.mkdirs.length).toBe(0);
    expect(fake.writes.length).toBe(0);
    expect(fake.runs.some((c) => c.includes("git -C /brain init"))).toBe(false);
    expect(fake.runs.some((c) => c.includes("commit"))).toBe(false);
  });
});

describe("autoCommit - stage, commit, return sha", () => {
  it("dirty tree: runs add -A + commit, returns the new HEAD sha", async () => {
    const fake = new GitRecordingSandbox()
      .on("status --porcelain", { stdout: " M notes/acme.md\n" })
      .on("rev-parse HEAD", { stdout: "abc123def456\n" });

    const sha = await autoCommit(
      env,
      "a",
      "memory: write acme",
      undefined,
      new SandboxClient(fake),
    );
    expect(sha).toBe("abc123def456");
    expect(fake.runs).toContain("git -C /brain add -A");
    expect(
      fake.runs.some(
        (c) => c.startsWith("git -C /brain commit") && c.includes("-m"),
      ),
    ).toBe(true);
  });

  it("clean tree: skips the commit and returns null", async () => {
    const fake = new GitRecordingSandbox().on("status --porcelain", {
      stdout: "",
    });

    const sha = await autoCommit(
      env,
      "a",
      "memory: write acme",
      undefined,
      new SandboxClient(fake),
    );
    expect(sha).toBeNull();
    // It staged, found nothing, and never committed.
    expect(fake.runs).toContain("git -C /brain add -A");
    expect(fake.runs.some((c) => c.includes("commit"))).toBe(false);
  });

  it("shell-escapes the commit message so quotes/spaces can't break the command", async () => {
    const fake = new GitRecordingSandbox()
      .on("status --porcelain", { stdout: " M x\n" })
      .on("rev-parse HEAD", { stdout: "deadbeef\n" });

    // A hostile slug: embedded single quote, double quotes, and spaces.
    const message = `memory: write it's a "tricky" note`;
    await autoCommit(env, "a", message, undefined, new SandboxClient(fake));

    const commitCmd = fake.runs.find((c) =>
      c.startsWith("git -C /brain commit"),
    );
    expect(commitCmd).toBeDefined();
    // The whole message is one single-quoted word, with `'` rendered as `'\''`.
    expect(commitCmd).toContain(`'memory: write it'\\''s a "tricky" note'`);
    // And there is no bare (unquoted) occurrence that could break the command.
    expect(commitCmd).not.toContain(`-m memory:`);
  });
});

describe("isCleanTree - git status --porcelain", () => {
  it("empty porcelain output → clean", async () => {
    const fake = new GitRecordingSandbox().on("status --porcelain", {
      stdout: "",
    });
    expect(await isCleanTree(env, "a", new SandboxClient(fake))).toBe(true);
  });

  it("non-empty porcelain output → dirty", async () => {
    const fake = new GitRecordingSandbox().on("status --porcelain", {
      stdout: " M notes/acme.md\n?? notes/new.md\n",
    });
    expect(await isCleanTree(env, "a", new SandboxClient(fake))).toBe(false);
  });
});
