/**
 * Typed D1 access layer for the relational backbone (accounts, agents, reports).
 *
 * Contract: Zod row schemas are the single source of truth for shapes, and every
 * read is parsed through them so a column rename or type drift fails loudly at
 * the boundary instead of leaking `unknown`. These are thin, parameterized CRUD
 * helpers - no business logic. App-generated UUID PKs (`crypto.randomUUID()`)
 * and ISO-8601 `created_at` are stamped here so call sites never repeat them.
 *
 * Per-agent chat/memory/audit state lives in DO SQLite, not D1 (PRD §7.4).
 */
import { z } from "zod";
// The document domain owns its row shape (DOCS-01); we import it here for the
// typed CRUD helpers, mirroring how ArtifactRow/ReportRow live in this module but
// keeping the dependency one-directional (documents/types imports only zod).
import {
  type DocumentRecord,
  DocumentRow,
  type DocumentStatus,
} from "../documents/types.ts";
import type { Env } from "../env.ts";

export type { DocumentRecord, DocumentRow } from "../documents/types.ts";

// ─── Row schemas (source of truth for shapes) ───────────────────────────────

export const AccountRow = z.object({
  id: z.string(),
  email: z.string(),
  // Owner profile (0012): the human the account's agents work for. All nullable
  // - added after launch, and the magic-link upsert only ever knows an email.
  // `timezone` is an IANA zone (e.g. 'America/Chicago'); NULL ⇒ render dates in
  // UTC. `owner_name`/`owner_notes` feed the persona's "about the person" layer.
  timezone: z.string().nullable().default(null),
  owner_name: z.string().nullable().default(null),
  owner_notes: z.string().nullable().default(null),
  created_at: z.string(),
});
export type AccountRow = z.infer<typeof AccountRow>;

/**
 * The owner-profile subset of an account, as the agent runtime and settings UI
 * consume it (never the email/id). The single shape passed end-to-end: D1 →
 * account route → per-agent DO ({@link MnemosyneAgent.updateOwnerProfile}) →
 * persona layer. All fields nullable so a half-filled profile round-trips.
 */
export interface AccountProfile {
  timezone: string | null;
  owner_name: string | null;
  owner_notes: string | null;
}

/** Patch for {@link updateAccountProfile}; omitted fields are left untouched. */
export type AccountProfileUpdate = Partial<AccountProfile>;

export const AgentTemplate = z.enum([
  "vendor",
  "product",
  "investor",
  "founder",
]);
export type AgentTemplate = z.infer<typeof AgentTemplate>;

