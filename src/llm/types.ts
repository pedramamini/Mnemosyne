/**
 * Shared types + constants for the per-user LLM model resolver (MNEMO-13).
 *
 * The resolver (`getModel.ts`) speaks only the `ai` SDK's `LanguageModel`
 * interface, so the provider set below is the one place that enumerates which
 * backends we know how to construct. Workers AI is the zero-secret free default
 * (PRD §7.2); the rest are per-user BYOK.
 */
import { z } from "zod";

/** Closed set of LLM backends the resolver can construct. */
export type LlmProvider = "workers-ai" | "openrouter" | "anthropic" | "openai";

/** Runtime guard mirroring {@link LlmProvider} - used to validate persisted /
 * user-submitted provider strings before the resolver switches on them. */
export const LLM_PROVIDERS = [
  "workers-ai",
  "openrouter",
  "anthropic",
  "openai",
] as const satisfies readonly LlmProvider[];

/** Narrow an arbitrary string to a known {@link LlmProvider}. */
export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Validates user-submitted BYOK input. A `key` is required for the three BYOK
 * providers; resetting to the free default uses the separate `workers-ai`
 * branch in the route (where `key`/`model` are ignored), so this schema only
 * describes a real key-bearing provider config.
 */
export const ByokConfig = z.object({
  provider: z.enum(["openrouter", "anthropic", "openai"]),
  model: z.string().min(1, "model is required"),
  key: z.string().min(1, "key is required"),
});
export type ByokConfig = z.infer<typeof ByokConfig>;

/**
 * What the resolver DECIDED - provider + model only, never a secret. Callers
 * log this to the audit stream; it is safe to surface to a client.
 *
 * `cappedFallback` is set ONLY when a BYOK request was downgraded to the free
 * Workers AI default because the account hit its spend cap (MNEMO-14), so callers
 * can audit-log the downgrade. `tierGated` is set when a BYOK profile was ignored
 * because the account's subscription tier doesn't include BYOK (MNEMO-49). Both
 * are absent on every normal resolution.
 */
export interface ResolvedModelConfig {
  provider: LlmProvider;
  model: string;
  cappedFallback?: boolean;
  tierGated?: boolean;
}

/**
 * Free default model: Workers AI Qwen3-30B (reasoning). Zero secrets, zero egress
 * (PRD §7.2). Gives coherent CHAT answers out of the box.
 *
 * ⚠️ KNOWN CEILING (staging QA 2026-05-25): free Workers AI models can't drive the
 * full agent tool loop, so they answer from training data rather than actually
 * searching/recalling. Two compounding causes, both verified live:
 *   1. STREAMING drops tool calls - under `streamText`, the model emits the call
 *      as plain text (`{"type":"function",...}`) and it never executes. The
 *      interactive turn now uses `generateText` instead (see MnemosyneAgent
 *      `runConversationTurn`), which executes tools correctly in isolation
 *      (`/__dev/tooltest` shows `executedTool: true`).
 *   2. TOOL-CATALOG complexity - even non-streaming, the full multi-tool schema
 *      set defeats the free models: qwen3 ignores the tools; llama-3.3-70b refuses
 *      ("function definitions are not comprehensive enough"). A single simple tool
 *      works; the whole catalog does not.
 * The tool WIRING is correct (mock-model integration tests pass; the `/__dev/search`
 * probe returns real DuckDuckGo results from CF egress). The reliable fix is BYOK a
 * capable model (Claude/GPT - already supported in getModel's anthropic/openai
 * paths), which handles the full catalog and reliably calls tools.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** Free default provider - applies when an account has no BYOK profile. PRD §7.2. */
export const DEFAULT_PROVIDER: LlmProvider = "workers-ai";
