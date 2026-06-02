/**
 * Cloudflare Worker bindings for Mnemosyne.
 *
 * Bindings are added per-phase (KV `SESSIONS`, R2 `BRAIN_BUCKET`, Durable Object
 * `AGENT`, `SANDBOX`, `AI`, `SELF`). Each has a matching stub in `wrangler.toml`.
 */
import type { Sandbox } from "@cloudflare/sandbox";
import type { MnemosyneAgent } from "./agent/index.ts";
import type { AuditLog } from "./audit/index.ts";
import type { ThreadCoordinator } from "./messaging/ThreadCoordinator.ts";

export interface Env {
  /** Relational backbone: accounts, agent registry, report metadata. Added MNEMO-02. */
  DB: D1Database;

  /** Magic-link token hashes + opaque sessions (TTL keys). Added MNEMO-03. */
  SESSIONS: KVNamespace;

  /**
   * Platform-side "last scheduled run" marker for the cron fan-out (PRD §7.4).
   * Keyed `lastrun:<agentId>` → epoch-ms string, so the Worker `scheduled`
   * heartbeat can decide who is due WITHOUT waking each agent's DO to check.
   * Distinct from the DO's own `agent_meta` lastRunAt (used to chain
   * `this.schedule`). Added MNEMO-27.
   */
  SCHEDULE_KV: KVNamespace;

  /** Resend API key for transactional email (magic links). Wrangler secret. Added MNEMO-03. */
  RESEND_API_KEY: string;

  /** Public origin used to build magic-link callback URLs. Added MNEMO-03. */
  APP_BASE_URL: string;

  /**
   * Deployment environment name (plain `[vars]`). Gates the dev-only schedule
   * trigger routes (src/schedule/dev-routes.ts) - any value other than
   * `"production"` enables them, because cron does NOT fire under `wrangler dev`
   * (§8.5). The deployed Worker MUST set this to `"production"` so those triggers
   * are inert. Added MNEMO-27.
   */
  ENVIRONMENT: string;

  /** Per-agent "always-home" DO: chat history, settings, schedule, memory index. Added MNEMO-04. */
  AGENT: DurableObjectNamespace<MnemosyneAgent>;

  /**
   * Per-agent audit-log DO - the "glass cockpit" event stream (PRD §7.4/§8.6).
   * A DEDICATED namespace, separate from `AGENT`: one `AuditLog` instance per
   * agent via `env.AUDIT.idFromName(agentId)`, so the append-only audit index
   * (DO SQLite + FTS5) is queryable WITHOUT waking the agent loop. Wraps the
   * untouched `src/audit` spike (store/types). Added MNEMO-20.
   */
  AUDIT: DurableObjectNamespace<AuditLog>;

  /**
   * Per-group-thread coordinator DO - the multi-agent group orchestrator (PRD
   * §9.4). A DEDICATED namespace, separate from `AGENT`/`AUDIT`: one
   * `ThreadCoordinator` instance per group thread via
   * `env.THREAD.idFromName(threadId)`. It fans each inbound message to every
   * member agent's cheap Haiku triage gate, runs floor control (top 1–2 bids
   * reply), honors @-mention overrides, and prevents agent↔agent runaway. The
   * agent DOs still own identity/memory/tools; the coordinator only orchestrates.
   * Added MNEMO-48.
   */
  THREAD: DurableObjectNamespace<ThreadCoordinator>;

  /**
   * Per-agent Cloudflare Sandbox - an isolated Linux container that is the
   * agent's computer (run-command / readFile / writeFile; PRD §7.3). The SDK's
   * `Sandbox` DO class is re-exported from src/index.ts for Wrangler; one
   * instance per agent via getSandbox(env.SANDBOX, agentId). Added MNEMO-06.
   */
  SANDBOX: DurableObjectNamespace<Sandbox>;

  /**
   * Durable R2 layer the brain FS persists to across sandbox sleeps (§8.4).
   * Objects are keyed under `brains/<agentId>/`. Added MNEMO-06.
   */
  BRAIN_BUCKET: R2Bucket;

  /**
   * Durable store of record for published reports - the §7.4 "report/PNG blobs"
   * bucket. One prefix per report (`agents/<agentId>/reports/<reportId>/`) holds
   * `report.md` + `assets/*.png`; D1 `reports` carries only the metadata index.
   * Kept SEPARATE from {@link BRAIN_BUCKET} so report retention can differ from
   * the brain snapshots. Added MNEMO-25.
   */
  REPORTS_BUCKET: R2Bucket;

  /** Original uploaded documents (DOCS-01): the user's source files (PDF/docx/…)
   * before/after `env.AI.toMarkdown` conversion, keyed
   * `agents/<agentId>/documents/<docId>/…`. Kept SEPARATE from the brain/report
   * buckets so upload retention can differ; D1 `agent_documents` holds the index. */
  DOCUMENTS_BUCKET: R2Bucket;

  /**
   * Workers AI - the zero-secret free default the per-user model resolver
   * (`src/llm/getModel.ts`) falls back to: `@cf/qwen/qwen3-30b-a3b-fp8`
   * (PRD §7.2). BYOK providers (OpenRouter/Anthropic/OpenAI) bypass this and
   * carry their own key. Added MNEMO-13.
   */
  AI: Ai;

