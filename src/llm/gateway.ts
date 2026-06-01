/**
 * Cloudflare AI Gateway routing + per-user spend caps (MNEMO-14, PRD §7.2).
 *
 * BYOK provider calls are routed through a Gateway URL (when configured) so we
 * get response caching, request logs, and a single billing surface; per-user
 * attribution rides on the `cf-aig-metadata` header so logs/caps key on the
 * account. Spend caps are enforced in APP LOGIC (the Gateway logs usage, it does
 * not block) - `assertUnderCap` is the pre-flight gate, `recordUsage` updates the
 * tally after each turn.
 *
 * Mirrors Crema's "gateway URL when AI_GATEWAY_ACCOUNT_ID is set, direct
 * otherwise" pattern (docs/crema-architecture-reference.md §4) and adds the
 * per-user attribution + caps Crema lacks.
 */
import { getSpend, getSpendCap } from "../db/index.ts";
import type { Env } from "../env.ts";
import { currentPeriod } from "./recordUsage.ts";
import type { LlmProvider } from "./types.ts";

/** The BYOK providers - everything except the platform Workers AI default. */
type ByokProvider = Exclude<LlmProvider, "workers-ai">;

/**
 * Gateway provider path slugs. For our three BYOK providers the slug equals the
 * provider name, but the map keeps the URL builder decoupled from the
 * {@link LlmProvider} spelling.
 */
const GATEWAY_SLUG: Record<ByokProvider, string> = {
  openrouter: "openrouter",
  anthropic: "anthropic",
  openai: "openai",
};

/**
 * Direct (no-gateway) base URLs - the SDK defaults, stated explicitly so callers
 * can write `gatewayBaseUrl(env, p) ?? DIRECT_BASE_URL[p]` and read it as
 * "gateway when configured, else direct".
 */
export const DIRECT_BASE_URL: Record<ByokProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

/** Default edge-cache window the Gateway applies via `cf-aig-cache-ttl` (seconds). */
const DEFAULT_CACHE_TTL_SECONDS = 3600;

/**
 * The Gateway base URL for a provider when `AI_GATEWAY_ACCOUNT_ID` is set, else
 * null (callers fall back to the direct base URL). Shape per PRD/Cloudflare:
 * `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}/{provider}`.
 */
export function gatewayBaseUrl(
  env: Env,
  provider: ByokProvider,
): string | null {
  const accountId = env.AI_GATEWAY_ACCOUNT_ID;
  if (!accountId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${env.AI_GATEWAY_NAME}/${GATEWAY_SLUG[provider]}`;
}

/**
 * Headers that attribute a request to an account in the Gateway and set a
 * default cache TTL. `cf-aig-metadata` is the custom-metadata channel the
 * Gateway indexes logs by, so spend reporting can key on `accountId`.
 */
export function gatewayHeaders(accountId: string): Record<string, string> {
  return {
    "cf-aig-metadata": JSON.stringify({ accountId }),
    "cf-aig-cache-ttl": String(DEFAULT_CACHE_TTL_SECONDS),
  };
}

/**
 * Thrown by {@link assertUnderCap} when an account's accumulated spend has met
 * or exceeded its cap. `getModel` catches it and degrades to the free Workers AI
 * default rather than blocking the agent.
 */
export class SpendCapError extends Error {
  readonly accountId: string;
  readonly spentUsdMilli: number;
  readonly capUsdMilli: number;

  constructor(accountId: string, spentUsdMilli: number, capUsdMilli: number) {
    super(
      `spend cap exceeded for account ${accountId}: ${spentUsdMilli} >= ${capUsdMilli} milli-USD`,
    );
    this.name = "SpendCapError";
    this.accountId = accountId;
    this.spentUsdMilli = spentUsdMilli;
    this.capUsdMilli = capUsdMilli;
  }
}

/**
 * Pre-flight gate: throw {@link SpendCapError} if the account's current-period
 * spend has reached its effective cap. Read-only (no mutation) - the post-call
 * accounting is `recordUsage`.
 */
export async function assertUnderCap(
  env: Env,
  accountId: string,
): Promise<void> {
  const period = currentPeriod();
  const [spend, cap] = await Promise.all([
    getSpend(env, accountId, period),
    getSpendCap(env, accountId),
  ]);
  if (spend.cost_usd_milli >= cap) {
    throw new SpendCapError(accountId, spend.cost_usd_milli, cap);
  }
}
