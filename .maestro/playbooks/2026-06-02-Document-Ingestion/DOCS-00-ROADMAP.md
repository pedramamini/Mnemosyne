# Document Ingestion — Phase Roadmap (DOCS)

> Post-MVP feature: let users **upload documents** (PDF, Office, OpenDocument, CSV, images…) and have
> them parsed to Markdown and ingested into an agent's **brain** — both during agent creation
> (so the Discovery interview + initial deep dive build on the user's own knowledge) and on a live
> agent at any time. **This file has no `- [ ]` tasks on purpose** — the Auto Run engine skips it.
>
> **Execution model:** one phase = one Auto Run doc = one fresh context, run one at a time. Each doc is
> self-contained; tasks carry their own file paths + rationale. **Task-based playbook** — each `- [ ]`
> runs in a fresh agent context, so every task restates the context it needs.
>
> Run a phase with:
> `maestro-cli auto-run .maestro/playbooks/2026-06-02-Document-Ingestion/DOCS-01.md --launch --agent 541d1591-b9ef-4acd-8043-e56cf630684d`

## Verified facts (feasibility spike, 2026-06-02)
- **Cloudflare Workers AI `env.AI.toMarkdown()` is the primary converter** and the `AI` binding already
  exists in `wrangler.toml`. It natively converts (no container needed): **PDF** (`.pdf`),
  **MS Office** (`.xlsx .xlsm .xlsb .xls .et .docx`), **OpenDocument** (`.ods .odt`),
  **Apple** (`.numbers`), **CSV / HTML / XML**, and **images** (`.jpeg .jpg .png .webp .svg`,
  which additionally bill Workers AI vision models). `.docx` IS supported — confirmed on the docs format list.
- **Legacy / unsupported formats are explicitly unsupported in v1** (per Pedram, 2026-06-02): legacy
  **`.doc`** (pre-2007 binary — only `.docx` is native), **`.ppt/.pptx`**, `.rtf`, `.pages`. **No sandbox
  conversion fallback** — dropped to keep the converter a single reliable `toMarkdown` call (the container
  ships no Office tooling and the 60s cap made it flaky). These are rejected at the upload accept-list with a
  clear "unsupported format" message; a failed/empty conversion never writes a garbage neuron. A future
  **DOCS-03** with a LibreOffice-baked sandbox image could add legacy support — out of scope for now.
- **API:** `env.AI.toMarkdown(doc | doc[])`, `doc = { name: string, blob: Blob }`. Result(s):
  `{ id, name, format: 'markdown' | 'error', mimetype, tokens?, data?, error? }` — branch on
  `format === 'error'` to fall back. `env.AI.toMarkdown().supported()` returns `{ extension, mimeType }[]`
  for runtime accept-list validation.
- **Brain ingestion reuses the existing write pipeline:** `writeNote()` in `src/memory/write.ts`
  (write → reindex → git commit) is the chokepoint. Convert → **chunk by heading** → one neuron per
  section (never one giant note) → `writeNote` each, so indexing + commit + `[[wikilink]]` graph come for free.

## Phases
- **DOCS-01 — Ingestion engine (backend):** `DOCUMENTS_BUCKET` (R2) + `agent_documents` (D1) +
  `toMarkdown`-only converter (legacy formats rejected at the accept-list) + heading chunker + brain seeding
  via `writeNote` + multipart upload/list/delete routes + Discovery attach/inject + Build-time seeding + tests.
- **DOCS-02 — Upload UI (frontend, both surfaces):** `api/documents.ts` adapter (FormData) + reusable
  `DocumentUploader` (reuses `components/ui/FileButton` + design tokens) + drop-zone in the create wizard
  (surfaces docs to Discovery) + "Add documents to brain" on a live agent + status display + danger-zone
  delete + tests.

## Sequencing
Run **DOCS-01 before DOCS-02** — the frontend adapter and components target the backend routes DOCS-01 ships.

## Deploy (human steps — not engine tasks)
After both phases pass locally:
- Create the R2 bucket(s): `wrangler r2 bucket create mnemosyne-documents` (+ `mnemosyne-documents-staging`).
- Apply the new D1 migration to staging, then `npm run deploy:staging` (deploys from local — this repo has no CI).
- Smoke-test: upload a `.pdf` and a `.docx` during agent creation; confirm neurons appear in the brain graph.
