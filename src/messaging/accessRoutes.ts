/**
 * Per-agent messaging access-control settings API (MNEMO-47, PRD §9.6).
 *
 * Mounted at `/agents/:agentId/messaging`, every route behind `requireAuth`
 * (MNEMO-03) plus the shared {@link assertOwnsAgent} guard (404-not-403 for a
 * non-owned id - the same no-existence-leak convention as the rest of the
 * `/agents/:agentId/*` surface). The owner manages two things here: the
 * open-to-the-world flag (DO `agent_meta`) and the whitelist (D1
 * `message_whitelist`).
 *
 *   GET    /messaging/access                  → { openToWorld, ownerNumber, whitelist[] }
 *   PUT    /messaging/access                   { openToWorld?, ownerNumber? } → persist
 *   POST   /messaging/whitelist                { contactE164 } → addToWhitelist
 *   DELETE /messaging/whitelist/:contactE164   → removeFromWhitelist
 *
 * Default `openToWorld: false` - WHITELIST-BY-DEFAULT. The `open_world` safe-default
 * persona (no private memory / sensitive tools, src/messaging/tiers.ts) is the
 * day-one social-engineering guard: a bot must be DELIBERATELY opened, never by
 * accident (§9.6).
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAgentStub } from "../agent/index.ts";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";
import {
  addToWhitelist,
  listWhitelist,
  removeFromWhitelist,
} from "../db/index.ts";

/**
 * An E.164 phone number (`+` then 1–15 digits, leading digit non-zero). Validated
 * at the boundary so a malformed contact fails 400 here rather than landing a junk
 * row. Used for both the owner number and a whitelisted contact.
 */
const E164 = z
  .string()
  .trim()
  .regex(
    /^\+[1-9]\d{1,14}$/,
    "must be an E.164 phone number (e.g. +14155551212)",
  );

/** PUT /messaging/access body - both fields optional (patch semantics). */
const AccessUpdateBody = z.object({
  openToWorld: z.boolean().optional(),
  // The owner's verified number (resolves a 1:1 sender to the `owner` tier).
  // Nullable so the owner can clear it; absent leaves it unchanged.
  ownerNumber: E164.nullable().optional(),
});

/** POST /messaging/whitelist body - one contact to add. */
const WhitelistAddBody = z.object({ contactE164: E164 });

export function messagingAccessRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; requireAuth is idempotent).
  app.use("/agents/:agentId/messaging/access", requireAuth());
  app.use("/agents/:agentId/messaging/whitelist", requireAuth());
  app.use("/agents/:agentId/messaging/whitelist/*", requireAuth());

  // GET /messaging/access - the current access policy (flag + owner number from
  // the DO; whitelist from D1). `openToWorld` defaults false (whitelist-by-default).
  app.get("/agents/:agentId/messaging/access", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const access = await getAgentStub(c.env, agentId).getMessagingAccess();
    const whitelist = await listWhitelist(c.env, agentId);
    return c.json({
      openToWorld: access.openToWorld,
      ownerNumber: access.ownerNumber,
      whitelist: whitelist.map((w) => ({
        contactE164: w.contact_e164,
        scope: w.scope,
        createdAt: w.created_at,
      })),
    });
  });

  // PUT /messaging/access - persist the open-to-the-world flag and/or owner number
  // to agent_meta. A no-field body is a no-op (returns the current policy).
  app.put("/agents/:agentId/messaging/access", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = AccessUpdateBody.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    const stub = getAgentStub(c.env, agentId);
    if (parsed.data.openToWorld !== undefined) {
      await stub.setMessagingOpenToWorld(parsed.data.openToWorld);
    }
    if (parsed.data.ownerNumber !== undefined) {
      await stub.setMessagingOwnerNumber(parsed.data.ownerNumber);
    }
    return c.json(await stub.getMessagingAccess());
  });

  // POST /messaging/whitelist - add a contact (idempotent at the DB layer). Owner-
  // added contacts get the default `'global'` scope.
  app.post("/agents/:agentId/messaging/whitelist", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const parsed = WhitelistAddBody.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    await addToWhitelist(c.env, agentId, parsed.data.contactE164);
    return c.json({ ok: true, contactE164: parsed.data.contactE164 }, 201);
  });

  // DELETE /messaging/whitelist/:contactE164 - remove a contact (no-op if absent).
  app.delete("/agents/:agentId/messaging/whitelist/:contactE164", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const contact = E164.safeParse(c.req.param("contactE164"));
    if (!contact.success) {
      return c.json(
        { error: "invalid request", issues: contact.error.issues },
        400,
      );
    }
    await removeFromWhitelist(c.env, agentId, contact.data);
    return c.json({ ok: true });
  });

  return app;
}
