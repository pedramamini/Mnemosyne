/**
 * HTML artifact retrieval HTTP surface (renderHtml tool).
 *
 * Mounted at `/agents/:agentId/artifacts`, every route behind `requireAuth`
 * (MNEMO-03) plus the shared {@link assertOwnsAgent} guard (404, not 403, for a
 * non-owned id - matching the reports/audit/brain convention). Two reads back the
 * inline chat preview (the `data-artifact` message part):
 *
 *   GET /                  - artifact metadata (newest first) →
 *                            `{ id, title, content_type, byte_size, created_at }[]`.
 *   GET /:artifactId/raw   - the artifact's `index.html` from R2 as text/html,
 *                            served behind a LOCKED-DOWN CSP so the (semi-trusted)
 *                            agent HTML can't touch the app, the session, or the
 *                            network. This is the iframe `src`.
 *
 * ── Why the artifact HTML is treated as untrusted ────────────────────────────
 * An agent ingests web content during research (PRD §6.3 web tools), so its
 * rendered HTML can carry attacker-shaped markup/script (prompt-injection →
 * exfil). The defenses, applied at THIS render boundary so they can't be relaxed
 * by the document itself:
 *
 *   - `Content-Security-Policy: sandbox allow-scripts` (NO allow-same-origin) →
 *     the document runs in an OPAQUE origin: no cookies, no localStorage, no
 *     access to the parent app DOM, even though it is served from our origin.
 *   - `connect-src 'none'` + `img-src data: blob:` (no remote `https:`) → inline
 *     scripts may run for interactivity, but have ZERO network egress, so a
 *     compromised artifact has no channel to exfiltrate. Agents must inline assets
 *     as data: URIs (the tool description says so).
 *   - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` → only our own app
 *     may frame it. `nosniff` + an explicit text/html content type pin the type.
 *   - `Cache-Control: private, no-store` - it's per-account content behind auth.
 *
 * The frontend `<iframe>` ALSO carries `sandbox="allow-scripts"`; the effective
 * sandbox is the intersection, so the two agree and either alone is sufficient.
 */
import { Hono } from "hono";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, requireAuth } from "../auth/middleware.ts";
import { listArtifactsByAgent } from "../db/index.ts";
import { getHtmlArtifact } from "./store.ts";

/**
 * The locked-down policy applied to every served artifact. Built once - it is
 * derived from no request input. See the module header for the rationale of each
 * directive; the load-bearing pair is `sandbox allow-scripts` (opaque origin) +
 * `connect-src 'none'` (no egress).
 */
const ARTIFACT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

export function artifactRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the whole group (idempotent with the `/agents/:agentId/*`
  // wildcard in src/index.ts - applying it here keeps the sub-app correct regardless
  // of mount order).
  app.use("/agents/:agentId/artifacts/*", requireAuth());

  // GET / - artifact metadata, newest first. D1-only (no R2).
  app.get("/agents/:agentId/artifacts", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const artifacts = await listArtifactsByAgent(c.env, agentId);
    return c.json(
      artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        content_type: a.content_type,
        byte_size: a.byte_size,
        created_at: a.created_at,
        conversation_id: a.conversation_id,
      })),
    );
  });

  // GET /:artifactId/raw - the artifact's HTML body from R2, behind the hardened
  // CSP/sandbox headers. This is the iframe `src`.
  app.get("/agents/:agentId/artifacts/:artifactId/raw", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const object = await getHtmlArtifact(
      c.env,
      agentId,
      c.req.param("artifactId"),
    );
    if (!object) return c.json({ error: "not found" }, 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": ARTIFACT_CSP,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
        "Content-Disposition": "inline",
      },
    });
  });

  return app;
}
