/**
 * Document-ingestion schemas + constants (DOCS-01, PRD lineage: brain = the
 * thesis). A user uploads a document; we convert it to Markdown with
 * `env.AI.toMarkdown` and seed the result into the agent's brain as linked
 * neurons. This module is the single source of truth for the shapes that flow
 * through that pipeline (the D1 row, the convert outcome, the ingest result) and
 * the accept-list constants - NO logic lives here (mirrors the per-domain
 * `types.ts` modules under `src/agent`).
 *
 * The Zod {@link DocumentRow} is imported by `src/db/index.ts` for its typed CRUD
 * helpers (same pattern as `ArtifactRow`, but defined HERE so the document domain
 * owns its shape); the dependency points db → documents/types, never the reverse,
 * so there is no import cycle.
 */
import { z } from "zod";

/**
 * Upload size ceiling (bytes). 25 MB is generous for a PDF/office doc while
 * keeping a single `toMarkdown` call well inside the Workers limits; the upload
 * route rejects anything larger BEFORE touching R2 or the converter.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The accept-list: ONLY the formats `env.AI.toMarkdown` natively handles (DOCS-01
 * header). Legacy/unsupported formats (`.doc`, `.ppt/.pptx`, `.rtf`, `.pages`,
 * `.key`, …) are intentionally EXCLUDED - v1 has no sandbox conversion fallback,
 * so they are rejected at the accept-list with a typed `UNSUPPORTED_FORMAT` error
 * rather than writing a garbage neuron. Extensions are lowercase, no leading dot.
 * The convert layer cross-checks against the live `toMarkdown().supported()` set
 * and falls back to this static set when that call is unavailable.
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

/** Lifecycle of one uploaded document (mirrors the D1 `status` CHECK). */
export const DocumentStatus = z.enum([
  "pending",
  "converted",
  "seeded",
  "failed",
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/**
 * The persisted document metadata row (D1 `agent_documents`, 0014). Metadata
 * ONLY - the original blob + converted markdown live in `DOCUMENTS_BUCKET`.
 * `created_at` is epoch-ms (INTEGER in the migration), distinct from the ISO
 * text the older tables use. `discovery_id` is non-null while the doc is attached
 * to an in-progress Discovery (seed at Build) and null once seeded live.
 */
export const DocumentRow = z.object({
  id: z.string(),
  agent_id: z.string(),
  account_id: z.string(),
  discovery_id: z.string().nullable(),
  filename: z.string(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  r2_key: z.string(),
  status: DocumentStatus,
  convert_method: z.string().nullable(),
  markdown_chars: z.number().nullable(),
  neuron_count: z.number().nullable(),
  source_slug: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.number(),
});
export type DocumentRow = z.infer<typeof DocumentRow>;

/** The document metadata record, as the store + routes consume it. */
export type DocumentRecord = DocumentRow;

/**
 * The result of converting one upload to Markdown. A discriminated union so a
 * caller branches on `ok`: success carries the markdown + the method used (always
 * `'tomarkdown'` in v1); failure carries a typed `code` the UI can render. We
 * NEVER return empty markdown as success - an empty/whitespace conversion is its
 * own `EMPTY_RESULT` failure so a blank neuron is never written.
 */
export type ConvertOutcome =
  | { ok: true; markdown: string; method: "tomarkdown"; mimetype: string }
  | {
      ok: false;
      code: "UNSUPPORTED_FORMAT" | "CONVERSION_FAILED" | "EMPTY_RESULT";
      detail: string;
    };

/** Per-file outcome of an ingest request (returned in the upload response list). */
export interface IngestResult {
  docId: string;
  status: DocumentStatus;
  /** The parent source-index neuron slug once seeded, else null. */
  sourceSlug: string | null;
  neuronCount: number;
  error: string | null;
}
