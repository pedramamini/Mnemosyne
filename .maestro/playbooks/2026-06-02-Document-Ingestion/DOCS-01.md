# DOCS-01 — Document ingestion engine (backend)

Phase DOCS-01 (see `DOCS-00-ROADMAP.md`). Goal: let a user **upload a document** and have it parsed to
Markdown and ingested into an agent's **brain** as linked neurons. This phase ships the backend only:
storage, conversion, chunking, brain-seeding, the HTTP surface, and the wiring so documents uploaded
**during Discovery** seed the brain at Build time (so the initial deep dive builds on the user's own
knowledge), while documents uploaded to a **live** agent seed immediately.

Depends on: MNEMO-02 (D1 schema + migrations), MNEMO-10 (the `writeNote()` write→reindex→commit pipeline in
`src/memory/write.ts` + `BrainWriteHooks`), MNEMO-25 (the R2-blob + D1-metadata artifact pattern in
`src/artifacts/store.ts` — copy its shape), MNEMO-29 (Discovery state in `src/agent/discovery/`), MNEMO-30
(`build()` provisioning in `src/agent/MnemosyneAgent.ts` + `src/agent/build/provision.ts`), MNEMO-50
(per-account rate limits, `LIMITS` KV). (Brain seeding still touches the MNEMO-06 sandbox indirectly via the
`writeNote()`/reindex pipeline, but **conversion itself uses no sandbox** — see below.)

Conventions:
- **`env.AI.toMarkdown()` is the sole converter** (the `AI` binding already exists in `wrangler.toml`).
  It natively handles PDF, `.docx`, all Excel variants, `.ods/.odt`, `.numbers`, CSV/HTML/XML, and images.
  API: `env.AI.toMarkdown(doc | doc[])`, `doc = { name, blob }`; result
  `{ id, name, format: 'markdown'|'error', mimetype, tokens?, data?, error? }`. Validate the accept-list at
  runtime with `env.AI.toMarkdown().supported()` → `{ extension, mimeType }[]`.
- **Legacy / unsupported formats are explicitly unsupported in v1** (per Pedram, 2026-06-02): legacy `.doc`
  (pre-2007 binary — only `.docx` is native), `.ppt/.pptx`, `.rtf`, `.pages`, etc. **There is no sandbox
  conversion fallback** — it was dropped to keep the converter a single reliable `toMarkdown` call (the
  container ships no Office tooling and the 60s cap made it flaky). Reject these at the upload accept-list
  with a clear "unsupported format" message, and never let a failed/empty conversion write a garbage neuron —
  return a typed `UNSUPPORTED_FORMAT` / `CONVERSION_FAILED` error the UI can show. (A future DOCS-03 with a
  LibreOffice-baked sandbox image could add legacy support; out of scope here.)
- **Never store a whole document as one neuron** — chunk by heading; one neuron per section + a parent
  "source index" neuron that `[[links]]` to each chunk. Seed via the existing `writeNote()` so reindex +
  commit + synapse graph happen for free. Don't reimplement the write pipeline.
- Routes mirror `src/agent/build/routes.ts` / `src/agent/discovery/routes.ts`: mounted under the
  authenticated `/agents/:agentId/*` group, behind `requireAuth`, with the shared `assertOwnsAgent`
  (404-not-403) guard and per-account rate limiting. Resolve the DO via `getAgentStub`.
- Verification (from MNEMO build notes): backend vitest runs **from the repo root**; `frontend/` is a
  separate suite. RTK mangles `npm run lint` stdout — judge lint by the **biome exit code**, not the text.

- [x] Create the D1 migration for an `agent_documents` table in `src/db/migrations/` (follow the existing
  migration file naming/numbering already in that folder; read a recent one first). Columns: `id` TEXT PK,
  `agent_id` TEXT NOT NULL, `account_id` TEXT NOT NULL, `discovery_id` TEXT NULL (set when uploaded before
  Build, NULL once seeded into a live brain), `filename` TEXT NOT NULL, `mime_type` TEXT, `size_bytes`
  INTEGER, `r2_key` TEXT NOT NULL (original blob), `status` TEXT NOT NULL (`'pending'|'converted'|'seeded'|'failed'`),
  `convert_method` TEXT NULL (always `'tomarkdown'` in v1 — column kept for a future fallback), `markdown_chars` INTEGER NULL, `neuron_count`
  INTEGER NULL, `source_slug` TEXT NULL (the parent source-index neuron slug), `error` TEXT NULL,
  `created_at` INTEGER NOT NULL. Add an index on `agent_id`. Verify it applies cleanly against the local D1.

