import { Hono } from "hono";
import { z } from "zod";
import { byAccount, rateLimitMiddleware } from "./abuse/rateLimit.ts";
import { accountRoutes } from "./account/routes.ts";
import { assessmentRoutes } from "./agent/assessment/routes.ts";
import { buildRoutes } from "./agent/build/routes.ts";
import { conversationRoutes } from "./agent/conversations/routes.ts";
import { deepDiveRoutes } from "./agent/deepdive/routes.ts";
import { discoveryRoutes } from "./agent/discovery/routes.ts";
import { getAgentStub, MnemosyneAgent } from "./agent/index.ts";
import { agentRoutes } from "./agents/routes.ts";
import { getAgentOwned } from "./agents/service.ts";
import { artifactRoutes } from "./artifacts/routes.ts";
import { AuditLog, getAuditStub } from "./audit/index.ts";
import { auditRoutes } from "./audit/routes.ts";
import { type AppEnv, getAccountId, requireAuth } from "./auth/middleware.ts";
import { authRoutes } from "./auth/routes.ts";
import { billingRoutes } from "./billing/routes.ts";
import type { Env } from "./env.ts";
import { errorHandler, notFoundHandler } from "./errors/handler.ts";
import { llmProfileRoutes } from "./llm/profileRoutes.ts";
import { GRAPH_CAPS } from "./memory/graph-index.ts";
import { BRAIN_ROOT } from "./memory/layout.ts";
import { HISTORY_CAPS } from "./memory/versioning.ts";
import { messagingAccessRoutes } from "./messaging/accessRoutes.ts";
import { mountMessagingGateway } from "./messaging/gateway.ts";
import { messagingManageRoutes } from "./messaging/manageRoutes.ts";
import { messagingRoutes } from "./messaging/routes.ts";
import { ThreadCoordinator } from "./messaging/ThreadCoordinator.ts";
import { requestContext } from "./obs/requestContext.ts";
import { reportRoutes } from "./reports/routes.ts";
import { devTriggerRoutes } from "./schedule/dev-routes.ts";
import { runDueAgents } from "./schedule/fanout.ts";

/** Max `cmd` length accepted by the sandbox-run debug route (a smoke test, not the agent interface). */
const MAX_SANDBOX_CMD_LEN = 4096;

/**
 * Query-param schemas for the read-only brain retrieval routes (MNEMO-09).
 * `depth`/`limit` arrive as strings, so coerce; they're optional (a sensible
 * default applies) and clamped to the {@link GRAPH_CAPS} rails server-side AFTER
 * parse - never trusting the caller for the runaway-graph bound.
 */
const BrainGraphQuery = z.object({
  start: z.string().trim().min(1, "start is required"),
  depth: z.coerce.number().int().positive().optional(),
});
const BrainSearchQuery = z.object({
  q: z.string().trim().min(1, "q is required"),
  limit: z.coerce.number().int().positive().optional(),
});

/** Hard cap on a single note body (MNEMO-10). `notePath` is the load-bearing
 * traversal guard inside the DO; this clamp + slug check fail bad input loud at
 * the boundary so a hostile request never reaches the write pipeline. */
const MAX_NOTE_CHARS = 256 * 1024;

/**
 * A note slug usable as a filename under `/brain/notes`. The canonical guard is
 * `notePath` (src/memory/layout.ts), which rejects traversal before any write;
 * this mirrors it at the request boundary so the route returns 400 (not a 500
 * from a thrown BrainPathError crossing the RPC boundary).
 */
const NoteSlug = z
  .string()
  .trim()
  .min(1, "slug is required")
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.includes("\\") &&
      !s.split("/").some((seg) => seg === ".."),
    "invalid note slug",
  );

/** POST body - write a full note. `title` is optional neuron metadata. */
const BrainNoteWriteBody = z.object({
  slug: NoteSlug,
  title: z.string().trim().min(1).optional(),
  content: z.string().max(MAX_NOTE_CHARS, "note too large"),
});

/** PATCH body - append to a note (the slug comes from the path param). */
const BrainNoteAppendBody = z.object({
  content: z
    .string()
    .min(1, "content is required")
    .max(MAX_NOTE_CHARS, "note too large"),
});

