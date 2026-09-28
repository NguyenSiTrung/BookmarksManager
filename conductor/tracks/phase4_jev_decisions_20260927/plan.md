# Phase 4 Jev Decisions — Implementation Plan

**Goal:** Deliver PROJECT_PLAN.md §15 Phase 4: Jev decisions on real bookmark metadata (categorize, tags,
folder pre-select, near-duplicates, misfiled scan, search re-rank), the §10.2 confidence policy, the review
queue with apply and undo, the audit log, the resumable job queue, cost tracking, and the "Data sent" log,
all behind a new per-provider bookmark-data consent.

**Spec:** `conductor/tracks/phase4_jev_decisions_20260927/spec.md`.

## Global Constraints

- Metadata only: no page text, content script, `scripting`, or Readability. No new permissions.
  `CONSENT_VERSION` becomes 2, and the `store/` docs change **in the same task** that introduces the new
  data flow (Phase 2 Task 1).
- `fetch` stays in `src/net/**`, `z` is imported only from `src/schemas/z.ts`, handlers are total, and
  errors are redacted (never read bodies on non-2xx; no `cause` that can hold response content).
- `src/decisions/minimize.ts`, `candidates.ts`, `policy.ts`, and `src/jev/tasks/*` stay pure (no
  `chrome`, DOM, React, or `fetch`).
- Per task: failing test → implement → narrow checks → update the plan and `learnings.md` → commit the
  intended files locally → `git notes add -m "…"` → close the mapped Beads task. Never push, pull, fetch,
  or `bd dolt push`.
- Phase-end tasks are **automated checkpoints**: the full gate (`lint` → `typecheck` → `test -- --run` →
  `build` → `check:manifest` → `check:bundle` → `xvfb-run -a npm run test:e2e`), with evidence recorded in
  `learnings.md`, marked complete when green. **The only user verification is the last task of the
  track.**
- Parallel workers own only their annotated files, in isolated `.worktrees/` worktrees. The coordinator
  serializes shared files (`package.json`, `package-lock.json`, `src/entrypoints/background.ts`,
  `src/db/database.ts`, `plan.md`, `learnings.md`, `PROJECT_PLAN.md`, `conductor/*.md`), Beads status, and
  commits and notes.
- `PROJECT_PLAN.md` carries uncommitted user edits. Never overwrite or commit them without asking.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| State schema / minimization | `src/schemas/decision-state.ts`, `src/decisions/minimize.ts` | Closed `DecisionState`, URL cleaning, blocklist, notes exclusion |
| Candidates | `src/decisions/candidates.ts` | Tag/folder/pair/rerank shortlists computed in code |
| Policy | `src/decisions/policy.ts` | §10.2 bands, per-kind auto-apply settings, pre-select, no-match bar |
| Question sets | `src/jev/tasks/*.ts` | `defineDecision` sets plus `questionSetVersion` |
| Consent / gate | `src/consent/*`, `src/schemas/provider.ts`, `src/net/send.ts` | `jev_decisions` scope, v2, strict state guard |
| Persistence | `src/db/database.ts`, `src/schemas/{job,audit,usage}.ts` | Dexie v3 `jobs`, `audit`, `usage` |
| Store / apply | `src/decisions/store.ts`, `src/decisions/apply.ts` | Decision rows, approve/reject/revert, undo, audit |
| Pipeline | `src/decisions/pipeline.ts`, `src/decisions/rerank.ts` | Minimize → candidates → Jev → policy → persist |
| Jobs | `src/jobs/*.ts` | Resumable batches, pause/cancel, cost estimate |
| Messages | `src/messages/decisions.ts`, `src/entrypoints/background.ts` | Total worker handlers for every decision intent |
| UI | `src/entrypoints/{options,popup,sidepanel}/*` | Consent, settings, sent log, save suggestions, review, scan, Ask |
| Store docs | `store/*.md`, `tests/unit/consent-snapshot.test.ts` | Disclosures matching the shipped data flow |
| Tests | `tests/e2e/decisions.spec.ts`, `tests/live/*` | E2E decisions flow, live categorize smoke |

---

## Phase 1: Pure decision foundations
<!-- execution: parallel -->
<!-- depends: -->

