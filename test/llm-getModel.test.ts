import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAccount, upsertLlmProfile } from "../src/db/index.ts";
import type { Env } from "../src/env.ts";
import { getModel } from "../src/llm/getModel.ts";
import { encryptKey } from "../src/llm/secrets.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/llm/types.ts";

// Stub the AI binding so construction never touches a remote model - getModel
// only CONSTRUCTS the client (no inference), but we inject a stub to make that
// guarantee explicit and keep the tests offline. DB stays the real test D1.
const AI_STUB = {
  run: async () => {
    throw new Error("inference must not be invoked in tests");
  },
} as unknown as Ai;

function testEnv(): Env {
  return { ...env, AI: AI_STUB } as unknown as Env;
}

async function freshAccountId(): Promise<string> {
  const account = await createAccount(env, {
    email: `llm-${crypto.randomUUID()}@example.com`,
  });
  return account.id;
}

describe("getModel - per-user resolver", () => {
  it("resolves the free Workers AI default when the account has no profile", async () => {
    const accountId = await freshAccountId();
    const { config } = await getModel(testEnv(), accountId);
    expect(config).toEqual({
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_MODEL,
    });
  });

  it("resolves a BYOK openrouter profile to its provider + chosen model", async () => {
    const accountId = await freshAccountId();
    // key_ref is now real AES-GCM ciphertext (MNEMO-14 custody), not a placeholder.
    await upsertLlmProfile(env, accountId, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      keyRef: await encryptKey(env, "sk-or-test-key"),
    });
    const { config, model } = await getModel(testEnv(), accountId);
    expect(config.provider).toBe("openrouter");
    expect(config.model).toBe("anthropic/claude-sonnet-4.5");
    // A LanguageModel client was actually constructed.
    expect(model).toBeTruthy();
  });

  it("falls back to the Workers AI default for an unknown provider value (no throw)", async () => {
    const accountId = await freshAccountId();
    // Bypass ByokConfig - write a hand-edited/legacy provider straight to D1.
    await upsertLlmProfile(env, accountId, {
      provider: "totally-unknown-provider",
      model: "some/model",
      keyRef: null,
    });
    const { config } = await getModel(testEnv(), accountId);
    expect(config).toEqual({
      provider: "workers-ai",
      model: DEFAULT_WORKERS_AI_MODEL,
    });
  });

  it("never includes a raw key in the returned config", async () => {
    const accountId = await freshAccountId();
    await upsertLlmProfile(env, accountId, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      keyRef: await encryptKey(env, "sk-ant-test-key"),
    });
    const { config } = await getModel(testEnv(), accountId);
    // config is provider + model only - no secret surface.
    expect(Object.keys(config).sort()).toEqual(["model", "provider"]);
    const bag = config as unknown as Record<string, unknown>;
    expect(bag.key).toBeUndefined();
    expect(bag.key_ref).toBeUndefined();
  });
});
