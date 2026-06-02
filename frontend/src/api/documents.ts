/**
 * Document-ingestion API adapter (DOCS-02) - the SINGLE point of contact with the
 * DOCS-01 `/agents/:agentId/documents` backend. Mirrors the style of
 * `discovery.ts`: the rest of the UI consumes the stable shapes declared here and
 * this file owns the wire contract.
 *
 * Upload is `multipart/form-data`: we build a `FormData`, append each file, and
 * POST it through the api client's RAW-body path (`apiFetch` with `body`, not
 * `json`). We deliberately do NOT set `Content-Type` - the browser sets the
 * multipart boundary itself (DOCS-02). The DOCS-01 accept-list + size ceiling are
 * mirrored here as the single client-side source of truth so the uploader can
 * reject bad files before a round-trip (the backend re-checks regardless).
 */
import { apiFetch, del, get } from "./client";

/** Lifecycle of one uploaded document (mirrors DOCS-01's `DocumentStatus`). */
export type DocumentStatus = "pending" | "converted" | "seeded" | "failed";

/**
 * The document metadata record, mirroring DOCS-01's `DocumentRecord`/`DocumentRow`
 * (D1 `agent_documents`). `created_at` is epoch-ms. Nullable columns are typed
 * `… | null` so the UI handles a cleared/absent field explicitly.
 */
export interface DocumentRecord {
  id: string;
  agent_id: string;
  account_id: string;
  /** Non-null while attached to an in-progress Discovery; null once seeded live. */
  discovery_id: string | null;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string;
  status: DocumentStatus;
  convert_method: string | null;
  markdown_chars: number | null;
  neuron_count: number | null;
  source_slug: string | null;
  error: string | null;
  created_at: number;
}

/** Per-file outcome of an ingest request (mirrors DOCS-01's `IngestResult`). */
export interface IngestResult {
  docId: string;
  status: DocumentStatus;
  /** The parent source-index neuron slug once seeded, else null. */
  sourceSlug: string | null;
  neuronCount: number;
  error: string | null;
}

/** Outcome of deleting one document (DOCS-01 `DELETE` response). */
export interface DeleteDocumentResult {
  deleted: boolean;
  /** Derived neurons removed (0 unless `purgeNeurons` was requested). */
  purgedNeurons: number;
}

/**
 * Upload size ceiling (bytes) - mirrors DOCS-01's `MAX_UPLOAD_BYTES` (25 MB). The
 * uploader rejects anything larger before posting; the backend rejects it again.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The accept-list: ONLY the formats `env.AI.toMarkdown` natively handles (DOCS-01).
 * Legacy/unsupported formats (`.doc`, `.ppt/.pptx`, `.rtf`, `.pages`, …) are
 * intentionally EXCLUDED - v1 has no sandbox fallback, so they are rejected at the
 * accept-list. Extensions are lowercase, no leading dot. Keep in sync with the
 * backend `ALLOWED_EXTENSIONS` set.
 */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents
  "pdf",
  "docx",
  // Spreadsheets (all the Excel + open variants toMarkdown supports)
  "xlsx",
  "xlsm",
  "xlsb",
  "xls",
  "et",
  "ods",
  "odt",
  "numbers",
  // Structured text
  "csv",
  "html",
  "htm",
  "xml",
  // Images (toMarkdown captions/extracts these)
  "jpeg",
  "jpg",
  "png",
  "webp",
  "svg",
]);

/**
 * The `accept` attribute string for a file picker, derived from
 * {@link ALLOWED_EXTENSIONS} (e.g. `.pdf,.docx,…`). One source of truth so the
 * picker and the client-side gate never drift.
 */
export const ACCEPT_ATTRIBUTE: string = [...ALLOWED_EXTENSIONS]
  .map((ext) => `.${ext}`)
  .join(",");

/** The lowercased extension of a filename (no dot), or `""` when there is none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/** A client-side accept-list + size check, mirroring the DOCS-01 upload gate. */
export type FileCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate a file against the same rules the backend enforces, so the uploader can
 * reject oversize/unsupported files immediately (with a clear reason) instead of a
 * failed round-trip. The backend re-checks regardless - this is UX, not security.
 */
export function checkFile(file: File): FileCheck {
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = Math.ceil(file.size / (1024 * 1024));
    const max = MAX_UPLOAD_BYTES / (1024 * 1024);
    return { ok: false, reason: `Too large (${mb} MB; max ${max} MB).` };
  }
  const ext = extensionOf(file.name);
  if (ext === "") {
    return { ok: false, reason: "No file extension, so the type is unknown." };
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `Unsupported type ".${ext}". Legacy formats (.doc, .ppt, .rtf, …) aren't supported.`,
    };
  }
  return { ok: true };
}

// ── Backend wire shapes, kept local to this adapter ──────────────────────────

interface UploadResponse {
  results: IngestResult[];
}

interface ListResponse {
  documents: DocumentRecord[];
}

/**
 * Upload one or more documents to an agent. Builds a `multipart/form-data` body
 * (each file under the `files` field) and POSTs it RAW - the browser sets the
 * boundary, so we never set `Content-Type` ourselves. Returns the per-file
 * {@link IngestResult} list (HTTP 200 even on partial failure - inspect each
 * result's `status`/`error`).
 */
export async function uploadDocuments(
  agentId: string,
  files: File[],
): Promise<IngestResult[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const res = await apiFetch<UploadResponse>(
    `/agents/${encodeURIComponent(agentId)}/documents`,
    { method: "POST", body: form },
  );
  return res.results;
}

/** List an agent's uploaded-document metadata. */
export async function listDocuments(
  agentId: string,
): Promise<DocumentRecord[]> {
  const res = await get<ListResponse>(
    `/agents/${encodeURIComponent(agentId)}/documents`,
  );
  return res.documents;
}

/**
 * Delete one uploaded document (R2 original + D1 row). With
 * `{ purgeNeurons: true }` the backend also drops the derived brain neurons
 * (source-index + chunks) and reports how many it removed.
 */
export function deleteDocument(
  agentId: string,
  docId: string,
  opts?: { purgeNeurons?: boolean },
): Promise<DeleteDocumentResult> {
  const query = opts?.purgeNeurons ? "?purgeNeurons=true" : "";
  return del<DeleteDocumentResult>(
    `/agents/${encodeURIComponent(agentId)}/documents/${encodeURIComponent(docId)}${query}`,
  );
}