/** Hard cap on an explorer file body (MNEMO-11). Larger than a note (it can edit
 * tools/reports/binaries) but still bounded so a hostile request can't buffer an
 * unbounded blob; `assertInsideBrain` + the service's read cap are the deeper
 * rails. Base64 bodies inflate ~1.33×, so the on-disk file is smaller than this. */
const MAX_BRAIN_FILE_CHARS = 4 * 1024 * 1024;

/**
 * A general brain path usable by the explorer (MNEMO-11). The canonical guard is
 * `assertInsideBrain` (src/memory/layout.ts) inside the DO; this mirrors it at
 * the request boundary so a traversal/absolute-escape returns 400 (not a 500
 * from a BrainPathError crossing the RPC boundary). Accepts a path relative to
 * `/brain` or an absolute path already rooted there.
 */
const BrainPath = z
  .string()
  .trim()
  .min(1, "path is required")
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.split("/").some((seg) => seg === "..") &&
      (!p.startsWith("/") ||
        p === BRAIN_ROOT ||
        p.startsWith(`${BRAIN_ROOT}/`)),
    "invalid brain path",
  );

/** Query for the tree listing - `path` is an OPTIONAL sub-path (default `/brain`). */
const BrainFilesQuery = z.object({ path: BrainPath.optional() });

/** Query carrying a REQUIRED brain path (read / delete one file). */
const BrainFileQuery = z.object({ path: BrainPath });

