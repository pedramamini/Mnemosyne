/**
 * Agent registry CRUD routes (MNEMO-05), all mounted under `/agents` behind
 * `requireAuth`:
 *
 *   POST  /agents            - create an agent for the current account → 201.
 *   GET   /agents            - list the current account's agents → 200 array.
 *   GET   /agents/:agentId    - fetch one owned agent → 200, or 404.
 *   PATCH /agents/:agentId    - patch one owned agent → 200, or 404.
 *   DELETE /agents/:agentId   - delete one owned agent (DO + R2 + D1) → 204, or 404.
 *
 * Routes are thin: validate the body (Zod), call the service, shape the
 * response. The service owns storage + DO sync. Ownership lives in the service
 * too - a non-owned id returns `null`, which we surface as 404 (not 403) so we
 * never leak the existence of another account's agent.
 */
import { Hono } from "hono";
import { type AppEnv, getAccountId, requireAuth } from "../auth/middleware.ts";
import { CreateAgentBody, UpdateAgentBody } from "./schemas.ts";
import {
  createAgentForAccount,
  deleteAgentOwned,
  getAgentOwned,
  listAgents,
  updateAgentOwned,
} from "./service.ts";

export function agentRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Gate the exact registry paths. The DO debug wildcard (`/agents/:agentId/*`,
  // wired in src/index.ts) is a separate pattern and applies its own auth.
  app.use("/agents", requireAuth());
  app.use("/agents/:agentId", requireAuth());

  app.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateAgentBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const agent = await createAgentForAccount(
      c.env,
      getAccountId(c),
      parsed.data,
    );
    return c.json(agent, 201);
  });

  app.get("/agents", async (c) => {
    const agents = await listAgents(c.env, getAccountId(c));
    return c.json(agents);
  });

  app.get("/agents/:agentId", async (c) => {
    const agent = await getAgentOwned(
      c.env,
      getAccountId(c),
      c.req.param("agentId"),
    );
    if (!agent) return c.json({ error: "not found" }, 404);
    return c.json(agent);
  });

  app.patch("/agents/:agentId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateAgentBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const agent = await updateAgentOwned(
      c.env,
      getAccountId(c),
      c.req.param("agentId"),
      parsed.data,
    );
    if (!agent) return c.json({ error: "not found" }, 404);
    return c.json(agent);
  });

  app.delete("/agents/:agentId", async (c) => {
    const deleted = await deleteAgentOwned(
      c.env,
      getAccountId(c),
      c.req.param("agentId"),
    );
    if (!deleted) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
