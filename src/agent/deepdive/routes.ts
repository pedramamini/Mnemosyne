/**
 * Deep-dive HTTP surface (initial onboarding progress).
 *
 * Mounted at `/agents/:agentId/deepdive`, behind `requireAuth` + the shared
 * {@link assertOwnsAgent} guard (404-not-403, the same no-existence-leak
 * convention as the discovery / build / audit routes). Read-only: the dive is
 * kicked off by Build and advances on its own (alarm-driven), so the UI just
 * polls this for progress while it runs.
 *
 *   GET /deepdive → getDeepDiveStatus() → the current DeepDiveStatus
 */
import { Hono } from "hono";
import { assertOwnsAgent } from "../../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../../auth/middleware.ts";
import { getAgentStub } from "../index.ts";

export function deepDiveRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers this; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/deepdive", requireAuth());

  // GET /deepdive - read the current deep-dive state (phase / per-phase progress).
  app.get("/agents/:agentId/deepdive", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const status = await getAgentStub(c.env, agentId).getDeepDiveStatus();
    return c.json(status);
  });

  return app;
}
