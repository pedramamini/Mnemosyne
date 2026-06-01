/**
 * Per-user LLM profile + spend routes (MNEMO-13/14), all behind `requireAuth`:
 *
 *   GET /api/llm-profile          - the caller's resolved provider + model +
 *                                   `hasKey`. NEVER returns the key.
 *   PUT /api/llm-profile          - set BYOK config (ByokConfig) or reset to the
 *                                   free default with `{ "provider": "workers-ai" }`.
 *   PUT /api/llm-profile/spend-cap - set/clear the per-account monthly cap
 *                                   (`{ usdMilli: number | null }`).
 *   GET /api/llm-spend            - the caller's current-period tokens + cost +
 *                                   effective cap. NEVER returns the key.
 *
 * Routes are thin: validate the body (Zod), call the typed CRUD helper, shape
 * the response. Resolution (which provider/model actually applies) is delegated
 * to `getModel` so GET reflects exactly what the agent loop will use.
 *
 * Secret custody (MNEMO-14): a submitted raw `key` is encrypted with `encryptKey`
 * and the CIPHERTEXT persisted as `key_ref` - the raw key never touches D1 and is
 * never returned. `hasKey` reports only that a key was stored.
 */
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, getAccountId, requireAuth } from "../auth/middleware.ts";
import {
  getLlmProfile,
  getSpend,
  getSpendCap,
  setSpendCap,
  upsertLlmProfile,
} from "../db/index.ts";
import { getModel } from "./getModel.ts";
import { currentPeriod } from "./recordUsage.ts";
import { encryptKey } from "./secrets.ts";
import { ByokConfig, DEFAULT_WORKERS_AI_MODEL } from "./types.ts";

/** Body for the spend-cap setter: a non-negative milli-USD ceiling, or null to
 * clear it (fall back to the platform default). */
const SpendCapBody = z.object({
  usdMilli: z.number().int().nonnegative().nullable(),
});

export function llmProfileRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Each exact path is gated independently (the bare-path matcher does not cover
  // sub-paths, so spend-cap and spend get their own guards).
  app.use("/api/llm-profile", requireAuth());
  app.use("/api/llm-profile/spend-cap", requireAuth());
  app.use("/api/llm-spend", requireAuth());

  app.get("/api/llm-profile", async (c) => {
    const accountId = getAccountId(c);
    // `config` is secret-free (provider + model only); the row tells us whether
    // a BYOK key was supplied without ever exposing it.
    const { config } = await getModel(c.env, accountId);
    const profile = await getLlmProfile(c.env, accountId);
    return c.json({
      provider: config.provider,
      model: config.model,
      hasKey: Boolean(profile?.key_ref),
    });
  });

  app.put("/api/llm-profile", async (c) => {
    const accountId = getAccountId(c);
    const body = (await c.req.json().catch(() => null)) as unknown;

    // Reset to the free default - `key`/`model` are ignored for workers-ai.
    if (
      body &&
      typeof body === "object" &&
      (body as { provider?: unknown }).provider === "workers-ai"
    ) {
      await upsertLlmProfile(c.env, accountId, {
        provider: "workers-ai",
        model: null,
        keyRef: null,
      });
      return c.json({
        provider: "workers-ai",
        model: DEFAULT_WORKERS_AI_MODEL,
        hasKey: false,
      });
    }

    const parsed = ByokConfig.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    // Custody: encrypt the raw key and persist the CIPHERTEXT as key_ref. The
    // plaintext key never reaches D1 and is never echoed back.
    const keyRef = await encryptKey(c.env, parsed.data.key);
    await upsertLlmProfile(c.env, accountId, {
      provider: parsed.data.provider,
      model: parsed.data.model,
      keyRef,
    });
    return c.json({
      provider: parsed.data.provider,
      model: parsed.data.model,
      hasKey: true,
    });
  });

  app.put("/api/llm-profile/spend-cap", async (c) => {
    const accountId = getAccountId(c);
    const parsed = SpendCapBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    await setSpendCap(c.env, accountId, parsed.data.usdMilli);
    return c.json({ spendCapUsdMilli: parsed.data.usdMilli });
  });

  app.get("/api/llm-spend", async (c) => {
    const accountId = getAccountId(c);
    const period = currentPeriod();
    const spend = await getSpend(c.env, accountId, period);
    const capUsdMilli = await getSpendCap(c.env, accountId);
    return c.json({
      period,
      tokensIn: spend.tokens_in,
      tokensOut: spend.tokens_out,
      costUsdMilli: spend.cost_usd_milli,
      capUsdMilli,
    });
  });

  return app;
}
