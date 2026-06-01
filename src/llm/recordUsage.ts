/**
 * `recordUsage` - turn an `ai`-SDK usage report into a milli-USD cost and
 * accumulate it into `llm_spend` for the current billing window (MNEMO-14).
 *
 * Called by the agent loop (MNEMO-15) AFTER each turn; this phase provides and
 * unit-tests it. Cost is derived from a small per-model price table keyed by
 * `provider:model`, with a deliberately conservative default so an UNKNOWN model
 * never under-accounts against a user's spend cap. All money is integer
 * milli-USD ($0.001 units) to keep accounting exact.
 *
 * Note: the installed `ai` v6 `LanguageModelUsage` carries `inputTokens` /
 * `outputTokens` (the MNEMO-14 spec's `promptTokens`/`completionTokens` was the
 * older v4 naming) - we read the real fields and coalesce `undefined` to 0.
 */
import type { LanguageModelUsage } from "ai";
import { addSpend, type SpendDelta } from "../db/index.ts";
import type { Env } from "../env.ts";

/** The current billing window as `YYYY-MM` (UTC). Shared with `assertUnderCap`. */
export function currentPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Price for a model, in milli-USD per 1,000,000 tokens (in / out separately). */
interface ModelPrice {
  inMilliPerMTok: number;
  outMilliPerMTok: number;
}

/**
 * Per-model prices keyed `provider:model` (milli-USD / 1M tokens). Small on
 * purpose - extend as BYOK models are exercised. Public list prices, May 2026.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "anthropic:claude-sonnet-4-5": {
    inMilliPerMTok: 3_000,
    outMilliPerMTok: 15_000,
  },
  "openai:gpt-4o": { inMilliPerMTok: 2_500, outMilliPerMTok: 10_000 },
  "openrouter:anthropic/claude-sonnet-4.5": {
    inMilliPerMTok: 3_000,
    outMilliPerMTok: 15_000,
  },
};

/**
 * Fallback price for a model not in {@link MODEL_PRICING}. Set at the high end of
 * current frontier pricing so an unknown model OVER-accounts rather than letting
 * a user blow past their cap unnoticed.
 */
const DEFAULT_PRICING: ModelPrice = {
  inMilliPerMTok: 15_000,
  outMilliPerMTok: 75_000,
};

function priceFor(provider?: string, model?: string): ModelPrice {
  if (provider && model) {
    const hit = MODEL_PRICING[`${provider}:${model}`];
    if (hit) return hit;
  }
  return DEFAULT_PRICING;
}

/**
 * Accumulate one turn's usage into the account's current-period spend row.
 * `config` (the resolver's `provider`/`model`) selects the price; omit it and
 * the conservative default applies. Cost is rounded UP - never under-charge.
 */
export async function recordUsage(
  env: Env,
  accountId: string,
  usage: LanguageModelUsage,
  config?: { provider: string; model: string },
): Promise<void> {
  const tokensIn = usage.inputTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const price = priceFor(config?.provider, config?.model);
  const costUsdMilli = Math.ceil(
    (tokensIn * price.inMilliPerMTok + tokensOut * price.outMilliPerMTok) /
      1_000_000,
  );
  const delta: SpendDelta = { tokensIn, tokensOut, costUsdMilli };
  await addSpend(env, accountId, currentPeriod(), delta);
}
