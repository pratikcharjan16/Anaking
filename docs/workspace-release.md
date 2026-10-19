# Research workspace — 3.4 preview checkpoint

## Opening the update

The homepage and `/workspace/` now serve the new workspace by default.
`WORKSPACE_ENABLED=0` restores the legacy landing page; `/?legacy=1` opens it
without changing configuration. Existing Studio, Admin and respondent URLs work.
Restart the Python process after backend changes: template auto-reload alone does
not load new routes or template helpers.

## Working workflows

- Project search/status filters; creation of neutral, empty drafts.
- Project overview, automated readiness checks and a logic-reference map.
- Review comments, approval tied to a questionnaire digest, explicit publication.
- Revision inspection/restoration, published snapshots and respondent snapshots.
- Real/test-scoped descriptive analysis, single-select cross-tabs, JSON reports.
- Keyword-assisted verbatim coding with human approval.
- Research/privacy settings and affirmative consent before answers are accepted.
- Automated research guidance; optional administrator-configured model endpoint.
- Studio styling, outline/preview toggles, outline-width control and saved layout.

New responses use snapshots; old responses without snapshots remain marked
`legacy`. Existing studies keep their prior live-edit behaviour until first
publication through the workspace. Translation children must also be published
when a fully pinned translated release is required. Their parent must be live.

## Checks performed

- Python regression suite, including publication, consent, scopes and CSRF tests.
- Existing simulated voice and Studio workspace suites.
- Real headless Chromium: project creation, settings, comments, approval,
  publication, assistant, desktop/mobile loading, no horizontal mobile overflow,
  reduced-motion behaviour and uncaught-JavaScript checks.
- axe-core automated checks of the workspace homepage, project tabs and dialogs.
  Automated checks do not certify accessibility; manual assistive-technology
  testing is still required. They do not cover every existing Studio/Admin screen.

Optional browser tools are **development-only**, not application dependencies:
`playwright-core`, `axe-core`, and a Chromium executable. Run
`node scripts/dom/workspace_browser_test.cjs` with `BASE` pointing to an isolated
preview database. Use `CHROMIUM_PATH` for an installed browser. The test creates
and deletes its own study. Do not run destructive test suites against production.
The sandbox used @sparticuz/chromium plus its packaged shared libraries.

## Explicitly not released / still pending

- Model-based conjoint utilities, forecasts, weighting and significance testing:
  these are not offered by the new workspace and need independent reference-data
  validation before release. Existing conjoint descriptive outputs are not forecasts.
- Multilingual voice commands, exhaustive device/assistive-technology testing,
  and complete mobile-grid redesign.
- Translation glossary, source-change review workflow and full model-backed
  questionnaire editing. External translation availability needs deployment testing.
- Full legacy analytics cleanup: the Admin headline missing-as-zero bug is fixed,
  but historical exposure is not tracked. Missing and not-shown remain combined.
- Full account-management UI, operational backup/restore automation, live load
  testing, security penetration review and deployment rehearsal.
- Cross-tab segment filters are independent of the summary segment filter; the
  cross-tab uses the selected real/test scope and shows paired answered bases.

The optional model connection is not configured in this preview. Rules/templates
are labelled as such. A model requires administrator-supplied infrastructure and
its own capacity/licence/privacy review. No paid API is required for the default
workspace. Production still requires staff auth, a strong secret, HTTPS,
persistent storage and a production WSGI server; the preview server is not one.

## Data Validation (October 19, 2026)

Open **a project → Data Validation**, or **Fieldwork monitor/Admin → Open Data Validation**.
Owner, editor and analyst staff can review scoped responses; reviewers/viewers cannot read this contact/answer list or mutate decisions. Local preview works without staff authentication and records `local-preview` as the reviewer—not a named individual. Enable staff authentication for attributable team decisions.

- Search by numeric response ID, respondent code, name or email. Filter status, validity and real/test scope; all entries are available through pagination (50/page), not just Admin's recent 25.
- Lifecycle is independent from validation: **Non-started** means an invite/contact exists but no linked real session; **Started** means a session with no saved answers; **In progress** means saved answers; **Completed** and **Screened out** retain their lifecycle status. Telemetry/empty multi-selects alone do not count as an answer; numeric zero does.
- Invite/outbox entries are deduplicated by email, and known invitation `rid` tokens match real sessions. Multiple sessions retain separate response IDs. Non-started contacts have no response ID or invalidate action. Untracked public-link visitors and historical sessions without recorded invite tokens cannot be reliably matched to contacts. The UI makes this limitation explicit. New invite sessions preserve a valid token even if the published snapshot predates launch.
- Inspect saved answers, choose Speeder, Gibberish response, Non-contextual response, Flat-lining, or Other (specify). Other requires an explanation. Explicit confirmation is required before saving.
- Invalidation retains answers/progress and logs reason, notes, actor, UTC time and revision. Continuing/finishing the survey does not remove invalidation. Restoring requires an explanation; previous decisions remain in history. Stale review dialogs receive a conflict instead of silently overwriting a newer decision.
- Admin/Studio/workspace analytical views and standard CSV/JSON/XLSX exports exclude invalidated responses through the shared records helper. Project participation totals remain raw fieldwork totals, not valid analytical bases.
- Download the filtered contact/validation list as CSV, or explicitly export responses **including invalidated**. Raw CSV/XLSX include validation columns; raw JSON includes decision history. Contact CSV includes nonstarters; answer exports cannot contain nonexistent responses. CSV formula-like text is escaped, and XLSX strings remain literal text.
- Additive SQLite tables require no paid services/new runtime dependencies. Existing study deletion, response reset and retention deletion also clean matching validation records/history. Validation history is not an immutable archive after intentional data deletion; normal backup/retention policies still apply.

Validation: new backend coverage tests lifecycle/invites, all reasons, required notes, conflicts/restoration, retained answers, analysis/export exclusion, CSV/XLSX safety, scope/roles/CSRF, pagination and cleanup. `scripts/dom/data_validation_browser_test.cjs` creates/deletes its own project and checks the real browser save/reload/restore flow, desktop/mobile accessibility, no horizontal page overflow and Admin navigation. Use the same dev-only Playwright/axe setup as the workspace browser test. Large-study load tests and broader device/assistive-tech coverage remain pending; the current list is assembled in memory before pagination.

## Heatmap corrections

- Wide heatmaps now scroll inside the survey card and Studio preview instead of clipping columns. Cells cycle weak/moderate/strong/clear, announce their current state, and support keyboard 1–3/Delete.
- Cell changes save during the survey. Clearing sends an explicit blank so a previously saved intensity does not reappear after reload. Studio preview remains non-persistent.
- Required heatmaps check only configured cells, including rows whose codes begin with `c_`; comments/stale keys cannot satisfy the question. The test-fill helper now writes row-column cell keys.
- Workspace and Studio reports use shared cell-level aggregates and show a colored matrix with individual cell bases. Blank/cleared cells (including legacy zero, which represents no selection) are excluded, not treated as zero ratings. Numeric row/column identifiers export safely. Invalidated responses remain excluded.
- Regression coverage: `tests/test_heatmap.py` and `scripts/dom/heatmap_browser_test.cjs` (mobile scrolling, selection/clear/save/reload, required validation, keyboard entry, completion, analysis and shared Studio renderer).