- [x] Task 1: `DecisionState` schema and data minimization — `4f2c5d4` + fix `7716a29` (worker `wt/p4-p1t1` `4c0541d`,`c0cd218`); review Approved after 1 fix round
  <!-- files: src/schemas/decision-state.ts, src/decisions/minimize.ts, tests/unit/decision-state.test.ts, tests/unit/decisions-minimize.test.ts -->
  - [x] Failing tests: valid/invalid `DecisionState` fixtures (strict: unknown keys rejected); URL cleaning
        strips query, fragment, and userinfo (IDN, ports, trailing `?`/`#` cases); the blocklist matches
        banking/health/webmail samples, `file://`, private and loopback IPv4/IPv6, and dotless hosts; user
        entries are added and removed; notes are never present in a minimized state
  - [x] Implement

- [x] Task 2: Candidate pre-filters — `fcd902d` (worker `wt/p4-p1t2` `c5f4be8`); review Approved
  <!-- files: src/decisions/candidates.ts, tests/unit/decisions-candidates.test.ts -->
  - [x] Failing tests: the tag shortlist is capped at 30 and ranked by keyword/domain overlap
        deterministically; the folder shortlist is capped at 50, plus `none`, and always includes the
        current folder for misfiled; near-duplicate pairs require the same domain and a similar title and
        exclude URL-normalized duplicates; the rerank shortlist takes the top 30 from `runQuery`; stable
        ordering; empty-library cases
  - [x] Implement

- [x] Task 3: Confidence policy — `da4f2f9` (worker `wt/p4-p1t3` `25c1825`); review Approved
  <!-- files: src/decisions/policy.ts, tests/unit/decisions-policy.test.ts -->
  - [x] Failing tests: every §10.2 band boundary (0.5, 0.7, 0.85, inclusive/exclusive); auto-apply toggles
        default to off; `move`/`merge_duplicates` never auto-apply at any confidence; pre-select at ≥ 0.7
        only; the no-match bar; the escalation stub returns `unsure`; the settings schema rejects unknown
        kinds
  - [x] Implement

- [x] Task 4: Question sets — `2b07995` + fix `9e7c1bd` (worker `wt/p4-p1t4` `4ad98a9`,`df8754e`); review Approved after 1 fix round
  <!-- files: src/jev/tasks/categorize.ts, src/jev/tasks/tags.ts, src/jev/tasks/placement.ts, src/jev/tasks/misfiled.ts, src/jev/tasks/near-duplicate.ts, src/jev/tasks/rerank.ts, src/jev/tasks/index.ts, tests/unit/jev-tasks.test.ts -->
  <!-- depends: task1 -->
  - [x] Failing tests: JSON snapshots of `build()` for each set; `instructions` always present; questions
        refer to state fields in backticks; option keys equal the candidate IDs; each set exports a
        `questionSetVersion`; typed `run()` against a fake client maps values and confidence; the 255-option
        and 64k guards hold at the candidate caps
  - [x] Implement