export const AgentRow = z.object({
  id: z.string(),
  account_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  template: AgentTemplate.nullable(),
  system_prompt: z.string().nullable(),
  schedule_cron: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type AgentRow = z.infer<typeof AgentRow>;

export const ReportRow = z.object({
  id: z.string(),
  agent_id: z.string(),
  title: z.string(),
  r2_key: z.string(),
  front_matter: z.string().nullable(),
  created_at: z.string(),
});
export type ReportRow = z.infer<typeof ReportRow>;

// artifacts (0013): inline HTML views the renderHtml tool shows in the chat. Like
// reports, this is a metadata-only index over an R2 blob (`r2_key` is the prefix;
// the body lives at `<prefix>index.html`). `conversation_id` is the web-chat thread
// it was shown in (nullable - DO-SQLite threads aren't D1 rows, so it's not an FK).
export const ArtifactRow = z.object({
  id: z.string(),
  agent_id: z.string(),
  conversation_id: z.string().nullable(),
  title: z.string(),
  r2_key: z.string(),
  content_type: z.string(),
  byte_size: z.number(),
  created_at: z.string(),
});
export type ArtifactRow = z.infer<typeof ArtifactRow>;

// llm_profiles (MNEMO-13): per-account BYOK config. `provider` mirrors the
// migration's `TEXT NOT NULL` faithfully as a plain string - the closed
// LlmProvider set is enforced at WRITE time (ByokConfig / upsertLlmProfile), so
// a hand-edited or legacy unknown value degrades to the free default in
// getModel() rather than throwing here on read. `key_ref` is a handle to the
// stored secret (NOT the raw key - custody lands in MNEMO-14) and is INTERNAL
// to the resolver path: never surface it to a client.
export const LlmProfileRow = z.object({
  account_id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  key_ref: z.string().nullable(),
  // Per-account monthly spend cap in milli-USD (MNEMO-14); NULL = platform
  // default. Set via setSpendCap; read by getSpendCap.
  spend_cap_usd_milli: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type LlmProfileRow = z.infer<typeof LlmProfileRow>;

// llm_spend (MNEMO-14): per-account usage accounting over AI Gateway BYOK calls.
// One row per (account, billing window). `cost_usd_milli` is integer milli-USD.
export const LlmSpendRow = z.object({
  account_id: z.string(),
  period: z.string(),
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd_milli: z.number(),
  updated_at: z.string(),
});
export type LlmSpendRow = z.infer<typeof LlmSpendRow>;

// agent_numbers (MNEMO-02 `0004_messaging.sql`): the phone number(s) provisioned
// for an agent (Twilio, opt-in). `e164` is UNIQUE, so the inbound gateway
// (MNEMO-45) resolves a destination number to exactly one owning agent. Schema
// only - sender access control (whitelist / capability tiers) is enforced in app
// logic (MNEMO-47), NOT modeled by this row.
export const AgentNumberRow = z.object({
  agent_id: z.string(),
  e164: z.string(),
  provider: z.string(),
  // The Twilio IncomingPhoneNumber SID (MNEMO-47 `0007_a2p_10dlc.sql`), so the
  // messaging-disable flow can release the number. Nullable - a seeded/imported
  // number may not carry one.
  twilio_sid: z.string().nullable(),
  created_at: z.string(),
});
export type AgentNumberRow = z.infer<typeof AgentNumberRow>;

// message_whitelist (MNEMO-02 `0004_messaging.sql`): the per-agent allow-list of
// contacts permitted to MESSAGE the agent (MNEMO-47, PRD §9.6). The list gates
// only *acceptance* - the capability TIER (src/messaging/tiers.ts), not this row,
// is the real safety boundary on what private data the agent discloses. `scope`
// ('global' set by the owner, or 'group' written by permissive whitelist
// auto-expansion when a member is pulled into a group thread) is interpreted by
// app logic. A unique `(agent_id, contact_e164)` index makes adds idempotent.
export const WhitelistRow = z.object({
  agent_id: z.string(),
  contact_e164: z.string(),
  scope: z.string(),
  created_at: z.string(),
});
export type WhitelistRow = z.infer<typeof WhitelistRow>;

// a2p_brand / a2p_campaign (MNEMO-47 `0007_a2p_10dlc.sql`): the SHARED, org-level
// 10DLC registration state (PRD §9.1/§9.2). One brand + one campaign cover MANY
// agent numbers - these are NOT per-number rows; a provisioned number attaches to
// the active campaign. `status` is a plain string mirroring the migration's
// CHECK-constrained column so a legacy/unknown value reads back rather than
// throwing here; the closed set is enforced at write time.
export const A2pBrandRow = z.object({
  id: z.string(),
  twilio_brand_sid: z.string().nullable(),
  status: z.string(),
  kind: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type A2pBrandRow = z.infer<typeof A2pBrandRow>;

export const A2pCampaignRow = z.object({
  id: z.string(),
  brand_id: z.string(),
  twilio_campaign_sid: z.string().nullable(),
  use_case: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type A2pCampaignRow = z.infer<typeof A2pCampaignRow>;

// ─── Insert / update input shapes ────────────────────────────────────────────

export interface NewAccount {
  email: string;
}

export interface NewAgent {
  account_id: string;
  name: string;
  description?: string | null;
  template?: AgentTemplate | null;
  system_prompt?: string | null;
  schedule_cron?: string | null;
  status?: string; // defaults to 'active' when omitted
}

export type AgentUpdate = Partial<
  Pick<
    AgentRow,
    | "name"
    | "description"
    | "template"
    | "system_prompt"
    | "schedule_cron"
    | "status"
  >
>;

export interface NewReport {
  /**
   * App-generated PK. Optional: omit to mint one here, or pass a pre-minted id
   * when the caller derives a dependent key from it first (MNEMO-25 builds the R2
   * prefix `agents/<agentId>/reports/<id>/` BEFORE the insert, so the row id and
   * the prefix's id are the same UUID).
   */
  id?: string;
  agent_id: string;
  title: string;
  r2_key: string;
  front_matter?: string | null;
}

export interface NewArtifact {
  /** App-generated PK; the caller derives the R2 prefix from it BEFORE inserting,
   * so the row id and the prefix's id are the same UUID (mirrors {@link NewReport}). */
  id?: string;
  agent_id: string;
  /** The web-chat thread it was shown in, or null when produced outside a thread. */
  conversation_id?: string | null;
  title: string;
  r2_key: string;
  content_type: string;
  byte_size: number;
}

// ─── agent_documents (DOCS-01, uploaded-document metadata) ───────────────────

/** Insert input for an uploaded document. `id` is REQUIRED (the route mints it
 * first to derive the R2 key), and `created_at` (epoch-ms) is stamped here. */
export interface NewDocument {
  id: string;
  agent_id: string;
  account_id: string;
  discovery_id?: string | null;
  filename: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  r2_key: string;
  status: DocumentStatus;
  convert_method?: string | null;
  markdown_chars?: number | null;
  neuron_count?: number | null;
  source_slug?: string | null;
  error?: string | null;
}

/** Patch for {@link updateDocument}; only the listed columns are mutable. */
export type DocumentUpdate = Partial<
  Pick<
    DocumentRecord,
    | "status"
    | "discovery_id"
    | "convert_method"
    | "markdown_chars"
    | "neuron_count"
    | "source_slug"
    | "error"
  >
>;

// ─── accounts ─────────────────────────────────────────────────────────────────

export async function createAccount(
  env: Env,
  input: NewAccount,
): Promise<AccountRow> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) RETURNING *",
  )
    .bind(id, input.email, created_at)
    .first();
  return AccountRow.parse(row);
}

export async function getAccountByEmail(
  env: Env,
  email: string,
): Promise<AccountRow | null> {
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?")
    .bind(email)
    .first();
  return row ? AccountRow.parse(row) : null;
}

/**
 * Fetch a single account by id, or `null` if absent. Mirrors {@link getAgent}.
 * The report-notification glue (MNEMO-28) uses this to resolve an agent's owner
 * email (agent → `account_id` → `accounts.email`) for the "report ready" send.
 */
export async function getAccount(
  env: Env,
  id: string,
): Promise<AccountRow | null> {
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?")
    .bind(id)
    .first();
  return row ? AccountRow.parse(row) : null;
}

/**
 * Find an account by email or create it - the upsert magic-link auth needs at
 * both request and callback time. `email` is UNIQUE, so on the rare insert race
 * the loser's constraint violation is swallowed and the now-present row read.
 */
export async function findOrCreateAccount(
  env: Env,
  email: string,
): Promise<AccountRow> {
  const existing = await getAccountByEmail(env, email);
  if (existing) return existing;
  try {
    return await createAccount(env, { email });
  } catch {
    const row = await getAccountByEmail(env, email);
    if (row) return row;
    throw new Error(`failed to find or create account for ${email}`);
  }
}

// Fixed allow-list of updatable owner-profile columns - identifiers never come
// from caller input, so the dynamic SET clause cannot be injected.
const ACCOUNT_PROFILE_UPDATABLE = [
  "timezone",
  "owner_name",
  "owner_notes",
] as const satisfies readonly (keyof AccountProfileUpdate)[];

/**
 * Patch an account's owner profile (timezone / name / notes). Only the columns
 * present in `patch` are written, so a partial save preserves the rest; passing
 * `null` clears a field. Returns the updated row, or `null` if the account is
 * gone. Caller validates the timezone (a real IANA zone) at the route boundary.
 */
export async function updateAccountProfile(
  env: Env,
  id: string,
  patch: AccountProfileUpdate,
): Promise<AccountRow | null> {
  const cols = ACCOUNT_PROFILE_UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) return getAccount(env, id);

  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => patch[c] ?? null);
  const row = await env.DB.prepare(
    `UPDATE accounts SET ${setClause} WHERE id = ? RETURNING *`,
  )
    .bind(...values, id)
    .first();
  return row ? AccountRow.parse(row) : null;
}

// ─── agents ─────────────────────────────────────────────────────────────────

export async function createAgent(
  env: Env,
  input: NewAgent,
): Promise<AgentRow> {
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  // status is NOT NULL with a DB default; COALESCE applies that default here
  // since binding NULL would otherwise violate the constraint.
  const row = await env.DB.prepare(
    `INSERT INTO agents
       (id, account_id, name, description, template, system_prompt, schedule_cron, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'active'), ?)
     RETURNING *`,
  )
    .bind(
      id,
      input.account_id,
      input.name,
      input.description ?? null,
      input.template ?? null,
      input.system_prompt ?? null,
      input.schedule_cron ?? null,
      input.status ?? null,
      created_at,
    )
    .first();
  return AgentRow.parse(row);
}

export async function listAgentsByAccount(
  env: Env,
  accountId: string,
): Promise<AgentRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM agents WHERE account_id = ? ORDER BY created_at DESC",
  )
    .bind(accountId)
    .all();
  return results.map((r) => AgentRow.parse(r));
}

export async function getAgent(env: Env, id: string): Promise<AgentRow | null> {
  const row = await env.DB.prepare("SELECT * FROM agents WHERE id = ?")
    .bind(id)
    .first();
  return row ? AgentRow.parse(row) : null;
}

/** Narrow projection for the cron fan-out: just the columns it needs to decide
 * who is due (MNEMO-27). Kept minimal so the listing query stays cheap. */
export const ScheduledAgentRow = z.object({
  id: z.string(),
  schedule_cron: z.string(),
});
export type ScheduledAgentRow = z.infer<typeof ScheduledAgentRow>;

/**
 * List the agents the cron fan-out should consider (MNEMO-27): a live status
 * (`active` OR `operational`) with a non-null `schedule_cron`. This is the
 * cross-agent listing source the Worker `scheduled` heartbeat reads (PRD §8.5);
 * due-ness per agent is then decided by `isDue` against the platform-side
 * last-run marker - so this query never wakes a DO.
 *
 * NB: MNEMO-30 Build promotes a freshly-provisioned agent to `operational`, so
 * the filter MUST include it - otherwise the fan-out (the safety net for a DO
 * evicted before its own timer fired) would never wake a built agent.
 */
export async function listScheduledAgents(
  env: Env,
): Promise<ScheduledAgentRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, schedule_cron FROM agents WHERE status IN ('active', 'operational') AND schedule_cron IS NOT NULL",
  ).all();
  return results.map((r) => ScheduledAgentRow.parse(r));
}

