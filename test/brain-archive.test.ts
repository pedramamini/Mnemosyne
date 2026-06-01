import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ArchiveFormat, archiveBrain } from "../src/memory/archive.ts";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";

// SDK is Beta (PRD §8.1) - the workers pool can't boot a container, so the
// whole-brain archive export is exercised against an injected `SandboxLike`
// (via the MNEMO-06 SandboxClient). We assert the issued archive command (tar
// vs zip, `.git` kept), the base64 round-trip back to bytes, the suggested
// filename + content type, and rejection of an unknown format. `runCommand` is
// the SDK's in-container command runner, NOT Node's child_process.

type CmdResult = { stdout: string; stderr: string; exitCode: number };

/** Records the issued commands; `readFile` returns a fixed base64 sidecar. */
class RecordingSandbox implements SandboxLike {
  readonly runs: string[] = [];
  /** base64 the sidecar `readFile` returns - "QUJD" decodes to bytes [65,66,67]. */
  base64 = "QUJD";

  exec = async (command: string): Promise<CmdResult> => {
    this.runs.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  async readFile() {
    return { content: this.base64 };
  }

  async writeFile() {
    return { success: true };
  }

  async mkdir() {
    return { success: true };
  }
}

describe("archiveBrain - tar export", () => {
  it("tars /brain (keeping .git), reads bytes back, returns filename + type", async () => {
    const sandbox = new RecordingSandbox();
    const archive = await archiveBrain(
      env,
      "a",
      "tar",
      new SandboxClient(sandbox),
    );

    // The base64 sidecar round-tripped back to the raw bytes.
    expect(Array.from(archive.bytes)).toEqual([65, 66, 67]);
    expect(archive.contentType).toBe("application/gzip");
    expect(archive.filename).toMatch(/^a-brain-\d{4}-\d{2}-\d{2}\.tar\.gz$/);

    // A tar (gzip) was issued over the brain, and base64'd for the read-back.
    const build = sandbox.runs.find((c) => c.includes("tar"));
    expect(build).toBeDefined();
    expect(build).toContain("-czf");
    expect(build).toContain("brain");
    expect(build).toContain("base64 -w0");
    // .git is INCLUDED - it is never excluded (history travels with the archive).
    expect(build).not.toContain("exclude='.git'");
    // Transient scratch IS excluded.
    expect(build).toContain("--exclude='.mnemosyne-warm'");
  });
});

describe("archiveBrain - zip export", () => {
  it("uses zip and returns a .zip filename + zip content type", async () => {
    const sandbox = new RecordingSandbox();
    const archive = await archiveBrain(
      env,
      "a",
      "zip",
      new SandboxClient(sandbox),
    );

    expect(archive.contentType).toBe("application/zip");
    expect(archive.filename).toMatch(/^a-brain-\d{4}-\d{2}-\d{2}\.zip$/);

    const build = sandbox.runs.find((c) => c.includes("zip -r"));
    expect(build).toBeDefined();
    expect(build).toContain("base64 -w0");
  });
});

describe("archiveBrain - unknown format", () => {
  it("rejects an unsupported format before touching the sandbox", async () => {
    const sandbox = new RecordingSandbox();
    await expect(
      archiveBrain(
        env,
        "a",
        "rar" as unknown as ArchiveFormat,
        new SandboxClient(sandbox),
      ),
    ).rejects.toThrow(/unsupported archive format/);
    expect(sandbox.runs.length).toBe(0);
  });
});