- [x] Task 5: Phase 1 automated checkpoint — full gate green, evidence in `learnings.md`
  - Gate (main @ `696c5e3`): lint 0 errors (1 pre-existing TanStack warning) · typecheck clean ·
    `npx vitest run` **73 files / 2133 tests pass** (+344 vs Phase 3 baseline 1789) · build 1.09 MB ·
    `check:manifest` OK · `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**

## Phase 2: Consent, gate, and persistence
<!-- execution: sequential -->
<!-- depends: phase1 -->

- [x] Task 1: `jev_decisions` consent scope, `CONSENT_VERSION` 2, and store disclosures — `2f1456c` + `e9f4a6a` + fix `3c17af0` (worker `wt/p4-p2t1`); review Approved after 1 fix round
  <!-- files: src/schemas/provider.ts, src/consent/records.ts, src/consent/disclosure.ts, store/privacy-policy.md, store/privacy-practices.md, store/permissions.md, store/listing.md, store/reviewer-notes.md, tests/unit/consent.test.ts, tests/unit/consent-snapshot.test.ts -->
  - [x] Failing tests: grant/revoke/has per `(scope, origin)`; v1 records read as stale for both scopes;
        revoke removes both scopes; the disclosure constants list the exact `DecisionState` fields and
        triggers; the consent snapshot test fails when sent fields change without a version bump and
        matching `store/` text
  - [x] Implement; update the `store/` docs nearly verbatim from the disclosure constants
  - Sanctioned cross-file edits: `src/net/send.ts` fail-closed `jev_decisions` placeholder (replaced by
    Task 2); `src/messages/provider.ts` revoke/unwind via `revokeProviderConsents`; `tests/e2e/provider.spec.ts`
    + `tests/unit/schemas.test.ts` consent-version literals

- [x] Task 2: Gate registration and strict state guard — `045391a` + fix `0abeebb` (worker `wt/p4-p2t2`); review Approved after 1 fix round
  <!-- files: src/net/send.ts, tests/unit/network-gate.test.ts -->
  - [x] Failing tests: `jev_decisions` admits only `DecisionState`-conforming requests; it refuses unknown
        fields, dirty URLs, and blocklisted URLs with `request_not_allowed` before any consent, permission,
        or key read (spy counts); `jev_test` behavior is unchanged; `sentLog.feature` records the scope
  - [x] Implement

- [x] Task 3: Dexie v3 — `jobs`, `audit`, `usage` — `2552cb0` (worker `wt/p4-p2t3`); review Approved
  <!-- files: src/db/database.ts, src/schemas/job.ts, src/schemas/audit.ts, src/schemas/usage.ts, tests/unit/database-v3.test.ts, tests/fixtures/phase4.ts -->
  - [x] Failing tests: a genuine v2 → v3 migration preserves rows; valid/invalid fixtures per new schema;
        delete-all still wipes the new tables; update the existing verno/table-list assertions in the same
        commit
  - [x] Implement
  - Canonical names for downstream tasks: `JobKind` = `"analyze_selection" | "library_scan"` (snake_case,
    matching `Decision` kinds); indexes `jobs: "id,status,createdAt"`, `audit: "++id,decisionId,changedAt"`,
    `usage: "++id,jobId,recordedAt"`; audit timestamp `changedAt`, usage timestamp `recordedAt`

- [x] Task 4: Decision store, apply, and audit — `f776738` + fix `7026979` (worker `wt/p4-p2t4`); review Approved after 1 fix round
  <!-- files: src/decisions/store.ts, src/decisions/apply.ts, tests/unit/decisions-store.test.ts, tests/unit/decisions-apply.test.ts -->
  - [x] Failing tests: persist/list/pending queries; approve applies through tag ops, category ops, `moveNode`,
        or the duplicate merge, each with an undo snapshot; reject/revert transitions; an illegal transition
        is refused; bulk approve is per-row atomic; every transition writes one audit row with no content;
        a stale decision (bookmark gone or moved since) is refused
  - [x] Implement
  - Ruling: `mark_dead`/`create_folder`/`rename` refused `unsupported` is correct (spec Out-of-Scope: 1.1 /
    Phase 5); documented in the module header. Apply↔status atomicity closed via id-targeted compensating undo
    + typed `state_unrecorded`.

- [x] Task 5: Phase 2 automated checkpoint — full gate green, evidence in `learnings.md`
  - Gate (main @ `7026979`): lint 0 errors (1 pre-existing TanStack warning) · typecheck clean ·
    `npx vitest run` **77 files / 2260 tests pass** (+127 vs Phase 1) · build 1.10 MB ·
    `check:manifest` OK · `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**

## Phase 3: Worker pipeline
<!-- execution: sequential -->
<!-- depends: phase2 -->

- [x] Task 1: Analyze pipeline
  <!-- files: src/decisions/pipeline.ts, tests/unit/decisions-pipeline.test.ts -->
  - [x] Failing tests against the mock Jev server: minimize → candidates → question sets → client
        (`jev_decisions`) → answer-ID check → policy → persisted decisions and usage; blocklisted bookmarks
        are skipped and never sent; auto-apply happens only with the toggle on; `source.model` comes from
        the response; typed failures are surfaced without content
  - [x] Implement
  <!-- landed f198780 + fix 64b6df3 (1 fix round). Auto-apply now records `auto_applied` via a
       parameterized `approveDecision(id, actor, target)`; usage is recorded before persist (FR8);
       `analyzeBookmark` wraps all throws through `toPipelineError`. 13 pipeline tests. -->

