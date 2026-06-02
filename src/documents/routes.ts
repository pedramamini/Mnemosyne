/**
 * Document ingestion HTTP surface + orchestrator (DOCS-01).
 *
 * Mounted under the authenticated `/agents/:agentId/*` group, behind `requireAuth`
 * + the shared {@link assertOwnsAgent} guard (404-not-403, no existence leak) +
 * the MNEMO-50 per-account rate limit on upload (the same machinery build /
 * discovery use). The DO is invoked over native Workers RPC for the brain-touching
 * steps (seed / attach / purge).
 *
 *   POST   /agents/:agentId/documents             multipart upload (1+ files)
 *   GET    /agents/:agentId/documents             metadata list
 *   DELETE /agents/:agentId/documents/:docId      delete (+ ?purgeNeurons=true)
 *
 * The ingest orchestrator ({@link ingestDocuments}) is exported so it can be unit-
 * tested directly with a mocked `env.AI` + recording sandbox, without HTTP/multipart.
 */
import { Hono } from "hono";
import { byAccount, rateLimitMiddleware } from "../abuse/rateLimit.ts";
import { getAgentStub } from "../agent/index.ts";
import { assertOwnsAgent } from "../agents/ownership.ts";
import { type AppEnv, getAccountId, requireAuth } from "../auth/middleware.ts";
import type { Env } from "../env.ts";
import { convertToMarkdown, extensionOf } from "./convert.ts";
import {
  createDocumentRow,
  deleteDocument,
  documentPrefix,
  listDocuments,
  putConverted,
  putOriginal,
  updateDocumentRow,
} from "./store.ts";
import {
  ALLOWED_EXTENSIONS,
  type IngestResult,
  MAX_UPLOAD_BYTES,
} from "./types.ts";

/** One normalized upload (the route extracts these from the multipart form). */
export interface UploadFile {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
  size?: number;
}

/** Chars of converted markdown used as the Discovery summary for an attached doc. */
const SUMMARY_CHARS = 500;

/** A failed ingest outcome (no row persisted - rejected at the accept-list gate). */
function gateFailure(message: string): IngestResult {
  return {
    docId: crypto.randomUUID(),
    status: "failed",
    sourceSlug: null,
    neuronCount: 0,
    error: message,
  };
}

/**
 * Ingest one upload end to end: accept-list gate → store original → convert →
 * branch on agent state (seed live, or stash for Build). Returns the per-file
 * {@link IngestResult}. Never throws for an expected failure (oversize, bad type,
 * conversion error) - those become a `failed` outcome so a sibling file still
 * ingests (partial success).
 */
