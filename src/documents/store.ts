/**
 * Uploaded-document storage: R2 blobs + the D1 metadata index (DOCS-01).
 *
 * Modeled on `src/artifacts/store.ts` / `src/reports/archive.ts`: one R2 prefix
 * per document (`agents/<agentId>/documents/<docId>/`) holding the ORIGINAL upload
 * and (for a not-yet-built agent) the CONVERTED markdown, while D1
 * `agent_documents` carries only the metadata index - so the upload list never
 * enumerates R2. The prefix is derived from `agentId`/`docId` ONLY (never model or
 * user input); the filename is appended as a sanitized basename so a hostile name
 * can't reshape the key. Reads are ownership-checked (a doc owned by a different
 * agent is indistinguishable from a missing one - no existence leak).
 */
import {
  createDocument,
  type DocumentRecord,
  type DocumentUpdate,
  deleteDocumentRow,
  getDocumentById,
  listDocumentsByAgent,
  type NewDocument,
  updateDocument,
} from "../db/index.ts";
import type { Env } from "../env.ts";

/** R2 prefix for a document - derived from ids ONLY (no user input). */
export function documentPrefix(agentId: string, docId: string): string {
  return `agents/${agentId}/documents/${docId}/`;
}

/** A filesystem-safe basename for the R2 key (the original name lives in D1). */
function safeName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "upload" : cleaned;
}

/** The R2 key of the converted markdown, off a document's prefix. */
function convertedKey(prefix: string): string {
  return `${prefix}converted.md`;
}

/**
 * Store the ORIGINAL upload bytes in R2 and return the key (recorded as the row's
 * `r2_key`). Key = `<prefix><sanitized-filename>` so the blob is both namespaced
 * and human-recognizable in the bucket.
 */
export async function putOriginal(
  env: Env,
  agentId: string,
  docId: string,
  filename: string,
  bytes: Uint8Array | ArrayBuffer,
): Promise<string> {
  const key = `${documentPrefix(agentId, docId)}${safeName(filename)}`;
  await env.DOCUMENTS_BUCKET.put(key, bytes);
  return key;
}

/**
 * Store the converted markdown for Build-time seeding (a not-yet-built agent's
 * upload waits here until `build()` drains it). Kept off D1 - D1 is metadata only.
 */
export async function putConverted(
  env: Env,
  agentId: string,
  docId: string,
  markdown: string,
): Promise<void> {
  await env.DOCUMENTS_BUCKET.put(
    convertedKey(documentPrefix(agentId, docId)),
    markdown,
    { httpMetadata: { contentType: "text/markdown; charset=utf-8" } },
  );
}

/**
 * Read back the converted markdown for a document (ownership-checked), or null
 * when the document isn't this agent's or the blob is missing. Used by the Build
 * pass to seed `converted` documents into the now-live brain.
 */
export async function getConverted(
  env: Env,
  agentId: string,
  docId: string,
): Promise<string | null> {
  const owned = await getDocument(env, agentId, docId);
  if (!owned) return null;
  const obj = await env.DOCUMENTS_BUCKET.get(
    convertedKey(documentPrefix(agentId, docId)),
  );
  return obj ? await obj.text() : null;
}

/** Insert the document metadata row (thin pass-through to the D1 layer). */
export function createDocumentRow(
  env: Env,
  row: NewDocument,
): Promise<DocumentRecord> {
  return createDocument(env, row);
}

/** Patch the document metadata row (status, neuron counts, error, …). */
export function updateDocumentRow(
  env: Env,
  docId: string,
  patch: DocumentUpdate,
): Promise<DocumentRecord | null> {
  return updateDocument(env, docId, patch);
}

/** List an agent's documents (newest first). */
export function listDocuments(
  env: Env,
  agentId: string,
): Promise<DocumentRecord[]> {
  return listDocumentsByAgent(env, agentId);
}

/**
 * Fetch one document, ownership-checked: null when the document is absent OR owned
 * by a different agent (no existence leak), else the row.
 */
export async function getDocument(
  env: Env,
  agentId: string,
  docId: string,
): Promise<DocumentRecord | null> {
  const row = await getDocumentById(env, docId);
  if (!row || row.agent_id !== agentId) return null;
  return row;
}

/**
 * Delete a document (ownership-checked): drop its R2 blobs (original + converted)
 * and the D1 row, returning the `source_slug` so the caller can optionally purge
 * the derived brain neurons. Returns null (and touches nothing) when the document
 * isn't this agent's.
 */
export async function deleteDocument(
  env: Env,
  agentId: string,
  docId: string,
): Promise<{ sourceSlug: string | null } | null> {
  const row = await getDocument(env, agentId, docId);
  if (!row) return null;
  const prefix = documentPrefix(agentId, docId);
  await env.DOCUMENTS_BUCKET.delete([row.r2_key, convertedKey(prefix)]);
  await deleteDocumentRow(env, docId);
  return { sourceSlug: row.source_slug };
}