- [x] Task 2: Rerank service
  <!-- files: src/decisions/rerank.ts, tests/unit/decisions-rerank.test.ts -->
  - [x] Failing tests: the shortlist of 30 is sent in one request; results are sorted by probability; the
        no-match bar applies; the query is sent only as `DecisionState.query`; an empty or local-only result
        makes no request
  - [x] Implement
  <!-- landed 9d6d176 + fix ad0a81e (1 fix round). rerankSearch: rerankCandidates projection, one
       jev_decisions request, positional post-skip cross-check, probability sort + isNoMatch, one usage
       row per egress. Own RerankError (Task 4 mapper must key on .code). 16 tests. Deferred:
       usage-on-answer_mismatch (BookmarksManager-eov); tie-break test is characterization-only. -->

- [x] Task 3: Job queue
  <!-- files: src/jobs/queue.ts, src/jobs/runner.ts, src/jobs/estimate.ts, tests/unit/jobs-queue.test.ts, tests/unit/jobs-runner.test.ts -->
  - [x] Failing tests: enqueue analyze-selection and library-scan jobs; batches persist progress; a simulated
        worker restart resumes from the last committed batch without re-sending it; pause, resume, and
        cancel; the cost estimate comes from `estimateTokens`; per-job usage totals
  - [x] Implement
  <!-- landed 9b943ad + fix 60868e0 (1 fix round). `batchSize` is persisted on the Job row and is
       authoritative on resume (a differing override fails closed). Mid-batch failure no longer throws
       illegal_transition on a pause/cancel race. 29 jobs tests. Deferred minors: cursor semantics;
       usage double-write; partial-batch writes; tokens-only estimate. -->

- [x] Task 3b: Near-duplicate scan for library_scan (closes the FR7 gap found in the Task 3 review)
  <!-- files: src/decisions/duplicates.ts, src/jobs/queue.ts, src/jobs/runner.ts, tests/unit/decisions-duplicates.test.ts, tests/unit/jobs-runner.test.ts -->
  - [x] Failing tests: near-duplicate pairs each send one `jev_decisions` request (`{bookmark,pairPartner}`);
        level→confidence maps to the §10.2 `merge_duplicates` band (review ≥ 0.5, never auto-apply);
        blocklisted sides skipped; a `library_scan` job runs the pair phase and resumes without re-sending
  - [x] Implement
  <!-- landed 0d2a609 + fix 142e17f (1 fix round). New src/decisions/duplicates.ts
       (scanNearDuplicates; levelToConfidence 1→0/2→0.4/3→0.75/4→1.0; merge_duplicates policy, never
       auto-apply; one usage per egress; keepId = pair a side). jobChecks(library_scan) signals
       near_duplicate; the runner's pair phase fails closed without a scanDuplicates dependency.
       Deferred: cap nearDuplicatePairs + fold pair count into the estimate (BookmarksManager-2qk);
       below-floor merge rows; mid-batch-resume duplicate rows. -->

- [x] Task 4: Worker messages and background wiring
  <!-- files: src/messages/decisions.ts, src/entrypoints/background.ts, tests/unit/decisions-messages.test.ts -->
  - [x] Failing tests: Zod-validated intents (analyze, save-suggest, rerank, job start/pause/resume/cancel,
        approve/reject/revert/bulk-approve, settings); total handlers; trusted-sender checks; job resume on
        worker startup; no key material crosses the boundary
  - [x] Implement
  <!-- landed 2f2ffe1 + fix 11ccd5f (1 fix round). 14-intent Zod union; total handler; runner wired with
       BOTH createPipelineAnalyzer + createDuplicateScanner; error mapper keys on .code. Fix enforced the
       user blocklist end-to-end (new src/decisions/blocklist.ts + gate defense-in-depth) and made
       resumeJobs resume running/pending only (a user-paused job stays paused). Deferred minors:
       activeProvider preference; not_enabled code; resolveWorkSet double-read; trusted-sender breadth. -->

