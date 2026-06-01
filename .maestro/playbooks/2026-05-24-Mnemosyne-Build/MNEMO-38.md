# MNEMO-38 — Frontend: Brain explorer UI (file tree, view/edit/create/delete, download archive)

- [x] **Design-system reuse (do this before building any UI):** build every part of this screen exclusively from the shared component library in `frontend/src/components/ui/` and the design tokens from MNEMO-32-b — do NOT create bespoke buttons, inputs, selects, modals, tables, or other one-off controls, and do NOT use raw interactive HTML elements (`<button>`, `<input>`, `<select>`, `<textarea>`, action `<a>`). If a primitive you need is missing, add it to `frontend/src/components/ui/` (with a catalog entry in the dev gallery) and consume it from there — never build it locally. Run `npm run lint`; MNEMO-32-b's rule fails the build on raw interactive elements outside `components/ui/`.

Phase 38, Track G — Frontend (see `MNEMO-00-ROADMAP.md`). Goal: a web brain explorer where the user
browses the agent's filesystem (its brain) as a file tree, **views, edits, creates, and deletes** files,
and **downloads the whole brain as an archive**. Depends on **MNEMO-11** (brain explorer backend:
list/read/write/delete files + archive zip/tar download), **MNEMO-36** (agent detail page with tabs —
this adds a "Brain" tab), and the frontend scaffold (MNEMO-32: Vite + React + TS in `frontend/`, API
client in `frontend/src/api/`, components in `frontend/src/components/`, pages in `frontend/src/pages/`).
Per `docs/PRD.md` v0.5 §6.9: the brain is browsable and editable from the web UI — view/edit/create/delete
files, and download the entire brain as an archive (zip/tarball).

Conventions: React + TS reusing Crema component patterns; data fetching via the shared API client and the
project's query layer (TanStack Query as established in MNEMO-32 — if a different layer was chosen there,
match it). All brain endpoints are agent-scoped (`/agents/:agentId/brain/...`) and behind the auth cookie.
Components live under `frontend/src/components/brain/`; the page is a tab panel under
`frontend/src/pages/agent/`. Tests use vitest + @testing-library/react with the API client mocked — never
hit a live worker. Keep each component focused; separate component code, tests, and test-runs into distinct
tasks.

- [x] Create `frontend/src/api/brain.ts`: a typed brain API client wrapping the MNEMO-11 endpoints, using the shared fetch wrapper from `frontend/src/api/` (the one that attaches credentials + base URL established in MNEMO-32). Export: `listBrainFiles(agentId): Promise<BrainEntry[]>` (`GET /agents/:agentId/brain/files` — returns a flat list or tree of `{ path, type: "file"|"dir", size?, modifiedAt? }`), `readBrainFile(agentId, path): Promise<{ path, content, size }>` (`GET /agents/:agentId/brain/file?path=...`), `writeBrainFile(agentId, path, content): Promise<BrainEntry>` (`PUT /agents/:agentId/brain/file` — used for both create and edit), `deleteBrainFile(agentId, path): Promise<void>` (`DELETE /agents/:agentId/brain/file?path=...`), and `brainArchiveUrl(agentId): string` (returns the `GET /agents/:agentId/brain/archive` URL for the download link). Define and export the `BrainEntry` TypeScript type. Match the exact request/response shapes from MNEMO-11; add a `// shapes mirror MNEMO-11` comment.

- [x] Create `frontend/src/components/brain/useBrain.ts`: thin query hooks over `frontend/src/api/brain.ts` using the project's query layer — `useBrainFiles(agentId)` (list query, keyed `["brain", agentId, "files"]`), `useBrainFile(agentId, path)` (read query, keyed `["brain", agentId, "file", path]`, enabled only when `path` is set), and mutation hooks `useWriteBrainFile(agentId)` and `useDeleteBrainFile(agentId)` that invalidate the `["brain", agentId, "files"]` (and relevant file) keys on success. No UI here — hooks only.

- [x] Create `frontend/src/components/brain/BrainTree.tsx`: renders `BrainEntry[]` as a collapsible file tree (directories expand/collapse, files are selectable). Props: `entries`, `selectedPath`, `onSelect(path)`, `onRequestNew(parentDir)`, `onRequestDelete(path)`. Build a nested tree from the flat path list if the backend returns flat paths; sort dirs before files, alphabetically. Show a file/folder icon and the basename per row; indent by depth. Include per-row hover affordances for "new file here" and "delete". Keep it presentational — no data fetching, no API calls.

- [x] Create `frontend/src/components/brain/FileEditor.tsx`: a view/edit panel for a single file. Props: `path`, `content`, `isLoading`, `isSaving`, `onSave(newContent)`, `onCancel`. Render a textarea (or the editor primitive already used in the design system from MNEMO-32) preloaded with `content`; track dirty state; a "Save" button calls `onSave` and is disabled when not dirty or while `isSaving`; show the file `path` as a header. Show a read-only empty state ("Select a file to view") when `path` is null. Keep presentational — the parent owns the mutation.

