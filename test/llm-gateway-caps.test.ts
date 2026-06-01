import { env } from "cloudflare:workers";
import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import {
  addSpend,
  createAccount,
  getSpend,
  setSpendCap,
  upsertLlmProfile,
} from "../src/db/index.ts";
import type { Env } from "../src/env.ts";
import {
  assertUnderCap,
  gatewayBaseUrl,
  SpendCapError,
} from "../src/llm/gateway.ts";
import { getModel } from "../src/llm/getModel.ts";
import { currentPeriod, recordUsage } from "../src/llm/recordUsage.ts";
import { encryptKey } from "../src/llm/secrets.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/llm/types.ts";

// getModel only CONSTRUCTS the client - inject a throwing AI stub to keep the
// guarantee that inference is never invoked in tests.
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
    email: `caps-${crypto.randomUUID()}@example.com`,
  });
  return account.id;
}

/** Minimal usage payload - recordUsage reads only input/output tokens. */
function usage(inputTokens: number, outputTokens: number): LanguageModelUsage {
  return { inputTokens, outputTokens } as unknown as LanguageModelUsage;
}

describe("AI Gateway URL builder", () => {
  it("builds a Gateway URL when AI_GATEWAY_ACCOUNT_ID is set", () => {
    const gwEnv = {
      ...env,
      AI_GATEWAY_ACCOUNT_ID: "acct-abc123",
      AI_GATEWAY_NAME: "mnemosyne",
    } as unknown as Env;
    expect(gatewayBaseUrl(gwEnv, "openrouter")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-abc123/mnemosyne/openrouter",
    );
    expect(gatewayBaseUrl(gwEnv, "anthropic")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct-abc123/mnemosyne/anthropic",
    );
  });

  it("returns null (direct) when AI_GATEWAY_ACCOUNT_ID is unset", () => {
    const directEnv = { ...env, AI_GATEWAY_ACCOUNT_ID: "" } as unknown as Env;
    expect(gatewayBaseUrl(directEnv, "openai")).toBeNull();
  });
});

describe("spend cap enforcement", () => {
  it("passes under the cap and throws SpendCapError once spend exceeds it", async () => {
    const accountId = await freshAccountId();
    // Fresh account: zero spend, default cap → under cap, no throw.
    await expect(assertUnderCap(env, accountId)).resolves.toBeUndefined();

    // Pin a low cap, then push recorded spend past it.
    await setSpendCap(env, accountId, 100);
    await addSpend(env, accountId, currentPeriod(), {
      tokensIn: 0,
      tokensOut: 0,
      costUsdMilli: 250,
    });
    await expect(assertUnderCap(env, accountId)).rejects.toBeInstanceOf(
      SpendCapError,
    );
  });
});

describe("recordUsage accounting", () => {
  it("accumulates tokens + cost into llm_spend for the current period", async () => {
    const accountId = await freshAccountId();
    const config = { provider: "anthropic", model: "claude-sonnet-4-5" };

    await recordUsage(env, accountId, usage(1000, 500), config);
    await recordUsage(env, accountId, usage(1000, 500), config);

    const spend = await getSpend(env, accountId, currentPeriod());
    expect(spend.tokens_in).toBe(2000);
    expect(spend.tokens_out).toBe(1000);
    // anthropic:claude-sonnet-4-5 = 3000/Mtok in, 15000/Mtok out →
    // per call ceil((1000*3000 + 500*15000)/1e6) = 11 milli-USD; ×2 = 22.
    expect(spend.cost_usd_milli).toBe(22);
  });
});

describe("getModel - cap fallback", () => {
  it("downgrades an over-cap BYOK profile to Workers AI with cappedFallback and no key", async () => {
    const accountId = await freshAccountId();
    await upsertLlmProfile(env, accountId, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      keyRef: await encryptKey(env, "sk-or-secret-cap-test"),
    });
    await setSpendCap(env, accountId, 100);
    await addSpend(env, accountId, currentPeriod(), {
      tokensIn: 0,
      tokensOut: 0,
      costUsdMilli: 500,
    });

    const { config } = await getModel(testEnv(), accountId);
    expect(config.provider).toBe("workers-ai");
    expect(config.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(config.cappedFallback).toBe(true);
    // The secret-free guarantee holds even on the fallback path.
    expect(JSON.stringify(config)).not.toContain("sk-or-secret-cap-test");
    const bag = config as unknown as Record<string, unknown>;
    expect(bag.key).toBeUndefined();
    expect(bag.key_ref).toBeUndefined();
  });

  it("resolves a BYOK profile normally when under the cap (no cappedFallback)", async () => {
    const accountId = await freshAccountId();
    await upsertLlmProfile(env, accountId, {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      keyRef: await encryptKey(env, "sk-or-secret-under-cap"),
    });
    const { config } = await getModel(testEnv(), accountId);
    expect(config.provider).toBe("openrouter");
    expect(config.cappedFallback).toBeUndefined();
  });
});