// Fixed allow-list of updatable columns - identifiers are never taken from
// caller input, so the dynamic SET clause cannot be injected.
const AGENT_UPDATABLE = [
  "name",
  "description",
  "template",
  "system_prompt",
  "schedule_cron",
  "status",
] as const satisfies readonly (keyof AgentUpdate)[];

export async function updateAgent(
  env: Env,
  id: string,
  patch: AgentUpdate,
): Promise<AgentRow | null> {
  const cols = AGENT_UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) return getAgent(env, id);

  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => patch[c] ?? null);
  const row = await env.DB.prepare(
    `UPDATE agents SET ${setClause} WHERE id = ? RETURNING *`,
  )
    .bind(...values, id)
    .first();
  return row ? AgentRow.parse(row) : null;
}

/**
 * Hard-delete an agent and the dependent rows that reference it, as one atomic
 * `batch`. D1 DOES enforce the `REFERENCES agents (id)` foreign keys (none use
 * ON DELETE CASCADE), so every table pointing at the agent must be cleared
 * BEFORE the `agents` row is deleted or the final statement throws a constraint
 * violation. The statements run in order within the batch's transaction, so the
 * `agents` delete is last.
 *
 * `usage_events` is the one exception: it is the append-only billing ledger
 * (migration 0011) we never delete, so an account's spend history outlives the
 * agent that incurred it. Its `agent_id` is nullable, so we DETACH the ledger
 * rows (set `agent_id = NULL`) instead of deleting them - this clears the FK
 * that would otherwise block the `agents` delete while keeping `account_id` +
 * `cost_cents` + `period` intact for account-level billing reconciliation. (The
 * per-agent rollup loses attribution, which is moot once the agent is gone.)
 *
 * Caller is responsible for ownership (the service 404s a non-owned agent
 * before reaching here) and for the non-D1 teardown (the per-agent DO state +
 * R2 objects), which live outside this relational layer.
 */