/** PUT body - write or create a brain file. `encoding` defaults to utf8. */
const BrainFileWriteBody = z.object({
  path: BrainPath,
  content: z.string().max(MAX_BRAIN_FILE_CHARS, "file too large"),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

/** Query for the archive export - `format` defaults to tar (tar.gz). */
const BrainArchiveQuery = z.object({
  format: z.enum(["zip", "tar"]).optional(),
});

/**
 * A git revision usable in a versioning route (MNEMO-12). The canonical guard is
 * `assertSafeRev` (src/memory/versioning.ts) inside the DO; this mirrors it at the
 * boundary so a non-sha returns 400 (not a 500 from a BadRevisionError crossing
 * RPC). A sha (hex) or a HEAD-relative ref - never something that reads as a git
 * option (it can't start with `-`).
 */
const GitRev = z
  .string()
  .trim()
  .regex(/^(HEAD|[0-9a-fA-F]{4,40})([~^]\d*)*$/, "invalid git revision");

/** Common paging query for the history routes - `limit` clamped server-side. */
const BrainHistoryQuery = z.object({
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().trim().min(1).optional(),
});

/** History of one file - paging plus the required `path`. */
const BrainFileHistoryQuery = BrainHistoryQuery.extend({ path: BrainPath });

/**
 * Diff query - EITHER `?sha=` (a whole-commit diff) OR `?path=&from=[&to=]` (a
 * single-file diff vs another revision / the working tree). The refinement makes
 * the two modes mutually exclusive so the route never half-parses an ambiguous
 * request.
 */
const BrainDiffQuery = z
  .object({
    sha: GitRev.optional(),
    path: BrainPath.optional(),
    from: GitRev.optional(),
    to: GitRev.optional(),
  })
  .refine(
    (d) => (d.sha ? !d.path && !d.from : Boolean(d.path && d.from)),
    "provide either ?sha= (commit diff) or ?path=&from=[&to=] (file diff)",
  );

/** Query for the file-at-revision read (side-by-side view). */
const BrainFileAtQuery = z.object({ path: BrainPath, sha: GitRev });

/**
 * Restore body - `sha` required; `path` present ⇒ single-file restore, absent ⇒
 * whole-tree restore. Restore is a POST (state-changing) and ownership-checked.
 */
const BrainRestoreBody = z.object({
  path: BrainPath.optional(),
  sha: GitRev,
});

const app = new Hono<AppEnv>();

// MNEMO-50: request context FIRST - before auth, before every route. Mints/honors
// a `requestId`, binds a request-scoped logger (c.var.log), sets the x-request-id
// response header, and emits one `http_request` access log per request. Every
// downstream handler + the error handler read the same id, so the edge access log,
// the DO calls, and the audit log all correlate on a single grep.
app.use("*", requestContext());

// Single-origin SPA hosting (worker-deploy glue, post-MNEMO). The built frontend
// (frontend/dist) is served by Workers Assets: real files (/, /assets/*.js, …) are
// returned by the platform BEFORE this Worker runs. For any other path, a browser
// *navigation* - proven by `Sec-Fetch-Mode: navigate`, a header `fetch()`/XHR can
// never set - must get the SPA shell so client-side routing survives deep links and
// refreshes, while same-path API calls (e.g. `GET /agents` as JSON vs the `/agents`
// dashboard route) fall through to the Hono routes below. Paths the Worker itself
// serves to the browser (the magic-link callback that sets the cookie + redirects,
// the health probe, the dev cron triggers) are excluded so navigations still hit it.
app.use("*", async (c, next) => {
  const isNavigation =
    c.req.method === "GET" && c.req.header("Sec-Fetch-Mode") === "navigate";
  const p = c.req.path;
  const workerServesNavigation =
    p.startsWith("/auth/") || p === "/health" || p.startsWith("/__dev");
  if (isNavigation && !workerServesNavigation) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  }
  await next();
});

// MNEMO-50: the SINGLE error handler. Any thrown error (typed AppError or not) is
// normalized + logged with full internal detail, 5xx is counted, and a SAFE body
// `{ error: { code, message, requestId } }` is returned (internalDetail never
// leaks; Retry-After set for RateLimited). The notFound handler returns the same
// typed envelope for an unmatched route.
app.onError(errorHandler);
app.notFound(notFoundHandler);

app.get("/health", (c) =>
  c.json({ status: "ok", service: "mnemosyne" } as const),
);

// Magic-link auth: POST /auth/request, GET /auth/callback, POST /auth/logout.
app.route("/", authRoutes());

// Inbound messaging gateway (MNEMO-45, PRD §9.3/§9.6): POST /webhooks/twilio/sms.
// Deliberately PUBLIC - NOT behind requireAuth - because the authenticated caller
// is Twilio, proven by the X-Twilio-Signature the handler validates, not a
// logged-in user with a session cookie. It acks the webhook immediately and
// fire-and-forgets the per-agent handoff (never blocks on the agent loop).
mountMessagingGateway(app);

// Session probe (MNEMO-33): GET /api/me → the authenticated account `{ id, email }`
// (200) or 401. The SPA can't read the HttpOnly session cookie, so it infers auth
// state from this endpoint. Behind requireAuth (applied inside the sub-app).
app.route("/", accountRoutes());

// Agent registry CRUD (MNEMO-05): POST/GET /agents, GET/PATCH /agents/:agentId.
// Exact paths, each behind requireAuth - they sit beside the DO debug wildcard
// below without conflict (the wildcard needs a trailing segment to match).
app.route("/", agentRoutes());

// Per-user LLM profile (MNEMO-13): GET/PUT /api/llm-profile - read the resolved
// provider/model (+ hasKey, never the key) and set BYOK or reset to the free
// Workers AI default. Behind requireAuth (applied inside the sub-app).
app.route("/", llmProfileRoutes());

// Audit log "glass cockpit" API (MNEMO-22, PRD §6.7/§8.6): GET
// /agents/:agentId/audit/{stream,events,search} - the SSE live tail (with
// Last-Event-ID/sinceSeq reconnect backfill + type/level/sessionId filters), the
// structured filter query, and FTS5 search. Each route is behind requireAuth +
// an ownership guard (applied inside the sub-app). Mounted before the
// `/agents/:agentId/*` wildcard below so the streamed Response passes straight
// through the worker.
app.route("/", auditRoutes());

// Report archive + retrieval API (MNEMO-25, PRD §6.4/§7.4): GET
// /agents/:agentId/reports (metadata list), GET /agents/:agentId/reports/:reportId
// (the report.md from R2 as text/markdown), GET /.../:reportId/assets/:file (a
// chart PNG from R2 as image/png, traversal-guarded). Each route is behind
// requireAuth + an ownership guard (applied inside the sub-app). Mounted before
// the `/agents/:agentId/*` wildcard below so the streamed markdown/PNG Responses
// pass straight through the worker.
app.route("/", reportRoutes());

// HTML artifact retrieval API (renderHtml tool): GET /agents/:agentId/artifacts
// (metadata list) + GET /agents/:agentId/artifacts/:artifactId/raw (the index.html
// from R2 as text/html, behind a locked-down sandbox CSP - this is the chat
// iframe's src). Behind requireAuth + an ownership guard (inside the sub-app), and
// mounted before the `/agents/:agentId/*` wildcard so the streamed HTML Response
// passes straight through the worker.
app.route("/", artifactRoutes());

// Discovery lifecycle API (MNEMO-29, PRD §5/§6.3): POST
// /agents/:agentId/discovery/start (begin the clarify-scope conversation), POST
// /agents/:agentId/discovery/message (one scoping turn → { reply, state }), GET
// /agents/:agentId/discovery (read state). Each route is behind requireAuth + an
// ownership guard (applied inside the sub-app). The confidence gate is a
// terminator-style `finalize_discovery` tool, not a required-fields form; MNEMO-30
// reads the persisted spec to provision a live agent.
app.route("/", discoveryRoutes());

// Messaging web-rendering API (MNEMO-46, PRD §9.5): GET
// /agents/:agentId/messaging/sessions (the conversation list) + GET
// /agents/:agentId/messaging/sessions/:sessionId/messages (one thread). SMS turns
// persist to the per-agent DO-SQLite and render in-app as first-class
// conversations with a channel badge (each session + message carries `channel`).
// Each route is behind requireAuth + an ownership guard (applied inside the
// sub-app). Mounted before the `/agents/:agentId/*` wildcard below.
app.route("/", messagingRoutes());

// Messaging access-control settings API (MNEMO-47, PRD §9.6): GET/PUT
// /agents/:agentId/messaging/access (the open-to-the-world flag + owner number)
// and POST/DELETE /agents/:agentId/messaging/whitelist[/:contactE164] (the
// allow-list). Whitelist-by-default - the access list gates ACCEPTANCE; the
// capability tier (src/messaging/tiers.ts) is the real disclosure boundary. Each
// route is behind requireAuth + an ownership guard (applied inside the sub-app).
// Mounted before the `/agents/:agentId/*` wildcard below.
app.route("/", messagingAccessRoutes());

// Messaging enable/status/disable + org-level A2P 10DLC onboarding (MNEMO-47, PRD
// §9.1): POST /agents/:agentId/messaging/{enable,disable} + GET
// /agents/:agentId/messaging/status (per-agent opt-in, gated on shared 10DLC
// readiness - provisioning an unregistered number gets it throttled), plus
// GET /api/a2p/status + POST /api/a2p/onboard (the SHARED brand/campaign, one
// covers many numbers). Each per-agent route is behind requireAuth + an ownership
// guard; the org-level routes require auth (admin-guard is a documented extension
// point). Mounted before the `/agents/:agentId/*` wildcard below.
app.route("/", messagingManageRoutes());

// Web conversation API (MNEMO-35/36, PRD §6.5): GET/POST
// /agents/:agentId/conversations (list/search + create) and GET/PATCH
// /agents/:agentId/conversations/:conversationId (transcript + rename). Threads
// live in the per-agent DO; each route is behind requireAuth + an ownership guard
// (applied inside the sub-app). The STREAMING turn (POST .../:id/chat) is wired
// directly to the DO below (it returns a streamed Response, not JSON). Mounted
// before the `/agents/:agentId/*` wildcard.
app.route("/", conversationRoutes());

// Build lifecycle API (MNEMO-30, PRD §5(2)): POST /agents/:agentId/build
// (provision the brain FS, assemble the system prompt, enable tools + schedule
// defaults, apply the template, and promote the registry row to `operational`)
// and GET /agents/:agentId/build (read BuildStatus). Build is idempotent +
// resumable - safe to call repeatedly. Each route is behind requireAuth + an
// ownership guard (applied inside the sub-app). Mounted before the
// `/agents/:agentId/*` wildcard below.
app.route("/", buildRoutes());

// Onboarding deep-dive API: GET /agents/:agentId/deepdive (read DeepDiveStatus -
// the 5-phase initial research progress). The dive is kicked off by Build and
// advances on its own (alarm-driven), so this is read-only progress. Behind
// requireAuth + an ownership guard (applied inside the sub-app). Mounted before
// the `/agents/:agentId/*` wildcard below.
app.route("/", deepDiveRoutes());

// Weekly self-assessment API ("Karpathy loop"): GET /agents/:agentId/assessment
// (read the rolling self-review history + the applied self-iterations). The loop
// is armed when the deep dive completes and re-chains weekly. Behind requireAuth
// + an ownership guard (applied inside the sub-app).
app.route("/", assessmentRoutes());

// Billing, metering & enforcement API (MNEMO-49, PRD §3/§8.4/§9.2): GET
// /billing/{subscription,usage,limits}, POST /billing/{checkout,cancel},
// POST /billing/addon/messaging (per-agent add-on, gated on tier eligibility) -
// all account-scoped behind requireAuth (applied inside the sub-app) - plus the
// deliberately PUBLIC POST /billing/webhook (the PSP caller is proven by the
// provider signature the handler verifies, not a session cookie). Tier limits are
// declarative in src/billing/tiers.ts; the cost cap sums the append-only
// usage_events ledger; the gate is fail-closed on cap / fail-open on unknown error.
app.route("/", billingRoutes());

// Dev-only schedule triggers (MNEMO-27): POST /__dev/cron (simulate the cron
// heartbeat) + POST /agents/:agentId/__dev/run (force one agent's run). They
// exist because cron does NOT fire under `wrangler dev` (§8.5). Mounted BEFORE
// the `/agents/:agentId/*` requireAuth wildcard so the force-run route is NOT
// behind session auth (cron has no user); the group's own middleware 404s every
// request in production, so it is unreachable there. NEVER reachable in prod.
app.route("/", devTriggerRoutes());

// Authenticated per-agent DO passthrough. For MNEMO-04 only the settings debug
// route is wired - it proves the routing + DO round-trip. Later phases hang the
// chat, memory, audit, and report routes off this same `/agents/:agentId/*`
// prefix (all behind requireAuth).
app.use("/agents/:agentId/*", requireAuth());
app.get("/agents/:agentId/settings", async (c) => {
  const agentId = c.req.param("agentId");
  const settings = await getAgentStub(c.env, agentId).getSettings();
  return c.json(settings);
});

// MNEMO-15 agentic chat (PRD §7.1 topology A): route a chat turn to the agent's
// DO. Ownership-checked (404 for a non-owned id, no existence leak; requireAuth
// via the `/agents/:agentId/*` middleware above). The authenticated account id is
// copied into the `x-mnemo-account` header (the §3 threading pattern) so a cold/
// hibernated DO can self-identify after the upgrade - `.set()` overwrites any
// client-supplied value, so the header can't be spoofed. Handles BOTH the WS
// upgrade (interactive streaming) and a plain `POST .../chat` (JSON `{ message }`).
// MNEMO-50: a research turn is an expensive entry point (it can boot the sandbox
// + drive the model loop), so guard it per-account. Sits AFTER the
// `/agents/:agentId/*` requireAuth wildcard above so byAccount can read the id.
app.use(
  "/agents/:agentId/chat",
  rateLimitMiddleware("research_start", byAccount),
);
app.all("/agents/:agentId/chat", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-mnemo-account", getAccountId(c));
  // MNEMO-50: forward the edge requestId so the DO + audit logs correlate with the
  // access log (.set() overwrites any client-supplied value).
  headers.set("x-request-id", c.get("requestId"));
  const forwarded = new Request(c.req.raw, { headers });

  return getAgentStub(c.env, agentId).fetch(forwarded);
});

