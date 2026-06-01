import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { decryptKey, encryptKey } from "../src/llm/secrets.ts";

// secrets.ts touches only env.KEY_ENCRYPTION_SECRET - a partial env is enough.
const SECRET = "fixed-master-secret-for-tests";
const fixedEnv = { KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env;

const SAMPLE_KEY = "sk-or-v1-supersecret-byok-key-0123456789";

describe("BYOK secret custody (AES-GCM)", () => {
  it("round-trips a key through encrypt → decrypt under a fixed secret", async () => {
    const stored = await encryptKey(fixedEnv, SAMPLE_KEY);
    const recovered = await decryptKey(fixedEnv, stored);
    expect(recovered).toBe(SAMPLE_KEY);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const a = await encryptKey(fixedEnv, SAMPLE_KEY);
    const b = await encryptKey(fixedEnv, SAMPLE_KEY);
    expect(a).not.toBe(b);
    // …but both still decrypt back to the same plaintext.
    expect(await decryptKey(fixedEnv, a)).toBe(SAMPLE_KEY);
    expect(await decryptKey(fixedEnv, b)).toBe(SAMPLE_KEY);
  });

  it("never stores the plaintext key in the ciphertext", async () => {
    const stored = await encryptKey(fixedEnv, SAMPLE_KEY);
    expect(stored).not.toContain(SAMPLE_KEY);
    // No meaningful sub-slice of the key leaks either.
    expect(stored).not.toContain("supersecret");
  });

  it("fails to decrypt under a different secret (auth-tag mismatch)", async () => {
    const stored = await encryptKey(fixedEnv, SAMPLE_KEY);
    const wrongEnv = {
      KEY_ENCRYPTION_SECRET: "a-different-secret",
    } as unknown as Env;
    await expect(decryptKey(wrongEnv, stored)).rejects.toBeTruthy();
  });
});