export async function deleteAgent(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reports WHERE agent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM artifacts WHERE agent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM agent_documents WHERE agent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM agent_numbers WHERE agent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM message_whitelist WHERE agent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM addons WHERE agent_id = ?").bind(id),
    // Detach (don't delete) the append-only billing ledger; clears the FK.
    env.DB.prepare(
      "UPDATE usage_events SET agent_id = NULL WHERE agent_id = ?",
    ).bind(id),
    env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(id),
  ]);
}

// ─── reports ─────────────────────────────────────────────────────────────────

export async function createReport(
  env: Env,
  input: NewReport,
): Promise<ReportRow> {
  const id = input.id ?? crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO reports (id, agent_id, title, r2_key, front_matter, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      id,
      input.agent_id,
      input.title,
      input.r2_key,
      input.front_matter ?? null,
      created_at,
    )
    .first();
  return ReportRow.parse(row);
}

export async function listReportsByAgent(
  env: Env,
  agentId: string,
): Promise<ReportRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM reports WHERE agent_id = ? ORDER BY created_at DESC",
  )
    .bind(agentId)
    .all();
  return results.map((r) => ReportRow.parse(r));
}

/**
 * Fetch a single report row by id, or `null` if absent. Mirrors {@link getAgent}.
 * Ownership is the CALLER's concern (compare `agent_id`) - the retrieval helpers
 * in `src/reports/archive.ts` use this to resolve a report's R2 prefix and 404 a
 * report that belongs to a different agent (no existence leak).
 */
export async function getReport(
  env: Env,
  id: string,
): Promise<ReportRow | null> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?")
    .bind(id)
    .first();
  return row ? ReportRow.parse(row) : null;
}

// ─── artifacts (0013, inline HTML chat views) ─────────────────────────────────

export async function createArtifact(
  env: Env,
  input: NewArtifact,
): Promise<ArtifactRow> {
  const id = input.id ?? crypto.randomUUID();
  const created_at = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO artifacts
       (id, agent_id, conversation_id, title, r2_key, content_type, byte_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      id,
      input.agent_id,
      input.conversation_id ?? null,
      input.title,
      input.r2_key,
      input.content_type,
      input.byte_size,
      created_at,
    )
    .first();
  return ArtifactRow.parse(row);
}

/** List an agent's artifacts (newest first). Metadata only - never enumerates R2. */
export async function listArtifactsByAgent(
  env: Env,
  agentId: string,
): Promise<ArtifactRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM artifacts WHERE agent_id = ? ORDER BY created_at DESC",
  )
    .bind(agentId)
    .all();
  return results.map((r) => ArtifactRow.parse(r));
}