// MNEMO-35/36 multi-thread web chat (PRD §6.5): stream one chat turn into a named
// conversation thread. Same identity/threading + per-account rate guard as the
// single-thread `/chat` above (a research turn can boot the sandbox + drive the
// model loop), but the DO routes on the `/conversations/:id/chat` path to persist
// the turn into that thread's transcript and stream a UI-message SSE response.
// Sits AFTER the `/agents/:agentId/*` requireAuth wildcard so byAccount + the
// ownership check can read the authenticated account id.
app.use(
  "/agents/:agentId/conversations/:conversationId/chat",
  rateLimitMiddleware("research_start", byAccount),
);
app.all("/agents/:agentId/conversations/:conversationId/chat", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-mnemo-account", getAccountId(c));
  headers.set("x-request-id", c.get("requestId"));
  const forwarded = new Request(c.req.raw, { headers });

  return getAgentStub(c.env, agentId).fetch(forwarded);
});

// MNEMO-06 provisioning smoke test: proves the worker -> DO -> sandbox path end
// to end. Ownership-checked via the MNEMO-05 service (404 for a non-owned id, no
// existence leak). The DO warms the container then runs `cmd` through the client
// wrapper. NOT the agent interface - real tool execution is gated behind the
// harness/tool framework (Track C); this route only exercises provisioning.
app.post("/agents/:agentId/sandbox/run", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    cmd?: unknown;
  } | null;
  const cmd = body?.cmd;
  if (typeof cmd !== "string" || cmd.length === 0) {
    return c.json({ error: "cmd is required" }, 400);
  }
  if (cmd.length > MAX_SANDBOX_CMD_LEN) {
    return c.json({ error: "cmd too long" }, 400);
  }

  const result = await getAgentStub(c.env, agentId).runSandboxCommand(cmd);
  return c.json(result);
});