async function ingestOne(
  env: Env,
  params: { agentId: string; accountId: string; built: boolean },
  file: UploadFile,
): Promise<IngestResult> {
  const { agentId, accountId, built } = params;
  const size = file.size ?? file.bytes.byteLength;

  // Accept-list gate (BEFORE any storage): size + native extension. A rejected
  // file persists nothing (no R2 blob, no D1 row) - the response carries the why.
  if (size > MAX_UPLOAD_BYTES) {
    return gateFailure(
      `File is too large (${Math.ceil(size / (1024 * 1024))} MB; max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).`,
    );
  }
  const ext = extensionOf(file.name);
  if (ext === "" || !ALLOWED_EXTENSIONS.has(ext)) {
    return gateFailure(
      ext
        ? `Unsupported file type ".${ext}". Legacy formats (.doc, .ppt, .rtf, …) aren't supported.`
        : "File has no extension, so its type can't be determined.",
    );
  }

  const docId = crypto.randomUUID();
  const r2Key = await putOriginal(env, agentId, docId, file.name, file.bytes);
  await createDocumentRow(env, {
    id: docId,
    agent_id: agentId,
    account_id: accountId,
    // Attach to the in-progress Discovery until seeded into a live brain.
    discovery_id: built ? null : agentId,
    filename: file.name,
    mime_type: file.mimeType ?? null,
    size_bytes: size,
    r2_key: r2Key,
    status: "pending",
  });

  const converted = await convertToMarkdown(env, {
    name: file.name,
    bytes: file.bytes,
    mimeType: file.mimeType,
  });
  if (!converted.ok) {
    await updateDocumentRow(env, docId, {
      status: "failed",
      error: `${converted.code}: ${converted.detail}`,
    });
    return {
      docId,
      status: "failed",
      sourceSlug: null,
      neuronCount: 0,
      error: `${converted.code}: ${converted.detail}`,
    };
  }
  const markdown = converted.markdown;

  if (built) {
    // Live agent: seed into the brain immediately through the DO.
    try {
      const { sourceSlug, neuronCount } = await getAgentStub(
        env,
        agentId,
      ).seedDocument({ markdown, filename: file.name, ingestedAt: Date.now() });
      await updateDocumentRow(env, docId, {
        status: "seeded",
        convert_method: converted.method,
        markdown_chars: markdown.length,
        neuron_count: neuronCount,
        source_slug: sourceSlug,
      });
      return {
        docId,
        status: "seeded",
        sourceSlug,
        neuronCount,
        error: null,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await updateDocumentRow(env, docId, { status: "failed", error });
      return {
        docId,
        status: "failed",
        sourceSlug: null,
        neuronCount: 0,
        error,
      };
    }
  }

  // Not yet built: stash the converted markdown for Build-time seeding and let the
  // Discovery interview see a short summary of it.
  await putConverted(env, agentId, docId, markdown);
  await updateDocumentRow(env, docId, {
    status: "converted",
    convert_method: converted.method,
    markdown_chars: markdown.length,
  });
  await getAgentStub(env, agentId).attachDiscoveryDocument({
    id: docId,
    filename: file.name,
    summary: markdown.slice(0, SUMMARY_CHARS),
  });
  return {
    docId,
    status: "converted",
    sourceSlug: null,
    neuronCount: 0,
    error: null,
  };
}

/**
 * Ingest a batch of uploads for one agent. Resolves the agent's build state once
 * (it's the same for every file), then ingests each file - a per-file failure
 * never aborts the batch (partial success). Exported for direct unit testing.
 */
export async function ingestDocuments(
  env: Env,
  params: { agentId: string; accountId: string },
  files: UploadFile[],
): Promise<IngestResult[]> {
  const built =
    (await getAgentStub(env, params.agentId).getBuildStatus()).phase ===
    "ready";
  const results: IngestResult[] = [];
  for (const file of files) {
    results.push(await ingestOne(env, { ...params, built }, file));
  }
  return results;
}

/** Pull every `File` part out of a multipart form into normalized uploads. */
async function filesFromForm(form: FormData): Promise<UploadFile[]> {
  const files: UploadFile[] = [];
  for (const value of form.values()) {
    if (value instanceof File) {
      files.push({
        name: value.name,
        bytes: new Uint8Array(await value.arrayBuffer()),
        mimeType: value.type || undefined,
        size: value.size,
      });
    }
  }
  return files;
}

export function documentRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Self-contained auth on the group (the `/agents/:agentId/*` wildcard in
  // src/index.ts also covers these; applying it here keeps the sub-app correct
  // regardless of mount order - requireAuth is idempotent).
  app.use("/agents/:agentId/documents", requireAuth());
  app.use("/agents/:agentId/documents/*", requireAuth());

  // MNEMO-50: per-account limit on upload only (convert + seed is the costly path;
  // list/delete are cheap and don't need a bucket).
  app.use("/agents/:agentId/documents", async (c, next) =>
    c.req.method === "POST"
      ? rateLimitMiddleware("documents_upload", byAccount)(c, next)
      : next(),
  );

  // POST /documents - upload one or more files (multipart/form-data). Returns a
  // per-file IngestResult list (HTTP 200; partial success is allowed).
  app.post("/agents/:agentId/documents", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }
    const files = await filesFromForm(form);
    if (files.length === 0) {
      return c.json({ error: "no files in upload" }, 400);
    }

    const results = await ingestDocuments(
      c.env,
      { agentId, accountId: getAccountId(c) },
      files,
    );
    return c.json({ results });
  });

  // GET /documents - the agent's uploaded-document metadata list.
  app.get("/agents/:agentId/documents", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const documents = await listDocuments(c.env, agentId);
    return c.json({ documents });
  });

  // DELETE /documents/:docId - remove the upload (R2 + D1). `?purgeNeurons=true`
  // also drops the derived brain neurons (source-index + chunks).
  app.delete("/agents/:agentId/documents/:docId", async (c) => {
    const agentId = c.req.param("agentId");
    const guard = await assertOwnsAgent(c, agentId);
    if (guard) return guard;

    const docId = c.req.param("docId");
    const deleted = await deleteDocument(c.env, agentId, docId);
    if (!deleted) return c.json({ error: "not found" }, 404);

    let purgedNeurons = 0;
    if (c.req.query("purgeNeurons") === "true" && deleted.sourceSlug) {
      purgedNeurons = await getAgentStub(c.env, agentId).purgeDocumentNeurons(
        deleted.sourceSlug,
      );
    }
    return c.json({ deleted: true, purgedNeurons });
  });

  return app;
}

// Derived-key helper re-export so callers (tests) can assert R2 layout without
// reaching into the store module's internals.
export { documentPrefix };
