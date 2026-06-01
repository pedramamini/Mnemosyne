/**
 * HTML artifact archive + retrieval (renderHtml tool, PRD §6.4 lineage).
 *
 * An "artifact" is a self-contained HTML document the agent renders inline into
 * the chat (the {@link "../tools/registry.ts"!} `renderHtml` tool). It is stored
 * exactly like a report (`src/reports/archive.ts`) so the durability + ownership
 * story is identical and we provision NO new infrastructure:
 *
 *   - One R2 prefix per artifact - `agents/<agentId>/artifacts/<artifactId>/` -
 *     holding a single `index.html`. The prefix is derived from `agentId`/
 *     `artifactId` ONLY (never model/user input), so a hostile title can't shape
 *     an R2 key. We REUSE `REPORTS_BUCKET` under this distinct prefix rather than
 *     standing up a second bucket (reports use `.../reports/...`; no collision).
 *   - A D1 `artifacts` row (0013 `createArtifact`) carrying `r2_key` = the prefix.
 *     D1 holds metadata ONLY (no blob) so the chat surface / a future gallery
 *     never enumerates R2.
 *
 * The read side ({@link getHtmlArtifact}) is the inverse: resolve the
 * ownership-checked D1 record, derive the `index.html` key off its prefix, and
 * return the R2 body (or null - a missing OR non-owned id is indistinguishable,
 * matching the reports/audit no-existence-leak convention). The serving route
 * (`src/artifacts/routes.ts`) stays thin over this so the R2-key derivation lives
 * in ONE place. The route - NOT this module - owns the hardened CSP/sandbox
 * headers that neutralize the (semi-trusted) HTML at render time.
 */
import { type ArtifactRow, createArtifact, getArtifact } from "../db/index.ts";
import type { Env } from "../env.ts";

/** The persisted artifact metadata row (the D1 index entry). */
export type ArtifactRecord = ArtifactRow;

/** The stored content type of an HTML artifact's body. */
export const ARTIFACT_CONTENT_TYPE = "text/html; charset=utf-8";

/** Build the R2 prefix for an artifact - derived from ids ONLY (no user input). */
export function artifactPrefix(agentId: string, artifactId: string): string {
  return `agents/${agentId}/artifacts/${artifactId}/`;
}

/** The R2 key of an artifact's HTML body, off its prefix. */
function indexKey(prefix: string): string {
  return `${prefix}index.html`;
}

/** True UTF-8 byte length of a string (multibyte-aware). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Input for {@link archiveHtmlArtifact}. */
export interface NewHtmlArtifact {
  agentId: string;
  /** The web-chat thread the artifact is shown in, or null when none. */
  conversationId?: string | null;
  title: string;
  /** The full HTML document/fragment to store + later render in a sandboxed iframe. */
  html: string;
}

/**
 * Archive an HTML artifact to R2 and record its metadata in D1.
 *
 * Mints an `artifactId`, uploads `index.html` under the artifact's prefix with
 * `text/html`, then inserts the D1 row (`r2_key` = the prefix). Returns the
 * persisted {@link ArtifactRecord} - the caller (the chat turn) puts its `id` into
 * the `data-artifact` message part so the frontend can fetch it back.
 */
export async function archiveHtmlArtifact(
  env: Env,
  input: NewHtmlArtifact,
): Promise<ArtifactRecord> {
  const artifactId = crypto.randomUUID();
  const prefix = artifactPrefix(input.agentId, artifactId);

  await env.REPORTS_BUCKET.put(indexKey(prefix), input.html, {
    httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE },
  });

  return createArtifact(env, {
    id: artifactId,
    agent_id: input.agentId,
    conversation_id: input.conversationId ?? null,
    title: input.title,
    r2_key: prefix,
    content_type: ARTIFACT_CONTENT_TYPE,
    byte_size: utf8ByteLength(input.html),
  });
}

/**
 * Resolve the ownership-checked D1 record for `artifactId` under `agentId`, or
 * null when the artifact is absent OR owned by a different agent (no existence
 * leak).
 */
async function ownedArtifact(
  env: Env,
  agentId: string,
  artifactId: string,
): Promise<ArtifactRecord | null> {
  const row = await getArtifact(env, artifactId);
  if (!row || row.agent_id !== agentId) return null;
  return row;
}

/**
 * Fetch an artifact's HTML body from R2, ownership-checked by `agent_id`. Returns
 * the R2 object (the route streams `.body` as text/html behind a hardened CSP) or
 * null when the artifact doesn't exist for this agent / the blob is missing.
 */
export async function getHtmlArtifact(
  env: Env,
  agentId: string,
  artifactId: string,
): Promise<R2ObjectBody | null> {
  const record = await ownedArtifact(env, agentId, artifactId);
  if (!record) return null;
  return env.REPORTS_BUCKET.get(indexKey(record.r2_key));
}