// MNEMO-07 brain write→commit smoke test: proves the single auto-commit
// chokepoint (PRD §6.2/§6.9) end to end. Ownership-checked (404 for a non-owned
// id, no existence leak); requireAuth is applied by the `/agents/:agentId/*`
// middleware above. The DO writes a test note then commits via `commitBrain`,
// returning the new sha (or null when the tree was already clean).
app.post("/agents/:agentId/brain/commit", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const result = await getAgentStub(c.env, agentId).debugWriteNoteAndCommit();
  return c.json(result);
});

// MNEMO-09 brain retrieval (read-only). All three read straight from DO SQLite
// (the neuron/synapse index) and do NOT warm the sandbox container (PRD §7.4):
//
//   GET /agents/:agentId/brain/size                       - brain-size metric
//   GET /agents/:agentId/brain/graph?start=<slug>&depth=<n> - bounded BFS subgraph
//   GET /agents/:agentId/brain/search?q=<term>            - title/slug index search
//
// requireAuth is applied by the `/agents/:agentId/*` middleware above; each is
// ownership-checked (404 for a non-owned id, no existence leak). `depth`/`limit`
// are validated with Zod and clamped to the GRAPH_CAPS rails server-side.
app.get("/agents/:agentId/brain/size", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const size = await getAgentStub(c.env, agentId).getBrainSize();
  return c.json(size);
});

