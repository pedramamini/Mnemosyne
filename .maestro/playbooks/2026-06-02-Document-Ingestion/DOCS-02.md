# DOCS-02 — Document upload UI (frontend, both surfaces)

Phase DOCS-02 (see `DOCS-00-ROADMAP.md`). Goal: the user-facing upload experience for the DOCS-01 backend,
on **both** surfaces — (1) during **agent creation**, so uploaded docs feed the Discovery interview and seed
the brain at Build, and (2) on a **live agent**, "add documents to brain" at any time. Depends on DOCS-01
(the `/agents/:agentId/documents` routes) and MNEMO-32 (the design system + shared `components/ui/` library).

Conventions (load-bearing — from the Mnemosyne frontend build notes):
- **Reuse the design system; build no bespoke controls.** Compose `frontend/src/components/ui/` primitives +
  design tokens. A lint rule forbids raw interactive HTML outside `components/ui/` (`noRestrictedElements`),
  and `noExplicitAny` is enforced — adapt, don't fight it. Reuse the existing
  `frontend/src/components/ui/FileButton.tsx` for file selection.
- **No TanStack Query.** Data fetching is plain `useEffect`/`useState` hooks (despite any spec wording about
  query keys). The `Agent` field is `created_at`, not `createdAt`. The API client is
  `frontend/src/api/client.ts` and already supports a raw `FormData` body.
- **Destructive actions** (deleting a document, which can purge its neurons) follow the Danger-zone pattern:
  put them under the entity's Settings/Danger-zone area with a **type-the-exact-name** confirm — never a
  one-click icon on a list card.
- Verification: `frontend/` is its **own** vitest suite (run from `frontend/`); the backend suite is separate.
  Judge lint by the biome exit code (RTK mangles the stdout).

- [ ] **Reuse-contract task (do this first).** Before writing any component, read `frontend/src/components/ui/`
  (esp. `FileButton.tsx`) and `frontend/src/api/client.ts`. Confirm the new work will: compose existing `ui/`
  primitives + tokens (no new raw `<button>/<input>/<select>` outside `ui/`), use plain `useEffect`/`useState`
  (no TanStack Query), and send uploads via the client's `FormData` path. Note in the PR/commit description
  which existing components you reused. This task is satisfied by recording that plan; the build happens in the
  tasks below.

- [ ] Create `frontend/src/api/documents.ts`: a typed adapter over the DOCS-01 routes, matching the style of
  `frontend/src/api/discovery.ts`. `uploadDocuments(agentId, files: File[]): Promise<IngestResult[]>` (build a
  `FormData`, append each file, POST `/agents/:agentId/documents` via `client.ts` — do NOT set Content-Type
  manually; let the browser set the multipart boundary); `listDocuments(agentId)`; `deleteDocument(agentId,
  docId, opts?: { purgeNeurons?: boolean })`. Mirror DOCS-01's `IngestResult`/`DocumentRecord` shapes in a
  local TS type. No `any`.

- [ ] Create `frontend/src/hooks/useAgentDocuments.ts` (or co-locate with the api module if that's the repo
  pattern): a plain `useEffect`/`useState` hook exposing `{ documents, loading, error, upload, remove, refresh }`
  for a given `agentId`. `upload` calls `uploadDocuments`, optimistically appends rows with a `pending` status,
  and refreshes from `listDocuments` on completion. No TanStack Query.

- [ ] Create a reusable `frontend/src/components/documents/DocumentUploader.tsx` composed entirely from
  `components/ui/` primitives + tokens: a drag-and-drop drop-zone that also opens the file picker via the
  existing `FileButton`, an accept-list matching DOCS-01's `ALLOWED_EXTENSIONS` (pdf, docx, xlsx/xlsm/xlsb/xls/et,
  ods/odt, numbers, csv, html/htm, xml, images — legacy `.doc`/`.ppt`/`.pptx`/`.rtf` are NOT accepted in v1),
  client-side size guard mirroring `MAX_UPLOAD_BYTES`, and a
  list of attached documents showing per-file **status** (`pending`→converting, `converted`, `seeded` with
  neuron count, `failed` with the error message). Props: `agentId`, an `onIngested` callback, and a
  `variant: 'discovery' | 'brain'` to tweak copy. Reuse `useAgentDocuments`. No raw interactive HTML.

- [ ] Wire `DocumentUploader` into the **create/Discovery** surface: add it to `CreateAgentWizard.tsx` /
  `DiscoveryChat.tsx` (`frontend/src/components/agents/`) so the user can attach documents while describing the
  agent, with copy explaining the docs will be read during discovery and seeded into the brain at build. Use
  `variant="discovery"`. Ensure uploads happen against the just-created draft agent id (the wizard already has
  it after step 1 / `startDiscovery`). Surface a small "N documents attached" indicator near the Discovery
  confidence gate.

- [ ] Wire `DocumentUploader` into the **live-agent** surface: add an "Add documents to brain" affordance on the
  Brain explorer UI (`frontend/src/components/brain/…` / the brain explorer page from MNEMO-38) — or the agent
  detail page (MNEMO-36) if that's the more natural home — using `variant="brain"`. On successful ingest, refresh
  the brain file tree / graph so the new neurons appear without a full reload (reuse the existing brain refresh
  hook/query rather than adding a new one).

- [ ] Add the **delete** path under the existing Danger-zone pattern (per the destructive-actions convention):
  on the agent's Settings/Danger-zone area (or a Settings sub-tab of the Brain explorer), list ingested
  documents with a "Remove document" action that requires typing the filename to confirm and offers a
  "also remove the N derived neurons" checkbox (maps to `deleteDocument(..., { purgeNeurons })`). Do NOT add a
  one-click delete icon to the uploader's inline list.

- [ ] Add frontend tests in the `frontend/` vitest suite: (a) `api/documents.ts` builds the right `FormData`
  and calls the correct endpoints (mock the client); (b) `DocumentUploader` renders the four status states and
  invokes `upload` on drop/select; (c) the Discovery wizard shows the attached-count indicator after a
  successful upload. Mock the api layer — no network.

- [ ] Run the frontend suite + typecheck + lint from `frontend/` (`npm run test`, `npm run typecheck`,
  `npm run lint`); fix until green (judge lint by the biome exit code). Update any frontend `AGENTS.md`/README
  notes to mention `components/documents/`, `api/documents.ts`, and that document upload appears both in the
  create wizard and on the live-agent brain surface. Not a git repo per build notes — no commit/push unless the
  repo has since been `git init`'d.
