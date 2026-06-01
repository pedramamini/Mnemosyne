/**
 * Messaging enable / status / disable API + org-level A2P onboarding (MNEMO-47,
 * PRD §9.1).
 *
 * PER-AGENT (under `/agents/:agentId/messaging`, `requireAuth` + {@link assertOwnsAgent}):
 *   POST   /enable   { areaCode? } → gate on 10DLC readiness, then provision a number
 *   GET    /status                  → { enabled, e164, a2p:{ brand, campaign } }
 *   POST   /disable                 → release the number at Twilio + drop the row
 *
 * ORG-LEVEL (under `/api/a2p`, `requireAuth` - see the admin-guard note below):
 *   GET  /status   → the shared brand/campaign state
 *   POST /onboard  → ensureBrand + ensureCampaign (idempotent)
 *
 * The brand + campaign are SHARED org-level resources - one covers many agent
 * numbers (§9.2) - so onboarding is a platform-operator action, NOT a per-tenant
 * one. Enabling is per-agent opt-in and gated on 10DLC readiness: provisioning an
 * unregistered number gets it throttled/blocked (§9.1), so if the shared
 * brand/campaign are not yet submitted the enable returns 409 rather than handing
 * the agent a number that won't deliver.
 */
import { Hono } from "hono";
import { z } from "zod";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";
import { getAgentNumber } from "../db/index.ts";
import {
  ensureBrand,
  ensureCampaign,
  getA2pStatus,
  isA2pReady,
} from "./a2p.ts";
import { provisionAgentNumber, releaseAgentNumber } from "./provisioning.ts";

/** A US area code (3 digits), optional - omitted ⇒ any in-country number. */
const EnableBody = z.object({
  areaCode: z
    .string()
    .trim()
    .regex(/^\d{3}$/, "areaCode must be 3 digits")
    .optional(),
});

export function messagingManageRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/agents/:agentId/messaging/enable", requireAuth());
  app.use("/agents/:agentId/messaging/status", requireAuth());
  app.use("/agents/:agentId/messaging/disable", requireAuth());
  app.use("/api/a2p/*", requireAuth());

  // POST /messaging/enable - per-agent opt-in (§9.1). Gate on shared 10DLC
  // readiness, then provision a dedicated number.
  app.post("/agents/:agentId/messaging/enable", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = EnableBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }

    // 10DLC gate: both the shared brand AND campaign must be at least submitted,
    // else a provisioned number is throttled/blocked by carriers (§9.1). Return
    // the current A2P state so the caller can show onboarding progress.
    const a2p = await getA2pStatus(c.env);
    if (!isA2pReady(a2p)) {
      return c.json({ error: "10DLC onboarding incomplete", a2p }, 409);
    }

    // Idempotent: an already-enabled agent returns its existing number.
    const existing = await getAgentNumber(c.env, agentId);
    if (existing) {
      return c.json({ e164: existing.e164, alreadyEnabled: true });
    }

    // MNEMO-49: the paid-add-on billing/entitlement check belongs HERE, at the
    // spend boundary (each number is ~$1.15/mo + usage, §9.2) - guard before
    // provisioning once billing lands.
    const result = await provisionAgentNumber(c.env, {
      agentId,
      areaCode: parsed.data.areaCode,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, (result.status ?? 502) as 502);
    }
    return c.json({ e164: result.e164 });
  });

  // GET /messaging/status - is messaging enabled for this agent + the A2P state.
  app.get("/agents/:agentId/messaging/status", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const number = await getAgentNumber(c.env, agentId);
    const a2p = await getA2pStatus(c.env);
    return c.json({
      enabled: number !== null,
      e164: number?.e164 ?? null,
      a2p,
    });
  });

  // POST /messaging/disable - release the number at Twilio + drop the registry row.
  app.post("/agents/:agentId/messaging/disable", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const result = await releaseAgentNumber(c.env, agentId);
    return c.json(result);
  });

  // ─── Org-level A2P 10DLC onboarding (shared brand/campaign) ──────────────────
  // ADMIN-GUARD EXTENSION POINT: these touch SHARED org resources, so they should
  // be restricted to platform admins. There is no admin/role model yet, so for now
  // they require a logged-in account (requireAuth above) - the platform-admin role
  // check lands with the billing/admin work (MNEMO-49). The operations are
  // idempotent, which bounds the blast radius until then.

  // GET /api/a2p/status - the shared brand/campaign registration state.
  app.get("/api/a2p/status", async (c) => {
    return c.json(await getA2pStatus(c.env));
  });

  // POST /api/a2p/onboard - submit (or advance) the shared brand + campaign.
  app.post("/api/a2p/onboard", async (c) => {
    const brand = await ensureBrand(c.env);
    const campaign = await ensureCampaign(c.env);
    return c.json({ brand, campaign });
  });

  return app;
}
