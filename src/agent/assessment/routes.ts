/**
 * Self-assessment HTTP surface (the weekly "Karpathy loop" history).
 *
 * Mounted at `/agents/:agentId/assessment`, behind `requireAuth` + the shared
 * {@link assertOwnsAgent} guard (404-not-403, the same no-existence-leak
 * convention as the discovery / build / deepdive routes). Read-only: the loop is
 * armed when the deep dive completes and re-chains itself weekly, so the UI just
 * reads the rolling history here.
 *
 *   GET /assessment → getAssessmentState() → the current AssessmentState
 */
import { Hono } from "hono";
import { assertOwnsAgent } from "../../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../../auth/middleware.ts";
import { getAgentStub } from "../index.ts";

export function assessmentRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers this; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/assessment", requireAuth());

  // GET /assessment - read the rolling self-assessment history (newest first).
  app.get("/agents/:agentId/assessment", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const state = await getAgentStub(c.env, agentId).getAssessmentState();
    return c.json(state);
  });

  return app;
}
