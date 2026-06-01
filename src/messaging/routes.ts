/**
 * Messaging web-rendering API (MNEMO-46, PRD §9.5) - text threads render in-app as
 * first-class conversations. Mounted at `/agents/:agentId/messaging`, every route
 * behind `requireAuth` (MNEMO-03) plus an {@link assertOwnsAgent} guard (the
 * requesting account must own the agent - 404, not 403, for a non-owned id, the
 * same no-existence-leak convention as the audit/report routes). Two reads:
 *
 *   GET /sessions                         - the conversation list (newest first),
 *                                           each with counterparty/channel/kind/day
 *                                           + message count.
 *   GET /sessions/:sessionId/messages     - one session's messages, each with
 *                                           from/direction/channel/body/ts.
 *
 * Both responses carry a `channel` field PER SESSION and PER MESSAGE so the web UI
 * can render a channel badge (§9.5). The DO reads the SAME DO-SQLite store the SMS
 * turns persist to (no separate store), over native RPC - the shapes are plain
 * string/number/null, so no structural-cast RPC bridge is needed.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAgentStub } from "../agent/index.ts";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";

/** A session id path param - a non-empty string (the DO mints it as a UUID). */
const SessionId = z.string().trim().min(1, "sessionId is required");

export function messagingRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the whole group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/messaging/*", requireAuth());

  // MNEMO-50: the `messaging_send` per-account rate-limit bucket
  // (src/abuse/rateLimit.ts) is provisioned for an OUTBOUND user-initiated send
  // endpoint. These routes are read-only (web rendering); SMS replies are emitted
  // by the inbound gateway (MNEMO-46 reply.ts), not a request here, and carry
  // their own cost guard. Apply `rateLimitMiddleware("messaging_send", byAccount)`
  // here once a user-facing send endpoint lands (Track H paid add-on).

  // GET /sessions - the conversation list. Each session carries `channel`/`kind`/
  // `day` + message count so the UI renders a channel badge and daily grouping.
  app.get("/agents/:agentId/messaging/sessions", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const sessions = await getAgentStub(c.env, agentId).listMessagingSessions();
    return c.json(sessions);
  });

  // GET /sessions/:sessionId/messages - one session's transcript. Each message
  // carries `from`/`direction`/`channel`/`body`/`ts` (the channel = the badge tag).
  app.get(
    "/agents/:agentId/messaging/sessions/:sessionId/messages",
    async (c) => {
      const agentId = c.req.param("agentId");
      const guard = await assertOwnsAgent(c, agentId);
      if (guard) return guard;

      const sessionId = SessionId.safeParse(c.req.param("sessionId"));
      if (!sessionId.success) {
        return c.json(
          { error: "invalid request", issues: sessionId.error.issues },
          400,
        );
      }

      const messages = await getAgentStub(c.env, agentId).listMessagingMessages(
        sessionId.data,
      );
      return c.json(messages);
    },
  );

  return app;
}
