/**
 * Web conversation HTTP surface (MNEMO-35/36, PRD §6.5).
 *
 * Mounted at `/agents/:agentId/conversations`, every route behind `requireAuth`
 * (MNEMO-03) plus the shared {@link assertOwnsAgent} guard (404-not-403 for a
 * non-owned id, matching the audit/report/brain convention). Thread CRUD only -
 * the STREAMING chat turn (`POST .../conversations/:id/chat`) is wired directly to
 * the DO in src/index.ts because it returns a streamed Response, not JSON.
 *
 *   GET   /                 - list threads, newest first (`?q=` ⇒ title search).
 *   POST  /                 - create a thread (`{ firstMessage? }` seeds the title).
 *   GET   /:conversationId   - one thread's metadata + full transcript (404 if absent).
 *   PATCH /:conversationId   - rename a thread (`{ title }`) (404 if absent).
 *
 * Threads live inside the per-agent DO (keyed by agentId), so every route is
 * agent-scoped - there is no global `/conversations/:id` (a bare id can't resolve
 * its owning DO). Routes are thin over the DO's conversation RPC methods.
 */
import { Hono } from "hono";
import { z } from "zod";
import { assertOwnsAgent } from "../../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../../auth/middleware.ts";
import { getAgentStub } from "../index.ts";

/** POST body - create a thread. `firstMessage` (optional) seeds the title only. */
const CreateConversationBody = z.object({
  firstMessage: z.string().max(8192).optional(),
});

/** PATCH body - rename. `title` is trimmed; bounded so the list rail stays sane. */
const RenameConversationBody = z.object({
  title: z.string().trim().min(1, "title is required").max(200),
});

export function conversationRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the whole group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/conversations", requireAuth());
  app.use("/agents/:agentId/conversations/:conversationId", requireAuth());

  // GET / - list (newest-updated first); `?q=` switches to a title search.
  app.get("/agents/:agentId/conversations", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const q = c.req.query("q")?.trim();
    const stub = getAgentStub(c.env, agentId);
    const list = q
      ? await stub.searchConversations(q)
      : await stub.listConversations();
    return c.json(list);
  });

  // POST / - create a new thread → 201.
  app.post("/agents/:agentId/conversations", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = CreateConversationBody.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const created = await getAgentStub(c.env, agentId).createConversation({
      firstMessage: parsed.data.firstMessage,
    });
    return c.json(created, 201);
  });

  // GET /:conversationId - metadata + transcript (404 if the thread is unknown).
  app.get("/agents/:agentId/conversations/:conversationId", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const detail = await getAgentStub(c.env, agentId).getConversation(
      c.req.param("conversationId"),
    );
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  });

  // PATCH /:conversationId - rename (404 if the thread is unknown).
  app.patch("/agents/:agentId/conversations/:conversationId", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = RenameConversationBody.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const updated = await getAgentStub(c.env, agentId).renameConversation(
      c.req.param("conversationId"),
      parsed.data.title,
    );
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  return app;
}
