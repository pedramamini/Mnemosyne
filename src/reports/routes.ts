/**
 * Report retrieval HTTP surface (MNEMO-25, PRD §6.4/§7.4).
 *
 * Mounted at `/agents/:agentId/reports`, every route behind `requireAuth`
 * (MNEMO-03) plus the shared {@link assertOwnsAgent} guard (the requesting account
 * must own the agent - 404, not 403, for a non-owned id, matching the audit/brain
 * route convention). Three reads, backing the web report viewer (MNEMO-41):
 *
 *   GET /                       - list report metadata (newest first) →
 *                                 `{ id, title, created_at, front_matter }[]`.
 *   GET /:reportId              - the report's `report.md` from R2 as
 *                                 `text/markdown` (404 if missing).
 *   GET /:reportId/assets/:file - a chart PNG from R2 as `image/png`; `file` is
 *                                 validated against {@link SAFE_ASSET_FILE} (a
 *                                 `[\w.-]+\.png` shape) to reject prefix traversal.
 *
 * Routes are thin over `src/reports/archive.ts` - the R2-key derivation lives there
 * (one owner), not here. Full-text search over report BODIES is deferred to
 * MNEMO-41 (the report viewer UI); the metadata list + per-report fetch is enough
 * for the archive/retrieval contract this phase owns.
 */
import { Hono } from "hono";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";
import { listReportsByAgent } from "../db/index.ts";
import {
  getReportAsset,
  getReportMarkdown,
  SAFE_ASSET_FILE,
} from "./archive.ts";

export function reportRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the whole group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/reports/*", requireAuth());

  // GET / - report metadata, newest first. D1-only (no R2): the list/search UI
  // never enumerates blobs. `front_matter` is the stored JSON string (or null).
  app.get("/agents/:agentId/reports", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const reports = await listReportsByAgent(c.env, agentId);
    return c.json(
      reports.map((r) => ({
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        front_matter: r.front_matter,
      })),
    );
  });

  // GET /:reportId - the report's markdown body from R2 as text/markdown.
  app.get("/agents/:agentId/reports/:reportId", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const object = await getReportMarkdown(
      c.env,
      agentId,
      c.req.param("reportId"),
    );
    if (!object) return c.json({ error: "not found" }, 404);

    return new Response(object.body, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  });

  // GET /:reportId/assets/:file - a chart PNG from R2 as image/png. `file` must
  // match the safe `[\w.-]+\.png` shape (no `/`, ends `.png`) so a `../report.md`
  // or `x/../../y` can never resolve outside the report's `assets/` segment.
  app.get("/agents/:agentId/reports/:reportId/assets/:file", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const file = c.req.param("file");
    if (!SAFE_ASSET_FILE.test(file)) {
      return c.json({ error: "invalid asset name" }, 400);
    }

    const object = await getReportAsset(
      c.env,
      agentId,
      c.req.param("reportId"),
      file,
    );
    if (!object) return c.json({ error: "not found" }, 404);

    return new Response(object.body, {
      headers: { "Content-Type": "image/png" },
    });
  });

  return app;
}