- [x] Add the `DOCUMENTS_BUCKET` R2 binding to `wrangler.toml` for **all three** environments (top-level/dev,
  `[[env.staging.r2_buckets]]`, `[[env.production.r2_buckets]]`) mirroring the existing `BRAIN_BUCKET` /
  `REPORTS_BUCKET` blocks exactly: bucket names `mnemosyne-documents` (dev + prod) and
  `mnemosyne-documents-staging` (staging). Then add `DOCUMENTS_BUCKET: R2Bucket;` to the `Env` interface in
  `src/env.ts` next to the other bucket bindings (with a one-line comment: original uploaded documents,
  DOCS-01). Run `npm run typecheck` to confirm the binding type resolves. (Creating the actual remote buckets
  via `wrangler r2 bucket create` is a deploy-time human step noted in the roadmap — do not run it here.)

- [x] Create `src/documents/types.ts`: Zod schemas + inferred types. `DocumentStatus` union
  (`'pending'|'converted'|'seeded'|'failed'`); `DocumentRecord` (mirrors the D1 row above); `ConvertOutcome`
  = `{ ok: true; markdown: string; method: 'tomarkdown'; mimetype: string } | { ok: false;
  code: 'UNSUPPORTED_FORMAT'|'CONVERSION_FAILED'|'EMPTY_RESULT'; detail: string }`; and `IngestResult` =
  `{ docId: string; status: DocumentStatus; sourceSlug: string | null; neuronCount: number; error: string | null }`.
  Export a `MAX_UPLOAD_BYTES` constant (start at 25 MB) and an `ALLOWED_EXTENSIONS` set containing **only the
  `toMarkdown`-native formats** (pdf; docx; xlsx/xlsm/xlsb/xls/et; ods/odt; numbers; csv; html/htm; xml;
  jpeg/jpg/png/webp/svg) — legacy/unsupported formats are intentionally excluded so they're rejected at the
  accept-list. Schemas/constants only — no logic.

- [x] Create `src/documents/convert.ts`: `convertToMarkdown(env, input: { name: string; bytes:
  Uint8Array | ArrayBuffer; mimeType?: string }): Promise<ConvertOutcome>`. **`toMarkdown` only — no sandbox
  fallback** (legacy formats are unsupported in v1; see the doc header). Logic: (1) classify by extension
  (+mime); if the extension is NOT in the `toMarkdown`-native set, return `{ ok:false, code:'UNSUPPORTED_FORMAT',
  detail }` immediately (this is a safety net behind the upload-time accept-list, not the primary gate);
  (2) call `env.AI.toMarkdown({ name, blob: new Blob([bytes], { type })})`, and on `result.format === 'markdown'`
  with non-empty `data` return `{ ok:true, method:'tomarkdown', markdown: data, mimetype }`; (3) on
  `result.format === 'error'` return `{ ok:false, code:'CONVERSION_FAILED', detail: result.error }`, and on a
  `'markdown'` result whose `data` is empty/whitespace return `{ ok:false, code:'EMPTY_RESULT', detail }` —
  **never** return empty markdown as success. Add a small in-module cache of `env.AI.toMarkdown().supported()`
  to drive the native-set check (fall back to the static `ALLOWED_EXTENSIONS` if that call fails). Wrap the
  `toMarkdown` call in try/catch so a thrown error becomes `{ ok:false, code:'CONVERSION_FAILED' }`, not a throw.

- [x] Create `src/documents/chunk.ts`: pure `chunkMarkdown(input: { markdown: string; filename: string }):
  { sourceSlug: string; index: { slug: string; title: string; content: string }; chunks: { slug: string;
  title: string; content: string }[] }`. Split on top-level headings (H1, then H2 if no H1s) into sections;
  if a section exceeds ~8 KB, sub-split on the next heading level or paragraph boundaries so no single neuron
  is oversized. Each chunk gets YAML front matter (`title`, `source: <filename>`, `source_slug`, `chunk:
  "<n>/<total>"`, `ingested_at` left as a `{{INGESTED_AT}}` placeholder the caller fills — do NOT call
  Date.now() in this pure fn) and a footer `[[<source-index-slug>]]` back-link; consecutive chunks also link
  `[[prev]]`/`[[next]]`. Build a parent **source-index** neuron whose body lists `[[chunk-slug]]` links in
  order. Namespace every slug under the source (e.g. `sources/<source-slug>/<n>-<heading-slug>`) so two
  uploads never collide. No I/O — fully unit-testable.