app.get("/agents/:agentId/brain/graph", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainGraphQuery.safeParse({
    start: c.req.query("start"),
    depth: c.req.query("depth"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const maxDepth = Math.min(
    parsed.data.depth ?? GRAPH_CAPS.defaultMaxDepth,
    GRAPH_CAPS.maxDepth,
  );
  const graph = await getAgentStub(c.env, agentId).graphTraverse(
    parsed.data.start,
    { maxDepth },
  );
  return c.json(graph);
});

app.get("/agents/:agentId/brain/search", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainSearchQuery.safeParse({
    q: c.req.query("q"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const limit = Math.min(
    parsed.data.limit ?? GRAPH_CAPS.defaultSearchLimit,
    GRAPH_CAPS.maxSearchLimit,
  );
  const hits = await getAgentStub(c.env, agentId).graphSearch(
    parsed.data.q,
    limit,
  );
  return c.json(hits);
});

// MNEMO-10 memory write API. Each warms the sandbox and runs the write pipeline
// (writeFile → reindex → commit) on the DO, keeping FS/index/history in lockstep:
//
//   POST   /agents/:agentId/brain/notes        - write a full note      → 201
//   PATCH  /agents/:agentId/brain/notes/:slug   - append to a note       → 200
//   DELETE /agents/:agentId/brain/notes/:slug   - delete a note          → 200
//
// requireAuth is applied by the `/agents/:agentId/*` middleware above; each is
// ownership-checked (404 for a non-owned id, no existence leak). Bodies are
// Zod-validated and note size is clamped; slugs are checked at the boundary
// (notePath is the canonical traversal guard inside the DO).
app.post("/agents/:agentId/brain/notes", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainNoteWriteBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const result = await getAgentStub(c.env, agentId).memoryWrite(parsed.data);
  return c.json(result, 201);
});

app.patch("/agents/:agentId/brain/notes/:slug", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const slug = NoteSlug.safeParse(c.req.param("slug"));
  if (!slug.success) {
    return c.json({ error: "invalid request", issues: slug.error.issues }, 400);
  }
  const body = BrainNoteAppendBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!body.success) {
    return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  }
  const result = await getAgentStub(c.env, agentId).memoryAppend({
    slug: slug.data,
    content: body.data.content,
  });
  return c.json(result);
});

app.delete("/agents/:agentId/brain/notes/:slug", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const slug = NoteSlug.safeParse(c.req.param("slug"));
  if (!slug.success) {
    return c.json({ error: "invalid request", issues: slug.error.issues }, 400);
  }
  const result = await getAgentStub(c.env, agentId).memoryDelete(slug.data);
  return c.json(result);
});

