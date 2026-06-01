import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SandboxClient, type SandboxLike } from "../src/sandbox/client.ts";
import { ensureWarm } from "../src/sandbox/lifecycle.ts";
import {
  persistToR2,
  restoreFromR2,
  snapshotKey,
} from "../src/sandbox/persistence.ts";

// SDK is Beta (PRD §8.1) - verified against the real container in the manual
// checkpoint. Here `BRAIN_BUCKET` is a real (miniflare) R2 binding from
// wrangler.toml, and the sandbox is an injected recording `SandboxLike` mock, so
// we assert the R2 key shape + the persist/restore wiring without a container.

/** Records every wrapper call and lets a test pin the probe/readFile output. */
class RecordingSandbox implements SandboxLike {
  readonly runs: string[] = [];
  readonly reads: string[] = [];
  readonly writes: Array<{ path: string; content: string }> = [];
  /** stdout returned by the command runner - drives the cold/warm probe. */
  execStdout = "";
  /** content returned by `readFile` - the base64 archive sidecar in persist. */
  fileContent = "";

  async exec(command: string) {
    this.runs.push(command);
    return { stdout: this.execStdout, stderr: "", exitCode: 0 };
  }

  async readFile(path: string) {
    this.reads.push(path);
    return { content: this.fileContent };
  }

  async writeFile(path: string, content: string) {
    this.writes.push({ path, content });
    return { success: true };
  }

  async mkdir(_path: string, _options?: { recursive?: boolean }) {
    return { success: true };
  }
}

describe("sandbox persistence - R2 archive round-trip", () => {
  it("persistToR2 puts the base64 archive under brains/<agentId>/snapshot.tar", async () => {
    const agentId = `persist-${crypto.randomUUID()}`;
    const fake = new RecordingSandbox();
    fake.fileContent = "QkFTRTY0LWFyY2hpdmU="; // stand-in base64 archive

    const stored = await persistToR2(env, agentId, new SandboxClient(fake));
    expect(stored).toBe(true);

    // Key shape comes from snapshotKey (the rolling "latest" key).
    expect(snapshotKey(agentId)).toBe(`brains/${agentId}/snapshot.tar`);
    const object = await env.BRAIN_BUCKET.get(snapshotKey(agentId));
    expect(object).not.toBeNull();
    expect(await object?.text()).toBe(fake.fileContent);

    // It archived then read the sidecar (one tar pass + one readFile).
    expect(fake.runs.some((c) => c.includes("tar -C /brain"))).toBe(true);
    expect(fake.reads.length).toBe(1);
  });

  it("restoreFromR2 reads the object back and feeds it into the sandbox", async () => {
    const agentId = `restore-${crypto.randomUUID()}`;
    await env.BRAIN_BUCKET.put(snapshotKey(agentId), "QkFTRTY0LXJlc3RvcmU=");

    const fake = new RecordingSandbox();
    const restored = await restoreFromR2(env, agentId, new SandboxClient(fake));
    expect(restored).toBe(true);

    // The base64 was written into the container, then unpacked via tar.
    expect(fake.writes.some((w) => w.path.endsWith(".b64"))).toBe(true);
    expect(fake.runs.some((c) => c.includes("tar -C /brain -xzf"))).toBe(true);
  });

  it("restoreFromR2 returns false when no snapshot exists (first-ever wake)", async () => {
    const agentId = `none-${crypto.randomUUID()}`;
    const fake = new RecordingSandbox();
    const restored = await restoreFromR2(env, agentId, new SandboxClient(fake));
    expect(restored).toBe(false);
    expect(fake.writes.length).toBe(0);
  });
});

describe("sandbox lifecycle - ensureWarm restores only on a cold start", () => {
  it("cold container: probes cold, restores from R2", async () => {
    const agentId = `warm-cold-${crypto.randomUUID()}`;
    await env.BRAIN_BUCKET.put(snapshotKey(agentId), "QkFTRTY0LWNvbGQ=");

    const fake = new RecordingSandbox();
    fake.execStdout = "cold"; // marker absent

    const { coldStart } = await ensureWarm(
      env,
      agentId,
      new SandboxClient(fake),
    );
    expect(coldStart).toBe(true);
    // Restore ran → the base64 sidecar was written into the container.
    expect(fake.writes.some((w) => w.path.endsWith(".b64"))).toBe(true);
  });

  it("warm container: probes warm, skips restore", async () => {
    const agentId = `warm-warm-${crypto.randomUUID()}`;
    await env.BRAIN_BUCKET.put(snapshotKey(agentId), "QkFTRTY0LXdhcm0=");

    const fake = new RecordingSandbox();
    fake.execStdout = "warm"; // marker present

    const { coldStart } = await ensureWarm(
      env,
      agentId,
      new SandboxClient(fake),
    );
    expect(coldStart).toBe(false);
    // Restore skipped → nothing written into the container.
    expect(fake.writes.length).toBe(0);
  });

  it("cold-boot race: retries the probe past transient transport faults", async () => {
    const agentId = `warm-race-${crypto.randomUUID()}`;
    await env.BRAIN_BUCKET.put(snapshotKey(agentId), "QkFTRTY0LXJhY2U=");

    // The first two probes throw the SDK's cold-boot fault (the container isn't
    // listening yet), then it answers "warm" - ensureWarm must NOT surface a 500.
    const fake = new RecordingSandbox();
    fake.execStdout = "warm";
    let probeCalls = 0;
    const realExec = fake.exec.bind(fake);
    fake.exec = async (command: string) => {
      probeCalls += 1;
      if (probeCalls <= 2) throw new Error("Network connection lost.");
      return realExec(command);
    };

    const { coldStart } = await ensureWarm(
      env,
      agentId,
      new SandboxClient(fake),
    );
    expect(coldStart).toBe(false);
    expect(probeCalls).toBeGreaterThanOrEqual(3); // two faults + the success
  });

  it("cold-boot retry gives up on a non-transient probe error", async () => {
    const agentId = `warm-hardfail-${crypto.randomUUID()}`;
    const fake = new RecordingSandbox();
    fake.exec = async () => {
      throw new Error("command not found: bananas");
    };

    await expect(
      ensureWarm(env, agentId, new SandboxClient(fake)),
    ).rejects.toThrow(/bananas/);
  });
});