- [x] Task 5: `sentLog` retention cap and clear (closes `BookmarksManager-sd1`)
  <!-- files: src/net/sent-log.ts, src/net/send.ts, tests/unit/sent-log.test.ts -->
  - [x] Failing tests: the cap trims the oldest rows; clear empties the log; rows never hold content
  - [x] Implement
  <!-- landed 1fd4107 (review APPROVED). New src/net/sent-log.ts: SENT_LOG_RETENTION_CAP=500,
       appendSentLog (add + index-bounded prune of the oldest excess in one rw transaction), clearSentLog
       (returns removed count). send.ts routed through it (unchanged ordering/fields). 9 tests. Deferred
       minors: a failed appendSentLog aborts the caller (pre-existing); cap not configurable; no
       cap-is-positive-int test. Phase 4 must consume clearSentLog + the cap in the "Data sent" view. -->

- [x] Task 6: Phase 3 automated checkpoint — full gate green, evidence in `learnings.md`
  - Gate (main @ `bafdd3f`): lint 0 errors (1 pre-existing TanStack warning) · typecheck clean ·
    `npx vitest run` **84 files / 2373 tests pass** · build 1.16 MB · `check:manifest` OK ·
    `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**

## Phase 4: UI surfaces
<!-- execution: parallel -->
<!-- depends: phase3 -->

- [x] Task 1: Options — decisions consent, auto-apply toggles, blocklist editor, Data sent log, cost totals
  <!-- files: src/entrypoints/options/ProviderSetup.tsx, src/entrypoints/options/DecisionSettings.tsx, src/entrypoints/options/SentLog.tsx, src/entrypoints/options/main.tsx, tests/components/options-decisions.test.tsx -->
  - [x] Failing tests: the decisions disclosure renders every field, trigger, and link, with the checkbox
        unchecked; Enable is disabled until the box is checked; the v1→v2 re-disclosure shows; toggles
        persist and default to off; blocklist add/remove; the sent log shows metadata only; clear
  - [x] Implement
  <!-- landed ea647ae (worker 636a4b0) + fix 9e6bed8 (worker 981f3d9). Review APPROVED_WITH_CONCERNS
       → fix → re-review APPROVED. DecisionSettings.tsx (consent screen via direct Dexie
       grantConsent/revokeConsent/hasConsent on the jev_decisions scope; auto-apply toggles via
       SET_SETTINGS; blocklist via SET_BLOCKLIST + read-only BUILTIN_SENSITIVE_SITES) + SentLog.tsx
       (db.sentLog metadata-only + clearSentLog + SENT_LOG_RETENTION_CAP note; db.usage cost totals).
       25 tests. Fix: retryable load-failure state (was a perpetual "Loading…") + preset-tagged consent
       read (no stale-panel flash across a provider switch). -->

- [x] Task 2: Popup save suggestions
  <!-- files: src/entrypoints/popup/App.tsx, src/entrypoints/popup/Suggestions.tsx, tests/components/popup-suggestions.test.tsx -->
  - [x] Failing tests: the save form renders without waiting on Jev; the folder is pre-selected only at
        ≥ 0.7; tag and category chips are accepted by click; a user change is never overridden by a late
        suggestion; no request is made without consent; blocklisted pages show "not sent"
  - [x] Implement
  <!-- landed 83ef212 (worker f89aade) + worker fix c6178f1 (9f09c43) + popup fix 57beb00 (d424577).
       Review APPROVED_WITH_CONCERNS → fixes. Suggestions.tsx + App.tsx wiring; SAVE_SUGGEST gated on a
       local hasConsent(jev_decisions); suggestions read back from db.decisions by the synthetic
       "popup:<uuid>" id; folder pre-select only at ≥0.7 and only if untouched (touched-flag refs);
       chips opt-in; "not sent" for blocklisted. Worker fix: saveSuggest now runs under
       SAVE_SUGGEST_SETTINGS (auto-apply all-off) so the proposal flow never auto-applies to the
       nonexistent synthetic id (red-check: previously apply_failed hid the chips). Popup fix: the
       one-shot effect depends on [ready, suggestId] + reads payload from a ref so keystrokes don't tear
       down the in-flight request. 13 tests. Deferred: orphaned popup: rows (BookmarksManager-f7c). -->

- [x] Task 3: Side-panel Review view and Analyze actions
  <!-- files: src/entrypoints/sidepanel/ReviewView.tsx, src/entrypoints/sidepanel/views.ts, src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/BookmarkList.tsx, src/entrypoints/sidepanel/BulkBar.tsx, tests/components/review-view.test.tsx -->
  - [x] Failing tests: pending decisions listed with confidence shading and kind; approve, reject, and bulk
        approve; the undo toast reverts; Analyze per row and from the bulk bar; accessible names and
        keyboard operation
  - [x] Implement
  <!-- landed 1715dbb (worker 9edba9b). Review APPROVED (18 tests). ReviewView.tsx (queue ordered by
       createdAt; confidence bands pinned to AUTO_APPLY_THRESHOLD/REVIEW_FLOOR, never color-only;
       approve/reject/revert gated by isLegalTransition; one BULK_APPROVE reporting applied/failed;
       undo toast wired to REVERT_DECISION with arm/disarm) + views.ts review kind (resolveView → []) +
       App.tsx nav/header + pane swap + per-row Analyze + BulkBar selection Analyze. reviewQueue()
       EXCLUDES synthetic popup: ids (Risk B) with a visible "waiting on an unsaved bookmark" count; a
       stale REAL id still renders/approves. Deferred minors: sidebar nav doesn't clear an active search;
       failed-revert toast lacks retry; decisionRevertRef not disarmed on auto-hide; test-name nit;
       optional panel-helper extraction. -->

- [x] Task 4: Library-scan launcher — `99ef757` + fix `124c32c`/`aabe019` (worker `wt/p4-p4t4` `1fbb99e`); review APPROVED_WITH_CONCERNS → concerns resolved
  <!-- files: src/entrypoints/sidepanel/ScanPanel.tsx, tests/components/scan-panel.test.tsx -->
  <!-- depends: task3 -->
  - [x] Failing tests: the cost estimate is shown before start; progress, pause, resume, cancel; running
        cost; the resumed state renders after reopening
  - [x] Implement (the coordinator wires it into `App.tsx`)
  <!-- landed 99ef757 (worker 1fbb99e, wt/p4-p4t4) + coordinator wiring b804f51 + fix 124c32c +
       re-review follow-up aabe019. ScanPanel.tsx: minimized {id,title,url} props; estimateJobCost
       lower bound ("at least ~N tokens across M batches") before Start (FR7); Start →
       JOB_START(library_scan, ids); live card via useLiveQuery (progress/usage/cost,
       Pause/Resume/Cancel), terminal states with a per-row "New scan" dismissal (a NEW later row always
       shows), {ok:false} rendered verbatim; the Dexie row is the source of truth (a reopened panel
       renders the persisted state). Fix: the querier returns a null sentinel so Start stays disabled
       until the first live read resolves (no start race on an unsurfaced running row). Cross-task in
       background.ts: JOB_START/JOB_RESUME provider-gated before any row flip (typed invalid_input
       refusal the panel renders verbatim), resume fire-and-forget relaunches the runner (injectable
       relaunchJob seam), runPersistedJob only drives running/pending rows and marks a JobRunnerError
       strand failed instead of stranding silently. 13 component tests + 7 background-jobs tests.
       Review: APPROVED_WITH_CONCERNS → re-review APPROVED_WITH_CONCERNS with 3 resume-path Importants →
       fixed in aabe019 exactly as the reviewer prescribed. Deferred minors: role="status" wraps the
       whole card; dismissal resets on a radix remount (covered by the new-row override test);
       DecisionMessage.parse throw (unreachable); FR7 tokens-only wording (Phase 3 deferral). -->

- [x] Task 5: Ask toggle and no-match state — `4855f49` + fix `124c32c` (worker `wt/p4-p4t5` `fe10f78`); review APPROVED
  <!-- files: src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/ask.tsx, tests/components/search-ask.test.tsx -->
  <!-- depends: task3 -->
  - [x] Failing tests: the Ask toggle is visible only with consent; results are reranked in order; "no
        match" shows; plain search stays local and makes zero requests when Ask is off
  - [x] Implement
  <!-- landed 4855f49 (worker fe10f78, wt/p4-p4t5) + coordinator wiring b804f51 + fix 124c32c. ask.tsx
       useAskSearch (consent-gated toggle via a live consents read at CONSENT_VERSION; 350 ms debounce;
       stale-reply guard via a request counter; ranked/no-match/skipped/error notes via askNoteText) +
       SearchBar role="switch" toggle + optional onRerankOrder; App.tsx tags the order with the query it
       answered and applies it as a pure permutation of that query's results only (a new query renders
       local order until its own reply lands). Fixes: the dispatch sends the TRIMMED query (the note
       comparison matches); applyRerankOrder ranks a repeated id once (a duplicated verdict can no
       longer duplicate a row and drop an unranked one). 12 search-ask tests + 3 sidepanel-scan-ask
       App-level tests. Deferred minors: a re-typed identical query reuses the old "Ranked by Ask."
       note for ~350 ms (benign); the sub-frame Ask-off reply race is self-correcting; mid-flight drop
       tests; the default relaunch (real runPersistedJob with a live provider) is seam-tested only —
       Phase 5 Task 1's e2e must exercise the resume relaunch end to end (re-review Minor 7). -->

- [x] Task 6: Phase 4 automated checkpoint — full gate green, evidence in `learnings.md`
  <!-- landed 31eb12b. Gate at 31eb12b: lint 0 errors (1 pre-existing TanStack warning) · typecheck
       clean · vitest 92 files / 2466 tests · build 1.20 MB · check:manifest OK · check:bundle OK ·
       e2e 13/13 (after fixing a PRE-EXISTING P4.T1 strict-mode locator ambiguity the checkpoint
       surfaced — getByLabel("Provider") also matched the Data-sent-to-providers section). -->

## Phase 5: End-to-end, live, and docs
<!-- execution: sequential -->
<!-- depends: phase4 -->

- [x] Task 1: Decisions e2e
  <!-- files: tests/e2e/decisions.spec.ts, tests/e2e/helpers/decisions.ts -->
  - [x] Specs against the routed fake provider: no consent → zero egress; consent → Analyze → approve →
        undo; save with folder pre-select; Ask rerank and no-match; library scan resumes after a worker
        restart; exactly one `sentLog` row per request; request bodies contain no notes, query strings, or
        blocklisted URLs; the existing zero-egress specs still pass — `37c7c18` + review fixes `98a611d`;
        review Approved-with-fixes, both Importants + 3 Minors fixed. Sanctioned helper edits:
        `tests/e2e/helpers/provider.ts` (copy-once extension root, `tabs` injection, `--host-resolver-rules`
        for persistent profiles; backwards-compatible defaults, existing 13 specs untouched)

- [x] Task 2: Performance and live smoke
  <!-- files: tests/unit/decisions-perf.test.ts, tests/live/decisions.live.test.ts -->
  - [x] Analyze-on-save under 1.5 s against the mock server; the popup-open and 10k search gates hold; key-gated live
        categorize on fixture bookmarks against TypeSafe and OpenRouter, skipped when keyless — `e190e29` + review
        fixes `cacd084`; review Approved-with-fixes (sentLog bypass disclosure corrected + pinned; corpus 10k).
        Observed: analyze-on-save median 55.5 ms / max 67.0 ms at 10k (budget 1.5 s); popup-open gate
        (`popup-save.test.tsx` < 150 ms) and 10k search gate (`search-perf.test.ts`) green in the same run;
        `npm run test:live` keyless → 4 skipped

- [ ] Task 3: Docs sync and follow-ups
  - [ ] Update PROJECT_PLAN.md §1.1 / §13.3 / §15 (after asking about the pending user edits),
        `conductor/product.md`, and `conductor/tech-stack.md`; elevate patterns to `conductor/patterns.md`
  - [ ] File Beads follow-ups: opt-in page-text extraction (content script, `scripting`, Readability,
        page-text consent) and the title-quality check

- [ ] Task 4: Final automated checkpoint — full gate green, evidence in `learnings.md`

- [ ] Task 5: Conductor - User Manual Verification 'Phase 4 Jev decisions' (Protocol in workflow.md)