/**
 * Fetch a single artifact row by id, or `null` if absent. Ownership is the
 * CALLER's concern (compare `agent_id`) - the retrieval helper in
 * `src/artifacts/store.ts` 404s an artifact owned by a different agent (no leak).
 */
export async function getArtifact(
  env: Env,
  id: string,
): Promise<ArtifactRow | null> {
  const row = await env.DB.prepare("SELECT * FROM artifacts WHERE id = ?")
    .bind(id)
    .first();
  return row ? ArtifactRow.parse(row) : null;
}

// ─── agent_documents (DOCS-01, uploaded-document metadata) ───────────────────

/** Insert a document metadata row. `id` is caller-minted; `created_at` is epoch-ms. */
export async function createDocument(
  env: Env,
  input: NewDocument,
): Promise<DocumentRecord> {
  const row = await env.DB.prepare(
    `INSERT INTO agent_documents
       (id, agent_id, account_id, discovery_id, filename, mime_type, size_bytes,
        r2_key, status, convert_method, markdown_chars, neuron_count, source_slug,
        error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(
      input.id,
      input.agent_id,
      input.account_id,
      input.discovery_id ?? null,
      input.filename,
      input.mime_type ?? null,
      input.size_bytes ?? null,
      input.r2_key,
      input.status,
      input.convert_method ?? null,
      input.markdown_chars ?? null,
      input.neuron_count ?? null,
      input.source_slug ?? null,
      input.error ?? null,
      Date.now(),
    )
    .first();
  return DocumentRow.parse(row);
}

/** Fetch a single document row by id, or null. Ownership is the caller's concern. */
export async function getDocumentById(
  env: Env,
  id: string,
): Promise<DocumentRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM agent_documents WHERE id = ?")
    .bind(id)
    .first();
  return row ? DocumentRow.parse(row) : null;
}

/** List an agent's documents, newest first (metadata only - never enumerates R2). */
export async function listDocumentsByAgent(
  env: Env,
  agentId: string,
): Promise<DocumentRecord[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM agent_documents WHERE agent_id = ? ORDER BY created_at DESC",
  )
    .bind(agentId)
    .all();
  return results.map((r) => DocumentRow.parse(r));
}

/**
 * The `converted` documents attached to an agent (uploaded before Build), oldest
 * first - the set the Build pass drains and seeds into the now-live brain.
 */
export async function listConvertedDocumentsByAgent(
  env: Env,
  agentId: string,
): Promise<DocumentRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM agent_documents
     WHERE agent_id = ? AND status = 'converted' ORDER BY created_at ASC`,
  )
    .bind(agentId)
    .all();
  return results.map((r) => DocumentRow.parse(r));
}

// Fixed allow-list of mutable document columns - identifiers never come from
// caller input, so the dynamic SET clause cannot be injected.
const DOCUMENT_UPDATABLE = [
  "status",
  "discovery_id",
  "convert_method",
  "markdown_chars",
  "neuron_count",
  "source_slug",
  "error",
] as const satisfies readonly (keyof DocumentUpdate)[];

/**
 * Patch a document row (status transitions, neuron counts, error). Only columns
 * present in `patch` are written; passing `null` clears one. Returns the updated
 * row, or null if the document is gone.
 */
export async function updateDocument(
  env: Env,
  id: string,
  patch: DocumentUpdate,
): Promise<DocumentRecord | null> {
  const cols = DOCUMENT_UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) return getDocumentById(env, id);

  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => patch[c] ?? null);
  const row = await env.DB.prepare(
    `UPDATE agent_documents SET ${setClause} WHERE id = ? RETURNING *`,
  )
    .bind(...values, id)
    .first();
  return row ? DocumentRow.parse(row) : null;
}

/** Delete a document metadata row. The R2 blobs are dropped by the store layer. */
export async function deleteDocumentRow(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM agent_documents WHERE id = ?")
    .bind(id)
    .run();
}

// ─── llm_profiles ─────────────────────────────────────────────────────────────

/** Upsert input for an account's BYOK profile. `keyRef` is a handle to the
 * stored secret (NOT the raw key); secret custody lands in MNEMO-14, so callers
 * pass a placeholder for now. `model`/`keyRef` are null for the free default. */
export interface LlmProfileUpsert {
  provider: string;
  model?: string | null;
  keyRef?: string | null;
}

/**
 * Read an account's LLM profile, or null when it has never set one (→ the free
 * Workers AI default applies). Parsed through {@link LlmProfileRow}. The row
 * includes `key_ref`, which is INTERNAL to the resolver path - never hand this
 * row straight to a client; surface only provider/model + a `hasKey` boolean.
 */
export async function getLlmProfile(
  env: Env,
  accountId: string,
): Promise<LlmProfileRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM llm_profiles WHERE account_id = ?",
  )
    .bind(accountId)
    .first();
  return row ? LlmProfileRow.parse(row) : null;
}