// MNEMO-10 consolidation ("sleep") pass. `?dryRun=true` (the default) previews
// the plan + diffs without touching the brain; `?dryRun=false` applies it as one
// versioned, diffed commit (PRD §6.2). Ownership-checked; requireAuth above.
app.post("/agents/:agentId/brain/consolidate", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const dryRun = c.req.query("dryRun") !== "false"; // default-safe: preview
  const result = await getAgentStub(c.env, agentId).consolidate({ dryRun });
  return c.json(result);
});

// MNEMO-11 brain explorer (PRD §6.9): the brain is browsable/editable/downloadable
// from the web. Every operation is ownership-checked (404 for a non-owned id, no
// existence leak; requireAuth is applied by the `/agents/:agentId/*` middleware)
// and MEDIATED BY THE DO - the route validates with Zod and clamps size, then the
// DO warms the sandbox and (for notes) reindexes + commits. The route never
// touches the sandbox directly.
//
//   GET    /agents/:agentId/brain/files?path=<subpath>  - list the tree
//   GET    /agents/:agentId/brain/file?path=<path>       - read one file
//   PUT    /agents/:agentId/brain/file                   - write/create a file
//   DELETE /agents/:agentId/brain/file?path=<path>       - delete a path
//   GET    /agents/:agentId/brain/archive?format=zip|tar - download whole brain
app.get("/agents/:agentId/brain/files", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFilesQuery.safeParse({ path: c.req.query("path") });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const entries = await getAgentStub(c.env, agentId).brainListTree(
    parsed.data.path,
  );
  return c.json(entries);
});

app.get("/agents/:agentId/brain/file", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFileQuery.safeParse({ path: c.req.query("path") });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const file = await getAgentStub(c.env, agentId).brainReadFile(
    parsed.data.path,
  );
  return c.json(file);
});

app.put("/agents/:agentId/brain/file", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFileWriteBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const result = await getAgentStub(c.env, agentId).brainWriteFile(parsed.data);
  return c.json(result);
});

app.delete("/agents/:agentId/brain/file", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFileQuery.safeParse({ path: c.req.query("path") });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const result = await getAgentStub(c.env, agentId).brainDeletePath(
    parsed.data.path,
  );
  return c.json(result);
});