- [x] Create `src/documents/seed.ts`: `seedDocumentIntoBrain(env, agentId, hooks: BrainWriteHooks, sandbox,
  input: { markdown: string; filename: string; ingestedAt: number }): Promise<{ sourceSlug: string;
  neuronCount: number }>`. Call `chunkMarkdown`, fill the `ingested_at` placeholder, then `writeNote()`
  (from `src/memory/write.ts`) for the source-index neuron and each chunk — reusing the agent's existing
  `BrainWriteHooks` so each write reindexes + commits through the normal chokepoint. Return the source slug
  and neuron count. Do not touch git or the graph index directly — go through `writeNote`/the hooks only.

- [x] Create `src/documents/store.ts`: R2 + D1 metadata helpers modeled on `src/artifacts/store.ts`
  (read it first and copy its ownership/key conventions). `putOriginal(env, agentId, docId, filename, bytes)`
  → R2 key `agents/<agentId>/documents/<docId>/<filename>`; `createDocumentRow(env, row)`,
  `updateDocumentRow(env, docId, patch)`, `listDocuments(env, agentId)`, `getDocument(env, agentId, docId)`
  (ownership-checked), `deleteDocument(env, agentId, docId)` (removes the R2 original + the D1 row; returns
  the `source_slug` so the caller can optionally drop the derived neurons). Keep all D1 access in the
  existing `src/db/` style.

- [x] Add the ingestion orchestrator + routes in `src/documents/routes.ts`, mounted from `src/index.ts` under
  the authenticated `/agents/:agentId/*` group (before the wildcard), behind `requireAuth` + `assertOwnsAgent`
  + the MNEMO-50 per-account rate limit used by build/discovery: 
  - `POST /agents/:agentId/documents` (multipart/form-data, one or more files): validate size (`MAX_UPLOAD_BYTES`)
    and extension; for each file → mint `docId`, `putOriginal`, `createDocumentRow(status:'pending')`,
    `convertToMarkdown`; on `ok:false` set `status:'failed'` + `error` and return it in the response (HTTP 200
    with a per-file outcome list — partial success is allowed). On success, **branch on agent state**: if the
    agent's brain is provisioned (Build done — check `getBuildStatus()`/sandbox exists), `seedDocumentIntoBrain`
    immediately and set `status:'seeded'` + `neuron_count` + `source_slug`; otherwise store the converted
    markdown for Build-time seeding (status `'converted'`, keep `discovery_id`) — see the Discovery task below.
    Return `IngestResult[]`.
  - `GET /agents/:agentId/documents` → `listDocuments`.
  - `DELETE /agents/:agentId/documents/:docId` → `deleteDocument`; if `?purgeNeurons=true`, also delete the
    derived neurons (source-index + chunks) via the brain write/delete pipeline.
  Wire the module into `src/index.ts` matching how `buildRoutes`/`discoveryRoutes` are wired.

- [x] Wire documents into **Discovery + Build** so creation-time uploads become starting knowledge:
  - In `src/agent/discovery/` extend the discovery state to track attached documents (id, filename, a short
    summary — e.g. the first ~500 chars of the converted markdown, or the source-index body) and inject those
    summaries into the `discoveryTurn` LLM context so the interview "sees" the uploaded material when scoping
    the agent. Keep it bounded (cap total injected chars) so a big upload can't blow the context.
  - In `build()` (`src/agent/MnemosyneAgent.ts` / `src/agent/build/provision.ts`), **after** the brain
    filesystem is provisioned and before/around the deep-dive kickoff, seed every `status:'converted'`
    document attached to this agent's discovery via `seedDocumentIntoBrain`, then mark them `'seeded'`. Make
    this idempotent (skip already-`'seeded'` docs) so a Build re-run doesn't double-seed. Record an onboarding
    milestone/audit event for the seeding (reuse the existing audit emission used by the Build setup steps).