/**
 * Insert-or-update an account's LLM profile, stamping `updated_at` (and
 * `created_at` on first write). SQLite UPSERT keeps the original `created_at`
 * on conflict. Returns the persisted row (parsed). Typed CRUD only - provider
 * validation is the caller's job (ByokConfig at the route boundary).
 */
export async function upsertLlmProfile(
  env: Env,
  accountId: string,
  input: LlmProfileUpsert,
): Promise<LlmProfileRow> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO llm_profiles (account_id, provider, model, key_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       provider   = excluded.provider,
       model      = excluded.model,
       key_ref    = excluded.key_ref,
       updated_at = excluded.updated_at
     RETURNING *`,
  )
    .bind(
      accountId,
      input.provider,
      input.model ?? null,
      input.keyRef ?? null,
      now,
      now,
    )
    .first();
  return LlmProfileRow.parse(row);
}

// ─── llm_spend (MNEMO-14) ─────────────────────────────────────────────────────

/**
 * Platform default monthly spend cap (milli-USD = $0.001 units) applied when an
 * account has not set its own `spend_cap_usd_milli`. Conservative on purpose -
 * BYOK billing is the user's money, and an unbounded loop is the dangerous case
 * (PRD §7.2). $5.00/mo; raise per-account via setSpendCap.
 */
export const DEFAULT_SPEND_CAP_USD_MILLI = 5_000;

/** Accumulation delta for {@link addSpend} (one turn's measured usage). */
export interface SpendDelta {
  tokensIn: number;
  tokensOut: number;
  costUsdMilli: number;
}

/**
 * Read an account's spend for a billing `period`, or a zeroed default when it
 * has no row yet. Typed CRUD - the cap comparison lives in `assertUnderCap`.
 */
export async function getSpend(
  env: Env,
  accountId: string,
  period: string,
): Promise<LlmSpendRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM llm_spend WHERE account_id = ? AND period = ?",
  )
    .bind(accountId, period)
    .first();
  if (row) return LlmSpendRow.parse(row);
  return {
    account_id: accountId,
    period,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd_milli: 0,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Upsert-accumulate a turn's usage into the account's `(period)` row, stamping
 * `updated_at`. SQLite UPSERT on the `(account_id, period)` unique index adds the
 * deltas to the existing totals. Returns the persisted row.
 */
export async function addSpend(
  env: Env,
  accountId: string,
  period: string,
  delta: SpendDelta,
): Promise<LlmSpendRow> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO llm_spend (account_id, period, tokens_in, tokens_out, cost_usd_milli, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, period) DO UPDATE SET
       tokens_in      = tokens_in + excluded.tokens_in,
       tokens_out     = tokens_out + excluded.tokens_out,
       cost_usd_milli = cost_usd_milli + excluded.cost_usd_milli,
       updated_at     = excluded.updated_at
     RETURNING *`,
  )
    .bind(
      accountId,
      period,
      delta.tokensIn,
      delta.tokensOut,
      delta.costUsdMilli,
      now,
    )
    .first();
  return LlmSpendRow.parse(row);
}

/**
 * The effective monthly cap (milli-USD) for an account: its own
 * `llm_profiles.spend_cap_usd_milli`, or {@link DEFAULT_SPEND_CAP_USD_MILLI} when
 * unset / no profile row exists.
 */
export async function getSpendCap(
  env: Env,
  accountId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT spend_cap_usd_milli FROM llm_profiles WHERE account_id = ?",
  )
    .bind(accountId)
    .first<{ spend_cap_usd_milli: number | null }>();
  return row?.spend_cap_usd_milli ?? DEFAULT_SPEND_CAP_USD_MILLI;
}

/**
 * Set (or clear, with `null`) an account's monthly cap. Touches ONLY
 * `spend_cap_usd_milli` - on an existing profile the provider/model/key_ref are
 * preserved; with no profile it inserts a workers-ai default row carrying the
 * cap, so a free-tier account can still pin a ceiling before going BYOK.
 */