app.get("/agents/:agentId/brain/archive", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainArchiveQuery.safeParse({ format: c.req.query("format") });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const { bytes, filename, contentType } = await getAgentStub(
    c.env,
    agentId,
  ).brainArchive(parsed.data.format ?? "tar");
  // Bytes come back as a Uint8Array over RPC; stream them as an attachment.
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// MNEMO-12 brain versioning (PRD §6.9): the brain's git history, per-file diffs,
// and one-click restore. Every operation is ownership-checked (404 for a non-owned
// id, no existence leak; requireAuth via the `/agents/:agentId/*` middleware) and
// MEDIATED BY THE DO (the route validates with Zod + clamps paging, the DO warms
// the sandbox and reads/commits git). The reads never warm the sandbox at the
// route layer - the DO does. Restore is the only state-changing route → POST.
//
//   GET  /agents/:agentId/brain/history?limit=&cursor=        - commit log (paged)
//   GET  /agents/:agentId/brain/history/file?path=&limit=&cursor= - one file's log
//   GET  /agents/:agentId/brain/diff?sha=                      - one commit's diff
//   GET  /agents/:agentId/brain/diff?path=&from=&to=           - one file's diff
//   GET  /agents/:agentId/brain/file-at?path=&sha=             - file @ a revision
//   POST /agents/:agentId/brain/restore  { path?, sha }        - restore (file/tree)
app.get("/agents/:agentId/brain/history", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainHistoryQuery.safeParse({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const limit = parsed.data.limit
    ? Math.min(parsed.data.limit, HISTORY_CAPS.maxLimit)
    : undefined;
  const page = await getAgentStub(c.env, agentId).brainHistory({
    limit,
    cursor: parsed.data.cursor,
  });
  return c.json(page);
});

app.get("/agents/:agentId/brain/history/file", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFileHistoryQuery.safeParse({
    path: c.req.query("path"),
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const limit = parsed.data.limit
    ? Math.min(parsed.data.limit, HISTORY_CAPS.maxLimit)
    : undefined;
  const page = await getAgentStub(c.env, agentId).brainFileHistory(
    parsed.data.path,
    { limit, cursor: parsed.data.cursor },
  );
  return c.json(page);
});

app.get("/agents/:agentId/brain/diff", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainDiffQuery.safeParse({
    sha: c.req.query("sha"),
    path: c.req.query("path"),
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const stub = getAgentStub(c.env, agentId);
  // The refinement guarantees exactly one mode is populated.
  if (parsed.data.sha) {
    return c.json(await stub.brainCommitDiff(parsed.data.sha));
  }
  return c.json(
    await stub.brainFileDiff(
      parsed.data.path as string,
      parsed.data.from as string,
      parsed.data.to,
    ),
  );
});

app.get("/agents/:agentId/brain/file-at", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainFileAtQuery.safeParse({
    path: c.req.query("path"),
    sha: c.req.query("sha"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const file = await getAgentStub(c.env, agentId).brainFileAt(
    parsed.data.path,
    parsed.data.sha,
  );
  return c.json(file);
});

app.post("/agents/:agentId/brain/restore", async (c) => {
  const agentId = c.req.param("agentId");
  const owned = await getAgentOwned(c.env, getAccountId(c), agentId);
  if (!owned) return c.json({ error: "not found" }, 404);

  const parsed = BrainRestoreBody.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid request", issues: parsed.error.issues },
      400,
    );
  }
  const stub = getAgentStub(c.env, agentId);
  // A `path` ⇒ single-file restore; absent ⇒ whole-tree restore.
  const result = parsed.data.path
    ? await stub.brainRestoreFile(parsed.data.path, parsed.data.sha)
    : await stub.brainRestoreTree(parsed.data.sha);
  return c.json(result);
});

/**
 * Worker `scheduled` (cron) entry point (MNEMO-27, PRD §8.5). Fired by the
 * `[triggers]` cron in wrangler.toml - the platform HEARTBEAT. Thin by design:
 * all logic lives in src/schedule/fanout.ts, which fans out to the agents that
 * are due. `ctx.waitUntil` lets the fan-out outlive the handler's return.
 *
 * NB: this does NOT fire under `wrangler dev` (§8.5) - that is exactly why the
 * prod-gated `POST /__dev/cron` trigger route exists (src/schedule/dev-routes.ts)
 * to simulate a tick locally.
 */
async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(runDueAgents(env, Date.now()));
}

// Re-export the DO classes so Wrangler registers them. `MnemosyneAgent` backs
// the `AGENT` binding; `AuditLog` backs the `AUDIT` binding (MNEMO-20);
// `ThreadCoordinator` backs the `THREAD` binding (MNEMO-48); `Sandbox` (the SDK's
// container DO) backs the `SANDBOX` binding - all declared in wrangler.toml.
// `getAgentStub`/`getAuditStub` are re-exported for callers that resolve a stub via
// the Worker entrypoint (`getAuditStub` now lives in `src/audit/index.ts` so the
// agent DO can import it without a circular import).
export { Sandbox } from "@cloudflare/sandbox";
export {
  AuditLog,
  getAgentStub,
  getAuditStub,
  MnemosyneAgent,
  ThreadCoordinator,
};

// The Worker now exports BOTH a `fetch` (the Hono app) and a `scheduled` (cron)
// handler (MNEMO-27), so the default export is the handler object rather than the
// bare Hono app. `app.fetch` keeps the same (request, env, ctx) signature tests
// and Wrangler call.
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
