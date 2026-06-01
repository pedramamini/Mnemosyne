/**
 * `getModel(env, accountId)` - the single, model-agnostic resolver.
 *
 * Returns a Vercel-`ai`-compatible `LanguageModel` chosen PER-USER from their
 * `llm_profiles` row, plus a secret-free `ResolvedModelConfig` describing the
 * decision (callers log `config` to the audit stream, never a key). Mirrors
 * Crema's `llm.ts` (docs/crema-architecture-reference.md §4) but resolves
 * per-user instead of from global env.
 *
 * Resolution order:
 *   - no profile / provider unknown / provider === "workers-ai"  → free default
 *     (`DEFAULT_WORKERS_AI_MODEL` via the AI binding; zero secret, PRD §7.2).
 *   - openrouter | anthropic | openai → that provider's `ai`-SDK client, routed
 *     through the AI Gateway when configured and carrying the per-user
 *     attribution header.
 * Any provider-construction failure (a BYOK row with no model/key, or a key that
 * fails to decrypt) degrades to the Workers AI default rather than throwing - the
 * resolver never blocks the agent loop on a bad profile.
 *
 * MNEMO-14 wired three things into the BYOK path: (1) a pre-flight spend-cap gate
 * (`assertUnderCap`); (2) real secret custody - the stored `key_ref` is decrypted
 * in-process here, immediately before constructing the provider, never logged or
 * returned; (3) AI Gateway routing via `baseURL` + attribution headers. Hitting
 * the cap degrades to the free default flagged `cappedFallback: true`.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getLlmProfile } from "../db/index.ts";
import type { Env } from "../env.ts";
import {
  assertUnderCap,
  DIRECT_BASE_URL,
  gatewayBaseUrl,
  gatewayHeaders,
  SpendCapError,
} from "./gateway.ts";
import { decryptKey } from "./secrets.ts";
import {
  DEFAULT_PROVIDER,
  DEFAULT_WORKERS_AI_MODEL,
  isLlmProvider,
  type LlmProvider,
  type ResolvedModelConfig,
} from "./types.ts";

export interface ResolvedModel {
  model: LanguageModel;
  config: ResolvedModelConfig;
}

/** The zero-secret free default: Workers AI Qwen3-30B via the `AI` binding.
 * `extra` lets the cap-fallback path tag the config (`cappedFallback: true`)
 * without changing the model. */
function workersAiDefault(
  env: Env,
  extra?: Partial<ResolvedModelConfig>,
): ResolvedModel {
  const workersai = createWorkersAI({ binding: env.AI });
  return {
    model: workersai(DEFAULT_WORKERS_AI_MODEL),
    config: {
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_WORKERS_AI_MODEL,
      ...extra,
    },
  };
}

/**
 * Construct a BYOK provider: decrypt the stored key in-process, point the SDK at
 * the AI Gateway (or the direct base URL when no gateway is configured), and
 * attach the per-user attribution headers. The key lives only as a local here -
 * it never enters `config` and is never logged. Returns null on any failure
 * (bad ciphertext, construction error) so the caller can degrade.
 */
async function buildByok(
  env: Env,
  accountId: string,
  provider: Exclude<LlmProvider, "workers-ai">,
  model: string,
  keyRef: string,
): Promise<ResolvedModel | null> {
  try {
    const apiKey = await decryptKey(env, keyRef);
    const headers = gatewayHeaders(accountId);
    const baseURL = gatewayBaseUrl(env, provider) ?? DIRECT_BASE_URL[provider];
    switch (provider) {
      case "openrouter": {
        const openrouter = createOpenRouter({ apiKey, baseURL, headers });
        return { model: openrouter.chat(model), config: { provider, model } };
      }
      case "anthropic": {
        const anthropic = createAnthropic({ apiKey, baseURL, headers });
        return { model: anthropic(model), config: { provider, model } };
      }
      case "openai": {
        const openai = createOpenAI({ apiKey, baseURL, headers });
        return { model: openai(model), config: { provider, model } };
      }
    }
  } catch {
    return null;
  }
}

export async function getModel(
  env: Env,
  accountId: string,
  opts?: { forceFree?: boolean },
): Promise<ResolvedModel> {
  // MNEMO-49: BYOK is a paid-tier feature. The DO resolver checks the account's
  // tier (checkTierFeature "byok") and passes forceFree when it isn't included, so
  // a stored BYOK profile is ignored and the free default applies. Flagged
  // `tierGated` so callers can audit-log the downgrade.
  if (opts?.forceFree) return workersAiDefault(env, { tierGated: true });

  const profile = await getLlmProfile(env, accountId);

  // No profile, an unknown/legacy provider string, or an explicit reset to the
  // free default → Workers AI. (getLlmProfile reads `provider` as a plain
  // string, so the isLlmProvider guard is the safety net for hand-edited rows.)
  if (
    !profile ||
    !isLlmProvider(profile.provider) ||
    profile.provider === "workers-ai"
  ) {
    return workersAiDefault(env);
  }

  // A BYOK row with no model or no stored key is misconfigured - degrade.
  if (!profile.model || !profile.key_ref) return workersAiDefault(env);

  // Capture the narrowed BYOK fields into locals so the type survives the awaits
  // below (property narrowing can reset across calls).
  const provider: Exclude<LlmProvider, "workers-ai"> = profile.provider;
  const { model, key_ref } = profile;

  // (1) Pre-flight spend-cap gate - BYOK only. The Workers AI default is
  // platform-billed and capped by the Neuron budget, not here. Over the cap, we
  // degrade to the free default flagged so callers can audit-log the downgrade.
  try {
    await assertUnderCap(env, accountId);
  } catch (err) {
    if (err instanceof SpendCapError) {
      return workersAiDefault(env, { cappedFallback: true });
    }
    throw err;
  }

  // (2)+(3) Decrypt the key in-process and construct the gateway-routed provider.
  const byok = await buildByok(env, accountId, provider, model, key_ref);
  return byok ?? workersAiDefault(env);
}
