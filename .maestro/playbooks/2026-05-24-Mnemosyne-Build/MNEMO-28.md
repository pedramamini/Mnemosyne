# MNEMO-28 — Reporting: email notifications via Resend on report ready/update

Phase 28 (see `MNEMO-00-ROADMAP.md`), final phase of Track E. Goal: when a report is generated or updated,
**notify the agent's owner by email** (Resend), with the delta headline in the subject/body, the chart PNG
embedded/attached, and a link to the full web report. Depends on MNEMO-03 (Resend integration + `src/email/`
+ `RESEND_API_KEY`/`APP_BASE_URL`), MNEMO-25 (archived report + retrieval API — the link target + R2 PNG
source), and MNEMO-27 (scheduling — the most common trigger of "report ready"). Per `docs/PRD.md` v0.5 §6.4:
email notification on report/update via Resend; PNG is the deliberate single artifact that embeds across web
**and email** (and the later SMS channel).

Conventions: email is a *notification*, not the report itself — keep it short (headline + delta summary +
embedded hero chart + a deep link to the full web report at `${APP_BASE_URL}/agents/:id/reports/:reportId`).
Reuse the existing `src/email/resend.ts` transport (MNEMO-03), adding a report-notification function rather
than a new transport. Sending is best-effort and must never block or fail report archival (fire from the
post-archive path, wrap in try/catch, audit the outcome). PNG embedding uses Resend attachments (with a
`cid:` inline reference) so the chart renders in-client where SVG/email-CSS would not (the §6.4 rationale).

- [x] Extend `src/email/resend.ts` (from MNEMO-03) with `sendReportNotification(env, opts)` where `opts` carries `to` (owner email), `agentName`, `reportTitle`, `deltaHeadline` (from MNEMO-26's `summarizeDelta`, or "New report" for a baseline), `reportUrl`, and optional `heroChart` (`{ filename, pngBytes }`). It POSTs to the Resend API with a minimal HTML body (subject like `"[<agentName>] <reportTitle> — <deltaHeadline>"`), a one-paragraph summary, the deep link as a button/link, and — when `heroChart` is present — the PNG as a Resend **attachment** referenced inline via `cid:` so it renders in-client. Return a typed ok/err result (do not throw on non-2xx — mirror MNEMO-03's existing pattern).

- [x] Create `src/email/report-notify.ts`: the glue `notifyReportReady(env, agentId, report): Promise<void>` that (a) resolves the owner's email — agent → `account_id` → `accounts.email` via `src/db` (MNEMO-02), (b) builds the `reportUrl` from `APP_BASE_URL` + the MNEMO-25 report route, (c) picks the hero chart (first `ChartAsset`, fetched from R2 or carried on the `GeneratedReport`), (d) calls `sendReportNotification`, and (e) emits an audit event for the outcome (a `narration`/`milestone` "Emailed report to owner" on success, an `error` on failure) via the MNEMO-21 emitter. Wrap the whole thing so a send failure is logged + audited but never propagates. Respect a per-agent/per-account notification preference if one exists (default on); leave a `// preferences` seam if MNEMO-05 settings don't yet carry it.

- [x] Wire `notifyReportReady` into the report lifecycle: call it from the post-archive path (MNEMO-25's `generateAndArchiveReport` / `archiveReport` success, and MNEMO-26's `generateDeltaReport` when a report *is* produced) via `ctx.waitUntil(...)` (or the DO equivalent) so the email send is fire-and-forget and never delays the response. Ensure the **skip path** (MNEMO-26 `skipWhenUnchanged` → no report) sends **no** email — only "ready/update" triggers a notification, matching §6.4. Add a `// MNEMO-26` comment at the skip branch confirming no notify.

- [x] Create `test/email-report-notify.test.ts` (vitest workers pool, `DB` configured, Resend fetch stubbed/mocked so no real email is sent): seed an account + agent + an archived report. Call `notifyReportReady` and assert: the Resend fetch was called once with the owner's email as `to`, the subject contains the agent name + delta headline, the body contains the `${APP_BASE_URL}/agents/:id/reports/:reportId` link, and (when a hero chart is supplied) an attachment with the PNG + a `cid:` inline reference is present. Add a case where the Resend fetch returns non-2xx and assert `notifyReportReady` does not throw and emits an `error` audit event. Add a case asserting the skip path (no report) results in zero Resend calls.

- [x] Run `npm run test`, `npm run typecheck`, and `npm run lint`; fix until all pass and report the final output. Update `AGENTS.md` repo-layout to note `src/email/report-notify.ts` (report-ready/update notifications via Resend, embedded PNG hero chart + deep link, fire-and-forget + audited, no email on the delta skip path).

  **Done.** Final output: `npm run typecheck` → clean (tsc --noEmit, no errors). `npm run lint` → `biome check .` "Checked 141 files. No fixes applied." (clean). `npm run test` → **50 test files, 294 tests passed** (incl. the new `test/email-report-notify.test.ts`, 5/5). The `Error: boom` lines in the run are the pre-existing `schedule-fanout` failure-isolation case (intentional); the trailing "close timed out" is the known vitest-pool-workers teardown quirk, not a failure. `AGENTS.md` updated: added `src/email/` to the repo-layout tree, the MNEMO-28 prose section, and the new test entry.
