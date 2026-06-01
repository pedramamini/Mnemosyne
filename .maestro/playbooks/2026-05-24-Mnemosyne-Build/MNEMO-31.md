# MNEMO-31 — Lifecycle: Entity templates (vendor / product / investor / founder)

Phase 31 (see `MNEMO-00-ROADMAP.md`). Goal: ship the four real **entity templates** behind the
`EntityTemplate` interface MNEMO-30 defined — each contributing a **system-prompt fragment**, **default
sources**, a **default cadence**, a **report-shape hint**, and **seed notes** that bootstrap the brain.
These are the productized versions of the hand-built per-entity templates from `docs/PRD.md` §1 (vendors,
products, investors, founders). Depends on MNEMO-30 (the `EntityTemplate` interface, `TEMPLATES`
registry, `getTemplate`, and the Build flow that applies them). Per PRD §5(2), §6.3 ("Entity templates:
vendor / product / investor / founder"), and §6.4 (report shape / Obsidian front matter / computed PNG).

Conventions: one file per template under `src/agent/build/templates/`, each `export default` an
`EntityTemplate` (the interface from MNEMO-30 `src/agent/build/template.ts`). Register all four in the
`TEMPLATES` map — `"other"` stays the fallback. `systemPromptFragment`s are **additive** (composed by
MNEMO-30's `assembleSystemPrompt` after the base persona), so they describe *specialization*, not the
whole persona — what to track, what "an update" means for this entity type, what signals matter.
`defaultSources` are seed hints the agent can override, not a hard allowlist. `seedNotes` are starter
neurons with `[[wikilink]]`-friendly Obsidian front matter (MNEMO-08 parses them into the graph) so a
freshly built brain is non-empty and already linkable. `reportShapeHint` names the sections a scheduled
report should produce (consumed by MNEMO-24). No code logic beyond data + the registry wiring.

- [x] Create `src/agent/build/templates/vendor.ts`: an `EntityTemplate` with `key: "vendor"`. `systemPromptFragment`: track a vendor/supplier — pricing changes, product/SKU changes, outages/incidents, leadership + funding/M&A, contractual/compliance posture; "an update" = what materially changed for a buyer since last run. `defaultSources`: vendor status page, pricing page, changelog/release notes, newsroom/press, and a news query for the vendor name. `defaultCadenceCron`: weekly (e.g. `"0 13 * * 1"`). `reportShapeHint`: sections — "What changed", "Pricing & packaging", "Reliability/incidents", "Company & funding", "Risk flags". `seedNotes`: a `/brain/notes/vendor-profile.md` stub with front matter (`type: vendor`, `tags: [vendor]`) and a `[[Pricing]]` + `[[Incidents]]` link scaffold.

- [x] Create `src/agent/build/templates/product.ts`: an `EntityTemplate` with `key: "product"`. `systemPromptFragment`: track a product/technology — releases + changelogs, feature launches, deprecations/breaking changes, roadmap signals, community/issue sentiment, competitive positioning; "an update" = shipped/announced changes since last run. `defaultSources`: official changelog/release notes, docs, GitHub releases/issues (if applicable), product blog, and a news query. `defaultCadenceCron`: weekly. `reportShapeHint`: "What shipped", "Deprecations/breaking", "Roadmap signals", "Community sentiment", "Competitive notes". `seedNotes`: `/brain/notes/product-profile.md` with front matter (`type: product`) and `[[Releases]]` + `[[Roadmap]]` scaffolding.

- [x] Create `src/agent/build/templates/investor.ts`: an `EntityTemplate` with `key: "investor"`. `systemPromptFragment`: track an investor/fund — new investments + rounds led/participated, fund announcements + AUM, thesis/focus shifts, partner moves, portfolio news; "an update" = new deals/positions/statements since last run. `defaultSources`: the fund's site/portfolio page, partner posts/blog, SEC/regulatory filings where public, and a news query for the firm + key partners. `defaultCadenceCron`: weekly. `reportShapeHint`: "New activity", "Thesis & focus", "Partner moves", "Portfolio highlights", "Signals worth a meeting". `seedNotes`: `/brain/notes/investor-profile.md` with front matter (`type: investor`) and `[[Portfolio]]` + `[[Thesis]]` scaffolding.

- [x] Create `src/agent/build/templates/founder.ts`: an `EntityTemplate` with `key: "founder"`. `systemPromptFragment`: track a founder/person — company role + transitions, public statements/posts/talks, fundraising, hiring signals, narrative/reputation shifts; "an update" = new public activity or role changes since last run; respect that this is a public-figure professional dossier, not surveillance — public sources only. `defaultSources`: the person's posts (X/LinkedIn-style public profiles), their company site/news, interviews/podcasts, and a news query for the name. `defaultCadenceCron`: weekly. `reportShapeHint`: "Recent activity", "Role & company", "Fundraising/hiring", "Public statements", "Network signals". `seedNotes`: `/brain/notes/founder-profile.md` with front matter (`type: founder`) and `[[Company]]` + `[[Statements]]` scaffolding.

- [x] Wire the four templates into the registry in `src/agent/build/template.ts`: import the four `EntityTemplate` defaults and register them in the `TEMPLATES` map under their keys so `getTemplate("vendor"|"product"|"investor"|"founder")` returns the real template and `getTemplate("other")` / unknown keys still fall back to the `"other"` default. Remove the `// MNEMO-31 registers …` placeholder comment. No interface changes — MNEMO-30 owns the shape.

- [x] Create `test/templates.test.ts` (vitest workers pool): for each of the four keys assert `getTemplate(key).key === key`, that `systemPromptFragment`/`reportShapeHint` are non-empty, `defaultSources.length > 0`, `defaultCadenceCron` is a valid 5-field cron string (simple regex check), and every `seedNotes[].path` starts with `/brain/`. Add a cross-cutting test that `getTemplate("other")` and an unknown key both return the `"other"` fallback (no throw). Add one integration-style assertion: `assembleSystemPrompt({ spec, template: getTemplate("vendor") })` (MNEMO-30) contains the vendor fragment text — proving the fragment composes into the operating prompt.

- [x] Run `npm run test`, `npm run typecheck`, and `npm run lint`; fix until all pass and report the final output. Update `AGENTS.md` to note `src/agent/build/templates/` holds the four entity templates and that adding a new template = one file + one `TEMPLATES` registry entry (behind MNEMO-30's `EntityTemplate` interface).

---

**Completion notes (MNEMO-31):**

- Created the four entity templates one-per-file under `src/agent/build/templates/` (`vendor.ts`, `product.ts`, `investor.ts`, `founder.ts`), each `export default` an `EntityTemplate`: additive `systemPromptFragment`, `defaultSources` (seed hints), weekly `"0 13 * * 1"` `defaultCadenceCron`, the spec'd `reportShapeHint` sections, and a `/brain/notes/<lens>-profile.md` seed note with Obsidian front matter (`type`/`tags`) + `[[wikilink]]` scaffolding (vendor `[[Pricing]]`/`[[Incidents]]`, product `[[Releases]]`/`[[Roadmap]]`, investor `[[Portfolio]]`/`[[Thesis]]`, founder `[[Company]]`/`[[Statements]]`). Founder fragment explicitly scopes to public-sources-only / not surveillance.
- Wired all four into the `TEMPLATES` map in `src/agent/build/template.ts` (imports + entries); removed the `// MNEMO-31 registers …` placeholder comment and refreshed the registry docstring. `"other"` stays the fallback; no interface changes (MNEMO-30 owns the shape). Type-only `EntityTemplate` import in each template keeps the registry↔template cycle runtime-safe.
- Added `test/templates.test.ts`: `describe.each` over the four keys asserts own-`key`, non-empty fragment/report hint, `defaultSources.length > 0`, 5-field cron regex, and every `seedNotes[].path` starts with `/brain/`; plus `"other"`/unknown-key fallback (no throw) and a composition check that `assembleSystemPrompt({ spec, template: getTemplate("vendor") })` contains the vendor fragment.
- Updated `test/build-prompt.test.ts`: its old "vendor/founder fall back to other" assertion now contradicted the registered templates, so it asserts the real lenses resolve to their own keys and a separate case keeps the unknown-key→`"other"` fallback.
- Final results: `npm run typecheck` clean; `npm run lint` (biome) clean (fixed one import-sort in the new test); `npm run test` → **55 files / 338 tests passed** (the `Error: boom` lines are `schedule-fanout.test.ts`'s intentional throw, not a failure). Updated `AGENTS.md` (Build section prose, the test tree, and the test summary) to document `src/agent/build/templates/` and the "one file + one registry entry" extension rule.