  /**
   * Cloudflare account id that owns the AI Gateway, and the gateway's name.
   * Set as plain `[vars]` in wrangler.toml. When `AI_GATEWAY_ACCOUNT_ID` is
   * non-empty the resolver routes BYOK providers through
   * `https://gateway.ai.cloudflare.com/v1/{id}/{name}/{provider}` for caching,
   * request logs, and per-user spend caps (PRD §7.2); empty ⇒ hit the provider
   * directly. Added MNEMO-14.
   */
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_NAME: string;

  /**
   * Master key for BYOK secret custody (PRD §6.1). A Wrangler SECRET - provision
   * with `wrangler secret put KEY_ENCRYPTION_SECRET`; NEVER commit it. `secrets.ts`
   * derives an AES-GCM key from it to encrypt every stored provider key at rest
   * and is the only thing that can decrypt them in-process before constructing a
   * provider. Replaces the MNEMO-13 single-tenant env placeholders. Added MNEMO-14.
   */
  KEY_ENCRYPTION_SECRET: string;

  /**
   * Web-search backend config (MNEMO-17, PRD §6.3). Provider-neutral so the
   * backend swaps without touching tool code: `PROVIDER` names the adapter and
   * `ENDPOINT` is the search API URL (both plain `[vars]`). When any of the three
   * is empty/unset, `webSearch` returns a typed "search not configured" error.
   */
  WEB_SEARCH_PROVIDER: string;
  WEB_SEARCH_ENDPOINT: string;

  /**
   * API key for the web-search backend. A Wrangler SECRET (NOT a `[vars]` entry).
   * Provision with `wrangler secret put WEB_SEARCH_API_KEY`. Added MNEMO-17.
   */
  WEB_SEARCH_API_KEY: string;

  /**
   * Twilio account SID - the messaging channel's HTTP Basic auth username and the
   * `${apiBase}/2010-04-01/Accounts/${SID}/Messages.json` path segment for outbound
   * SMS (src/messaging/TwilioSmsChannel.ts). A Wrangler SECRET; provision with
   * `wrangler secret put TWILIO_ACCOUNT_SID`. Track H paid add-on. Added MNEMO-44.
   */
  TWILIO_ACCOUNT_SID: string;

  /**
   * Twilio auth token - the HTTP Basic auth password for outbound SMS AND the HMAC
   * key for validating the `X-Twilio-Signature` on inbound webhooks (PRD §9.6). A
   * Wrangler SECRET; provision with `wrangler secret put TWILIO_AUTH_TOKEN`. Added MNEMO-44.
   */
  TWILIO_AUTH_TOKEN: string;

  /**
   * Base URL of the Twilio REST API (plain `[vars]`, defaults to
   * `https://api.twilio.com`). Repointable at a test/mock host without a code
   * change. Added MNEMO-44.
   */
  TWILIO_API_BASE: string;

  /**
   * The "clear flag" gating SMS group threads (MNEMO-48, PRD §9.4). SMS has NO
   * native group thread (MNEMO-44 `capabilities.group=false`), so the gateway only
   * derives an app-side group `threadId` from the participant set when this is set
   * to `"enabled"`; otherwise every inbound is treated as 1:1 (the default). A
   * group-capable transport that supplies its OWN native thread id bypasses this
   * flag. Plain `[vars]`. Added MNEMO-48.
   */
  MESSAGING_SMS_GROUPS: string;

  /**
   * Per-account sandbox concurrency-slot leases (MNEMO-49). KV holds one
   * `lease:<accountId>:<leaseId>` key per live container (TTL-expiring safety),
   * so the admission gate can count active sandboxes WITHOUT waking each agent's
   * DO. KV is eventually-consistent → a SOFT cost bound, not a security boundary
   * (PRD §8.4). Added MNEMO-49.
   */
  LIMITS: KVNamespace;

  /**
   * Stripe secret API key (a Wrangler SECRET, NOT a `[vars]` entry). Its presence
   * selects the live {@link import("./billing/provider.ts").StripeBillingProvider}
   * over the deterministic fake; absent (tests / `wrangler dev`) ⇒ the fake. Never
   * commit it - provision with `wrangler secret put STRIPE_SECRET_KEY`. Added MNEMO-49.
   */
  STRIPE_SECRET_KEY?: string;

  /**
   * Stripe webhook signing secret (a Wrangler SECRET). Used by the live provider
   * to verify the `Stripe-Signature` on the unauthenticated `POST /billing/webhook`
   * before trusting the payload. Provision with
   * `wrangler secret put STRIPE_WEBHOOK_SECRET`. Added MNEMO-49.
   */
  STRIPE_WEBHOOK_SECRET?: string;

  /**
   * Static-asset server for the built frontend SPA (`frontend/dist`), declared via
   * `[assets]` in wrangler.toml. Worker-deploy glue added AFTER the MNEMO build
   * phases (which shipped the SPA and the API but never wired the frontend into a
   * deploy). It lets the UI and API share ONE origin: real asset files are served
   * by the platform before the Worker runs; the Worker serves the SPA shell on
   * browser navigations and lets `fetch()`/XHR fall through to the API on shared
   * paths (e.g. `GET /agents`). One origin keeps the `SameSite=Lax` session cookie
   * intact (no CORS, no `SameSite=None`).
   */
  ASSETS: Fetcher;
}