export async function setSpendCap(
  env: Env,
  accountId: string,
  usdMilli: number | null,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO llm_profiles (account_id, provider, model, key_ref, spend_cap_usd_milli, created_at, updated_at)
     VALUES (?, 'workers-ai', NULL, NULL, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       spend_cap_usd_milli = excluded.spend_cap_usd_milli,
       updated_at          = excluded.updated_at`,
  )
    .bind(accountId, usdMilli, now, now)
    .run();
}

// ─── agent_numbers (MNEMO-45) ─────────────────────────────────────────────────

/**
 * Resolve a provisioned number (E.164) to its owning agent id, or `null` when no
 * agent owns it. The inbound messaging gateway (MNEMO-45) calls this to route a
 * Twilio webhook's destination number to the per-agent DO. `e164` is UNIQUE, so
 * at most one row matches. Typed lookup only - no business logic; sender access
 * control (whitelist / capability tiers) is enforced in MNEMO-47, not here.
 */
export async function getAgentIdByNumber(
  env: Env,
  e164: string,
): Promise<string | null> {
  const row = await env.DB.prepare("SELECT * FROM agent_numbers WHERE e164 = ?")
    .bind(e164)
    .first();
  return row ? AgentNumberRow.parse(row).agent_id : null;
}

// ─── message_whitelist (MNEMO-47, PRD §9.6) ───────────────────────────────────
// The allow-list gates *acceptance* only; the capability tier (not this row) is
// the real disclosure boundary (src/messaging/tiers.ts). Typed CRUD - the access
// decision + permissive group auto-expansion live in src/messaging/access.ts.

/**
 * Is `contactE164` on `agentId`'s whitelist? A bounded existence check (the unique
 * `(agent_id, contact_e164)` index means at most one row). Used by `decideAccess`
 * to resolve a non-owner, non-group sender to the `known_contact` tier.
 */
export async function isWhitelisted(
  env: Env,
  agentId: string,
  contactE164: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM message_whitelist WHERE agent_id = ? AND contact_e164 = ? LIMIT 1",
  )
    .bind(agentId, contactE164)
    .first();
  return row !== null;
}

/**
 * Add a contact to an agent's whitelist, IDEMPOTENTLY: `INSERT OR IGNORE` on the
 * unique `(agent_id, contact_e164)` index, so re-adding the same contact (e.g. the
 * permissive group auto-expansion re-running) is a no-op rather than a constraint
 * error. `scope` defaults to `'global'` (an owner-added contact); group
 * auto-expansion passes `'group'`. Typed CRUD only.
 */
export async function addToWhitelist(
  env: Env,
  agentId: string,
  contactE164: string,
  scope = "global",
): Promise<void> {
  const created_at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_whitelist (agent_id, contact_e164, scope, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(agentId, contactE164, scope, created_at)
    .run();
}

/** List an agent's whitelist (newest first), parsed through {@link WhitelistRow}. */
export async function listWhitelist(
  env: Env,
  agentId: string,
): Promise<WhitelistRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM message_whitelist WHERE agent_id = ? ORDER BY created_at DESC",
  )
    .bind(agentId)
    .all();
  return results.map((r) => WhitelistRow.parse(r));
}

/** Remove a contact from an agent's whitelist (no-op if absent). */
export async function removeFromWhitelist(
  env: Env,
  agentId: string,
  contactE164: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM message_whitelist WHERE agent_id = ? AND contact_e164 = ?",
  )
    .bind(agentId, contactE164)
    .run();
}

// ─── agent_numbers writes (MNEMO-47) ──────────────────────────────────────────
// The write side of the number registry (`getAgentIdByNumber` above is the read
// side, MNEMO-45). One provisioned number per agent (PRD §9.1); the unique `e164`
// index already prevents two agents claiming the same number.

/**
 * Record a provisioned number for an agent (MNEMO-47 provisioning). `twilioNumberSid`
 * is the Twilio IncomingPhoneNumber SID, stored so the disable flow can release it.
 * Returns the persisted row (parsed). `provider` is `'twilio'` (the only channel).
 */
export async function addAgentNumber(
  env: Env,
  agentId: string,
  e164: string,
  twilioNumberSid?: string | null,
): Promise<AgentNumberRow> {
  const created_at = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO agent_numbers (agent_id, e164, provider, twilio_sid, created_at)
     VALUES (?, ?, 'twilio', ?, ?) RETURNING *`,
  )
    .bind(agentId, e164, twilioNumberSid ?? null, created_at)
    .first();
  return AgentNumberRow.parse(row);
}

/**
 * The agent's provisioned number, or `null` if it has none. ≤1 per agent (PRD
 * §9.1), so the most-recent row is returned for the rare case of more than one.
 * The `messaging-status`/`disable` flows read this (the SID drives the release).
 */
export async function getAgentNumber(
  env: Env,
  agentId: string,
): Promise<AgentNumberRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM agent_numbers WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(agentId)
    .first();
  return row ? AgentNumberRow.parse(row) : null;
}

/** Remove an agent's number row(s) (after releasing it at Twilio). No-op if absent. */
export async function removeAgentNumber(
  env: Env,
  agentId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM agent_numbers WHERE agent_id = ?")
    .bind(agentId)
    .run();
}

// ─── A2P 10DLC: shared brand + campaign (MNEMO-47, PRD §9.1/§9.2) ──────────────
// Brand + campaign are SHARED, org-level resources - one of each covers many agent
// numbers (NOT per-number). The brand is a singleton keyed by SHARED_BRAND_ID;
// campaigns live under it. Typed CRUD only - the Twilio onboarding orchestration
// (create/submit/poll) lives in src/messaging/a2p.ts.