- [x] Create `frontend/src/components/brain/NewFileDialog.tsx`: a small modal (reuse the design-system Dialog/Modal from MNEMO-32) that collects a new file path (prefilled with the parent dir + trailing slash) and initial content (optional, default empty), validates the path is non-empty and relative (no leading `/`, no `..` segments), and calls `onCreate(path, content)`. Props: `open`, `defaultDir`, `onCreate`, `onClose`. Presentational + local form state only.

- [x] Create `frontend/src/components/brain/DownloadBrainButton.tsx`: a button that links to `brainArchiveUrl(agentId)` (anchor with `download` attribute, opens the MNEMO-11 archive endpoint so the browser streams the zip/tar). Props: `agentId`. Label it "Download brain (.zip)"; include a brief tooltip "Download the entire brain as an archive" referencing PRD §6.9. No fetch — the browser handles the download via the authed cookie.

- [x] Create `frontend/src/pages/agent/BrainExplorerTab.tsx`: the composed Brain tab. Props: `agentId`. Two-pane layout — left: `BrainTree` (fed by `useBrainFiles`) plus a "New file" action and `DownloadBrainButton`; right: `FileEditor` driven by `useBrainFile(agentId, selectedPath)`. Wire selection state, the `useWriteBrainFile` mutation (Save in the editor; create from `NewFileDialog`), and `useDeleteBrainFile` (with a confirm prompt). Show toast/inline errors on mutation failure. Handle loading and empty-brain states. Mount this tab into the agent detail page tab set from MNEMO-36 (add a "Brain" tab entry pointing here).

- [x] Create `frontend/src/components/brain/__tests__/BrainTree.test.tsx` (vitest + @testing-library/react): given a flat list of paths (`notes/a.md`, `notes/b.md`, `tools/x.py`, `index.md`), assert the tree renders the two directories collapsed-then-expandable and the files under them; clicking a file row calls `onSelect` with the correct path; the delete affordance calls `onRequestDelete`. No network.

- [x] Create `frontend/src/components/brain/__tests__/FileEditor.test.tsx` and `NewFileDialog.test.tsx`: for `FileEditor` — renders content, Save is disabled until the textarea changes, then calls `onSave` with the edited content; empty-state shows when `path` is null. For `NewFileDialog` — rejects an empty path and a path containing `..` (no `onCreate` call, shows validation), accepts a valid relative path and calls `onCreate(path, content)`. No network.

- [x] Create `frontend/src/pages/agent/__tests__/BrainExplorerTab.test.tsx`: mock `frontend/src/api/brain.ts` so `listBrainFiles` returns a small tree and `readBrainFile` returns content for a selected path. Assert: tree renders, selecting a file loads its content into the editor, saving calls `writeBrainFile` with the new content, creating via the dialog calls `writeBrainFile` with the new path, deleting calls `deleteBrainFile` after confirm, and the download button's href equals `brainArchiveUrl(agentId)`. Use the query layer's test wrapper from MNEMO-32.

- [x] From `frontend/`, run `npm run test`, `npm run typecheck`, and `npm run lint`; fix until all pass and report the final command output.

---

## Completion notes (MNEMO-38)

All tasks implemented and verified. Final gate output from `frontend/`:

- `npm run test` → **28 files, 92 tests passed** (17 new brain tests + 1 updated `AgentDetailPage` test for the 6th tab).
- `npm run typecheck` → `tsc --noEmit` clean, no errors.
- `npm run lint` → `biome check .` exit **0** (199 files, format + lint clean).

Key decisions / deviations:

- **Query layer:** MNEMO-32 settled on plain `useState`/`useEffect` hooks over `apiFetch` (no TanStack Query in `package.json`), so `useBrain.ts` matches that. Cache-key invalidation is modeled by a tiny dependency-free per-agent / per-file pub/sub bus, giving the same effect as invalidating `["brain", agentId, "files"]` and the file key.
- **API shapes:** `writeBrainFile`/`deleteBrainFile` return the actual MNEMO-11 `BrainWriteResult` (`{ path, commit }`), not the placeholder `BrainEntry`/`void` sketched in the spec — per "match the exact MNEMO-11 shapes." Tree callbacks normalize the backend's absolute `/brain/...` paths to the brain-relative form the route's `BrainPath` guard also accepts.
- **New shared primitives (design-system reuse):** added `LinkButton` to `frontend/src/components/ui/` (anchor styled as a Button, with a dev-gallery catalog entry) because raw `<a>` is lint-banned outside `components/ui/` and the archive download must be a real `download` anchor; added a `put` helper to `api/client.ts` (the write route is `PUT`; only get/post/patch/del existed). Everything else is built from existing UI primitives — no bespoke controls.
- **Wiring:** `BrainExplorerTab` (prop-driven, in `pages/agent/` per the spec) is mounted via a thin `components/agents/tabs/BrainTab.tsx` route adapter that reads `useParams`, mirroring the existing `AuditTab → GlassCockpit` convention. Added the `brain` route in `App.tsx` and a "Brain" entry (after "Reports") to the `AgentDetailPage` tab strip.