- [x] Create `test/documents-convert.test.ts` and `test/documents-chunk.test.ts` (vitest, repo root): 
  - convert: with `env.AI.toMarkdown` mocked — (a) native format returns `{ ok:true, method:'tomarkdown' }`
    with the mocked markdown; (b) `result.format === 'error'` surfaces `{ ok:false, code:'CONVERSION_FAILED' }`
    (not a throw); (c) a legacy/unsupported extension (e.g. `.doc`, `.pptx`) returns
    `{ ok:false, code:'UNSUPPORTED_FORMAT' }` **without** calling `toMarkdown` at all; (d) a `'markdown'` result
    with empty `data` returns `{ ok:false, code:'EMPTY_RESULT' }` — assert no empty "success". 
  - chunk: a multi-heading markdown doc produces N chunk neurons + 1 source-index neuron, slugs are namespaced
    under the source (no collisions across two different filenames), front matter carries `source`/`chunk`,
    and an oversized section gets sub-split. Pure, no I/O.

- [x] Create `test/documents-ingest.test.ts` (vitest workers pool, DO + D1 configured, **sandbox mocked** via
  the shared `test/stub-sandbox.ts` recording fake, `env.AI.toMarkdown` mocked): (a) upload to a **built**
  agent seeds neurons immediately — assert the mocked write pipeline received a source-index + one neuron per
  chunk, the D1 row is `status:'seeded'` with the right `neuron_count`, and the original landed in R2;
  (b) upload to a **not-yet-built** agent stores `status:'converted'` and seeds nothing, then `build()` seeds
  the attached docs and flips them to `'seeded'` (and a second `build()` does not double-seed); (c) ownership
  — a request for another account's agent returns 404 and touches nothing; (d) an unsupported file returns a
  per-file `failed` outcome without aborting a sibling file's successful ingest.

- [x] Run `npm run test`, `npm run typecheck`, and `npm run lint` from the repo root; fix until all pass and
  report the final output (judge lint by the biome **exit code**, not RTK-mangled stdout). Update `AGENTS.md`
  to document `src/documents/` (upload → `env.AI.toMarkdown` conversion → heading-chunked
  brain-seeding via `writeNote`; legacy/unsupported formats rejected at the accept-list, no sandbox fallback;
  Discovery-attached docs seed at Build time; live-agent docs seed immediately)
  and the new `DOCUMENTS_BUCKET` binding + `agent_documents` table. Not a git repo per build notes — no
  commit/push unless the repo has since been `git init`'d.

> **DOCS-01 completion notes (2026-06-02):**
> - **Final verification:** `tsc --noEmit` clean (0 errors); biome `check .` exit 0 (had to fix ONE
>   pre-existing, unrelated frontend nit, `frontend/src/appearance/__tests__/appearance.test.ts`, that was
>   already failing root lint); full vitest suite **563 passed / 90 files, 0 failed**, including the 14 new
>   DOCS-01 tests (5 convert + 5 chunk + 4 ingest).
> - **RTK/vitest gotcha (new):** `npm run test` / `npx vitest` get mangled by the RTK proxy and report a bogus
>   `Cannot read properties of undefined (reading 'config')` for EVERY test (even pre-existing ones). Run the
>   binary directly with network enabled instead: `./node_modules/.bin/vitest run` (the `[ai] remote=true`
>   binding needs a live connection at pool init). The "Containers have not been enabled" lines in output are
>   pre-existing benign warnings, not failures.
> - **Implementation choices worth knowing:** the repo's migrations live in top-level `migrations/` (not
>   `src/db/migrations/`); the new migration is `0014_documents.sql`. Wikilink resolution in the brain is by
>   slugified **title**, so chunk neuron titles are made unique-per-source (`<filename> - §<n> <heading>`) and
>   the index/back/prev/next links reference that exact title; the namespaced `sources/<src>/<n>-<slug>` path is
>   the FS slug. `DocumentRow`/`DocumentStatus` are defined in `src/documents/types.ts` and imported by
>   `src/db/index.ts` (one-directional, no cycle). Build-time seeding is naturally idempotent via the per-doc
>   `converted -> seeded` status flip. Corpus em-dash rule (AGENTS.md) honored: all new files are em/en-dash free.
