/**
 * Account routes (behind `requireAuth`):
 *
 *   GET /api/me          - the authenticated account: `{ id, email }` + owner
 *                          profile (`timezone`, `name`, `notes`); 401 if no
 *                          valid session.
 *   PUT /api/me/profile  - update the owner profile (timezone + name/notes that
 *                          feed every agent's persona); 200 with the new profile.
 *
 * The session is an HttpOnly cookie the Worker sets (MNEMO-03), so the SPA can
 * never read it; it INFERS auth state by probing `GET /api/me` (200 → signed in,
 * 401 → anonymous). The profile is account-level - one human, possibly many
 * agents - so a save fans out to all the account's DOs (see account/service.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, getAccountId, requireAuth } from "../auth/middleware.ts";
import type { AccountRow } from "../db/index.ts";
import { getAccount } from "../db/index.ts";
import { isValidTimeZone, updateOwnerProfileForAccount } from "./service.ts";

/** The owner-profile view returned to the SPA (the editable settings subset). */
function profileView(account: AccountRow) {
  return {
    timezone: account.timezone,
    name: account.owner_name,
    notes: account.owner_notes,
  };
}

/**
 * Owner-profile update body. Every field optional (partial save); `null` clears.
 * `timezone` must be a real IANA zone when a non-null string is given - an
 * invalid one would later make the persona's date layer throw (it falls back to
 * UTC, but we reject at the boundary so the user sees the error, not a silent
 * UTC). Notes are length-bounded so a single field can't bloat every prompt.
 */
const ProfileUpdateBody = z.object({
  timezone: z
    .string()
    .refine(isValidTimeZone, "not a valid IANA timezone")
    .nullable()
    .optional(),
  name: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export function accountRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/api/me", requireAuth());
  app.use("/api/me/profile", requireAuth());

  app.get("/api/me", async (c) => {
    const account = await getAccount(c.env, getAccountId(c));
    // A valid session whose account row has since vanished (deleted) is treated
    // as unauthenticated rather than a 500 - the SPA simply flips to anonymous.
    if (!account) return c.json({ error: "unauthorized" }, 401);
    return c.json({
      id: account.id,
      email: account.email,
      profile: profileView(account),
    });
  });

  app.put("/api/me/profile", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ProfileUpdateBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    }
    // Map the API's profile shape to the snake_case DB columns.
    const { timezone, name, notes } = parsed.data;
    const updated = await updateOwnerProfileForAccount(c.env, getAccountId(c), {
      ...(timezone !== undefined && { timezone }),
      ...(name !== undefined && { owner_name: name }),
      ...(notes !== undefined && { owner_notes: notes }),
    });
    if (!updated) return c.json({ error: "unauthorized" }, 401);
    return c.json({ profile: profileView(updated) });
  });

  return app;
}
