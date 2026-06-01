/**
 * Discovery HTTP surface (MNEMO-29, PRD §5/§6.3).
 *
 * Mounted at `/agents/:agentId/discovery`, every route behind `requireAuth`
 * (MNEMO-03) plus the shared {@link assertOwnsAgent} guard (404-not-403 for a
 * non-owned id - the same no-existence-leak convention as the audit/report/brain
 * routes). The DO is invoked over native Workers RPC on the stub - the same
 * invocation style MNEMO-04 established for `getSettings` (the Discovery
 * methods return plain serializable state, so no `fetch` switch is needed).
 *
 *   POST /start    { name, description }  → startDiscovery   → initial state
 *   POST /message  { message }            → discoveryTurn    → { reply, state }
 *   GET  /                                → getDiscoveryState → state
 */
import { Hono } from "hono";
import { z } from "zod";
import { byAccount, rateLimitMiddleware } from "../../abuse/rateLimit.ts";
import { assertOwnsAgent } from "../../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../../auth/middleware.ts";
import { getAgentStub } from "../index.ts";

/** Boundary caps - the DO trims/validates further; these fail bad input loud. */
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_MESSAGE_CHARS = 8000;

/** POST /start body - the agent name + the user's short description. */
const StartBody = z.object({
  name: z.string().trim().min(1, "name is required").max(MAX_NAME_CHARS),
  description: z
    .string()
    .trim()
    .min(1, "description is required")
    .max(MAX_DESCRIPTION_CHARS),
});

/** POST /message body - one clarify-scope user turn. */
const MessageBody = z.object({
  message: z
    .string()
    .trim()
    .min(1, "message is required")
    .max(MAX_MESSAGE_CHARS),
});

export function discoveryRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent). Both the `/discovery`
  // exact path and the `/discovery/*` children need covering.
  app.use("/agents/:agentId/discovery", requireAuth());
  app.use("/agents/:agentId/discovery/*", requireAuth());

  // MNEMO-50: per-account limit on starting Discovery (an expensive research entry
  // point). After requireAuth so byAccount can read the account id; throws
  // RateLimited → 429 + Retry-After when exceeded.
  app.use(
    "/agents/:agentId/discovery/start",
    rateLimitMiddleware("research_start", byAccount),
  );

  // POST /start - initialize Discovery for the agent. Returns the initial state.
  app.post("/agents/:agentId/discovery/start", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = StartBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const state = await getAgentStub(c.env, agentId).startDiscovery(
      parsed.data,
    );
    return c.json(state);
  });

  // POST /message - one clarify-scope turn. Returns the assistant reply + state.
  app.post("/agents/:agentId/discovery/message", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const result = await getAgentStub(c.env, agentId).discoveryTurn(
      parsed.data.message,
    );
    return c.json(result);
  });

  // GET / - read the current Discovery state (status / spec / turns).
  app.get("/agents/:agentId/discovery", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const state = await getAgentStub(c.env, agentId).getDiscoveryState();
    return c.json(state);
  });

  return app;
}