/** The singleton shared-brand row id (one org → one brand, §9.2). */
export const SHARED_BRAND_ID = "default";

/** Patch for {@link updateBrand}. */
export interface BrandUpdate {
  twilio_brand_sid?: string | null;
  status?: string;
  kind?: string;
}

/** Patch for {@link updateCampaign}. */
export interface CampaignUpdate {
  twilio_campaign_sid?: string | null;
  use_case?: string | null;
  status?: string;
}

/**
 * Get the shared brand, creating it (`status: 'pending'`) on first call. Idempotent
 * via `INSERT OR IGNORE` on the singleton id, so concurrent first-time callers
 * converge on one row. `kind` defaults to `sole_prop` (the low-friction §9.2 path).
 */
export async function getOrCreateBrand(
  env: Env,
  kind = "sole_prop",
): Promise<A2pBrandRow> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO a2p_brand (id, twilio_brand_sid, status, kind, created_at, updated_at)
     VALUES (?, NULL, 'pending', ?, ?, ?)`,
  )
    .bind(SHARED_BRAND_ID, kind, now, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM a2p_brand WHERE id = ?")
    .bind(SHARED_BRAND_ID)
    .first();
  return A2pBrandRow.parse(row);
}

/** Read the shared brand WITHOUT creating it (the read-only status path). */
export async function getBrand(env: Env): Promise<A2pBrandRow | null> {
  const row = await env.DB.prepare("SELECT * FROM a2p_brand WHERE id = ?")
    .bind(SHARED_BRAND_ID)
    .first();
  return row ? A2pBrandRow.parse(row) : null;
}

// Fixed allow-list of updatable brand columns (identifiers never come from input).
const BRAND_UPDATABLE = [
  "twilio_brand_sid",
  "status",
  "kind",
] as const satisfies readonly (keyof BrandUpdate)[];

/** Patch the shared brand (sid/status/kind), stamping `updated_at`. */
export async function updateBrand(
  env: Env,
  id: string,
  patch: BrandUpdate,
): Promise<A2pBrandRow | null> {
  const cols = BRAND_UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) {
    const row = await env.DB.prepare("SELECT * FROM a2p_brand WHERE id = ?")
      .bind(id)
      .first();
    return row ? A2pBrandRow.parse(row) : null;
  }
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => patch[c] ?? null);
  const row = await env.DB.prepare(
    `UPDATE a2p_brand SET ${setClause}, updated_at = ? WHERE id = ? RETURNING *`,
  )
    .bind(...values, new Date().toISOString(), id)
    .first();
  return row ? A2pBrandRow.parse(row) : null;
}

/** Insert input for {@link createCampaign}. */
export interface NewCampaign {
  id?: string;
  brand_id: string;
  use_case?: string | null;
}

/**
 * Create a campaign under a brand (`status: 'pending'`). The companion to
 * {@link getActiveCampaign} the campaign onboarding (a2p.ts `ensureCampaign`) calls
 * when no campaign exists yet.
 */
export async function createCampaign(
  env: Env,
  input: NewCampaign,
): Promise<A2pCampaignRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO a2p_campaign (id, brand_id, twilio_campaign_sid, use_case, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'pending', ?, ?) RETURNING *`,
  )
    .bind(id, input.brand_id, input.use_case ?? null, now, now)
    .first();
  return A2pCampaignRow.parse(row);
}

/**
 * The active (most-recent) campaign under the shared brand, or `null` if none has
 * been created. The enable flow gates on this (a number can't be provisioned until
 * the shared campaign is at least submitted, §9.1).
 */
export async function getActiveCampaign(
  env: Env,
): Promise<A2pCampaignRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM a2p_campaign WHERE brand_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(SHARED_BRAND_ID)
    .first();
  return row ? A2pCampaignRow.parse(row) : null;
}

// Fixed allow-list of updatable campaign columns.
const CAMPAIGN_UPDATABLE = [
  "twilio_campaign_sid",
  "use_case",
  "status",
] as const satisfies readonly (keyof CampaignUpdate)[];

/** Patch a campaign (sid/use_case/status), stamping `updated_at`. */
export async function updateCampaign(
  env: Env,
  id: string,
  patch: CampaignUpdate,
): Promise<A2pCampaignRow | null> {
  const cols = CAMPAIGN_UPDATABLE.filter((c) => patch[c] !== undefined);
  if (cols.length === 0) {
    const row = await env.DB.prepare("SELECT * FROM a2p_campaign WHERE id = ?")
      .bind(id)
      .first();
    return row ? A2pCampaignRow.parse(row) : null;
  }
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => patch[c] ?? null);
  const row = await env.DB.prepare(
    `UPDATE a2p_campaign SET ${setClause}, updated_at = ? WHERE id = ? RETURNING *`,
  )
    .bind(...values, new Date().toISOString(), id)
    .first();
  return row ? A2pCampaignRow.parse(row) : null;
}
