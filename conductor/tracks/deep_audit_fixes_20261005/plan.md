# Deep Audit Fixes Implementation Plan

<!-- Last Revised: 2026-10-04 — task 1 error-mapping ownership -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` or `executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax. Read the spec and the
> task's mapped Beads issue before claiming work.

**Goal:** Resolve all findings of the 2026-10-04 whole-codebase audit with
permanent regressions, fail-closed privacy gates, bounded work and honest
accounting.

**Architecture:** Preserve existing Chrome/Dexie/service-worker boundaries.
Make gates enforce what the README promises, make jobs and decisions
idempotent and resumable, make undo target the displayed action, and keep
Dexie changes additive.

**Tech Stack:** WXT MV3, strict TypeScript 6, React 19, Dexie 4, jitless Zod 4,
MiniSearch 7, Vitest 5/Testing Library, Playwright Chromium.

**Spec:** `conductor/tracks/deep_audit_fixes_20261005/spec.md`

## Global Constraints

- **User override (2026-10-05): automated gates only, no manual checks at any
  phase or at completion.** Continue after an automated checkpoint passes;
  stop on failed/blocked checks.
- **Verify-first:** every behavior task starts with a failing regression
  against current code. If it cannot fail, record the evidence in
  `learnings.md`, skip the behavior change, keep the test only if it guards a
  plausible regression. Findings are static-analysis results, not reproduced
  bugs.
- Phases are sequential. Within a phase, only tasks with disjoint `files`
  and no `depends` run concurrently. The coordinator owns track files, Beads
  operations, commits and git notes.
- File lists are ownership boundaries, not permission for incidental
  refactors. Use `xd://lsp` references before changing an exported symbol; if
  a new shared file is needed, revise ownership before dispatching concurrent
  work. Test files named by the task live under `tests/unit`,
  `tests/components` or `tests/e2e`; each task owns the test files it adds or
  edits.
- Files created by this track (all others already exist):
  `src/jobs/keepalive.ts`, `src/messages/save.ts`,
  `src/schemas/import-state.ts`, `src/ui/components/ErrorBoundary.tsx`,
  `tests/e2e/audit-deep-fixes.spec.ts`.
- No implementation starts during track creation. All tasks begin pending.
- Native bookmarks stay authoritative; managed/root guards and total message
  result unions stay intact. Zod only via `src/schemas/z.ts`. Provider fetch
  stays under `src/net/**`. Dexie changes are additive.
- Only new permission: `alarms` (Phase 3 task 2), with
  `store/permissions.md` justification and a passing `check:manifest`.
- Reuse existing Beads `BookmarksManager-2v9`, `-eov`, `-7k4`, `-bih`;
  preserve their history and append this track's context.
- Per behavior task: failing regression → minimal fix → targeted green tests →
  applicable local gate slice (`lint` → `typecheck` → `test -- --run` →
  `build` → `check:manifest` → `check:bundle`; `check:store`/`check:site` when
  touching `store/`/`site/`; e2e when touching entrypoints or egress) →
  coordinator updates plan/learnings → local commit + `git notes add` →
  close mapped Bead. Review staged diff; preserve unrelated/untracked work
  (`.beads/.auto-import-issues.jsonl`).
- Never automatically push, pull, fetch or `bd dolt push`. `test:live` and
  `test:eval` stay outside the keyless gate. Fresh profiles and synthetic data
  only; never real keys.

## File and Interface Map

| Area | Files / contract |
|---|---|
| Egress gates | `src/net/{send,llm-send,sent-log}.ts`, `src/decisions/blocklist.ts`; fail-closed blocklist, per-scope payload guards, per-attempt log |
| Consent | `src/consent/{disclosure,records}.ts`, `src/messages/{llm-features,restructure}.ts`, sidepanel disclosure UI |
| Accounting | `src/llm/{client,budget,escalate}.ts`, `src/jev/{client,retry,wire}.ts`, `src/db/database.ts` (additive version) |
| Jobs / decisions | `src/jobs/{queue,runner,estimate}.ts`, `src/schemas/job.ts`, `src/entrypoints/background.ts`, `src/decisions/{pipeline,store,apply,duplicates,policy,summaries}.ts` |
| Restructure | `src/restructure/{apply,diff,assign,synopsis,propose}.ts`, `src/messages/restructure.ts` |
| Undo / merge | `src/undo/{snapshot,restore,lock}.ts`, `src/duplicates/{normalize,group,merge}.ts`, `src/sync/{tag-ops,listeners,reconcile,mutations}.ts`, `src/db/meta.ts` |
| Import / export | `src/io/{import-plan,import-write,csv,netscape,export-json}.ts`, sidepanel `ImportDialog.tsx`/`ExportDialog.tsx` |
| UI | sidepanel `App.tsx`, `ReviewView.tsx`, `BulkBar.tsx`, `BookmarkList.tsx`, `dnd.tsx`, `RestructureView.tsx`, `EditDialog.tsx`, `SummaryDialog.tsx`, `TagManager.tsx`, `UndoToast.tsx`; popup; Options |
| Providers / docs | `src/messages/{provider,llm-provider}.ts`, `src/security/{credentials,keys}.ts`, `eslint.config.mjs`, `README.md`, `store/*`, `site/*`, `conductor/*` |

---

## Phase 1: Privacy and consent enforcement
<!-- execution: parallel -->

- [~] Task 1: P01 + P02 — fail-closed blocklist and restructure synopsis
  <!-- files: src/decisions/blocklist.ts, src/net/send.ts, src/net/llm-send.ts, src/restructure/synopsis.ts, src/messages/restructure.ts, src/messages/llm-features.ts -->
  - Tests: throwing `db.metadata.get` and a non-array row make every sender
    (pipeline, explain, summaries, both gates) refuse with a typed error and
    send zero requests; unset still yields `[]`; restructure synopsis omits a
    user-blocklisted host's domain/title/path/counts.
  - Fix: `readBlocklist` returns a discriminated result (or throws a typed
    error); update every caller found via `xd://lsp` references; pass
    `userBlocklist` in `startRestructure`.
- [ ] Task 2: P03 — per-scope payload guards at both gates
  <!-- files: src/net/send.ts, src/net/llm-send.ts -->
  <!-- depends: task1 -->
  - Tests: LLM scope body carrying a notes marker, a blocklisted/sensitive
    URL, or an extra field is rejected before `fetch`; Jev `questions[*]`
    outside the closed shape is rejected; `fetchImpl` is unavailable to
    production entry points.
  - Fix: closed per-scope payload schemas parsed inside the gates; `isSensitiveUrl` re-check; separate test-only entry for `fetchImpl`.
- [ ] Task 3: P07 — per-attempt sent log with outcome
  <!-- files: src/net/send.ts, src/net/llm-send.ts, src/net/sent-log.ts -->
  <!-- depends: task2 -->
  - Tests: 503-then-200 → two rows; timeout → one row; redirect error → one
    row; failed append cannot suppress the request result.
  - Fix: append before/at dispatch per attempt with `outcome`; extend the
    sent-log schema additively; Options renders the outcome.
- [ ] Task 4: P04 — real consent for explain and restructure
  <!-- files: src/messages/llm-features.ts, src/messages/restructure.ts, src/consent/disclosure.ts, src/consent/records.ts, src/entrypoints/sidepanel/RestructureView.tsx, src/entrypoints/sidepanel/ReviewView.tsx -->
  <!-- depends: task1 -->
  - Tests: handlers return a typed `consent_required` and send nothing without
    exact-origin consent; handlers never write a grant; component tests show
    the disclosure (recipient, fields, trigger, purpose) and an unchecked
    default; granting then retrying succeeds.
  - Fix: `consentApproval` payload like `LLM_SUMMARIZE`; disclosure dialogs;
    bump consent versions for `llm_explain`/`llm_restructure`.
- [ ] Task 5: P05 — popup suggest only on explicit action
  <!-- files: src/entrypoints/popup/App.tsx, src/entrypoints/popup/Suggestions.tsx -->
  - Tests: opening the popup with consent granted sends zero `SAVE_SUGGEST`;
    focusing the tags field or pressing Suggest sends exactly one.
  - Fix: move the effect behind the explicit trigger; update popup copy.
- [ ] Task 6: P06 — no background egress on cold start
  <!-- files: src/entrypoints/background.ts, src/jobs/queue.ts, src/consent/disclosure.ts -->
  <!-- depends: task4 -->
  - Tests: cold start with a `running` job → `paused`, zero requests;
    explicit Resume continues from `committedBatches`; consent text
    (`DECISIONS_TRIGGER_NOTE`) matches.
  - Fix: pause-on-cold-start in `resumeJobs`; Resume control already exists
    or is added to the scan panel; update disclosure and README wording.
- [ ] Task 7: P08 — extraction identity and in-page caps
  <!-- files: src/extract/page.ts, src/extract/readability.ts, src/entrypoints/extract.ts, src/decisions/summaries.ts -->
  <!-- depends: task1 -->
  - Tests: tab navigates between `tabs.get` and injection → rejected; page
    URL on the blocklist → rejected; multi-MB fixture is truncated in-page and
    the schema rejects oversize.
  - Fix: injected script returns `location.href` + identity; worker
    re-verifies; `maxElemsToParse`/`charThreshold`; `.max()` limits.
- [ ] Task 8: P09 — path minimization
  <!-- files: src/decisions/minimize.ts, src/schemas/decision-state.ts, src/consent/disclosure.ts -->
  <!-- depends: task6 -->
  - Tests: `/s/<40-char token>` and `;jsessionid=…` never appear in the
    serialized payload; ordinary short paths unchanged; local identity
    matching unaffected; the 10k-corpus analyze-on-save gate still < 1.5 s.
  - Fix: strip matrix params, replace opaque segments with a placeholder;
    disclosure states the path is sent; re-check eval fixtures for drift.
- [ ] Task: Conductor - Automated Verification 'Phase 1: Privacy and consent enforcement' (automated gates; no manual wait)
  - Run the full local gate plus `xvfb-run -a npm run test:e2e` (macOS:
    `E2E_HEADLESS=1`); add wire-level e2e for P04/P05/P06 zero-egress cases.

## Phase 2: Accounting and egress robustness
<!-- execution: parallel -->

- [ ] Task 1: A01 + A02 — timeout classification and retry policy
  <!-- files: src/net/llm-send.ts, src/net/send.ts, src/jev/retry.ts -->
  - Tests: `AbortSignal.timeout` rejection → `timeout`, one request, one
    reservation; user abort distinguished; HTTP-date `Retry-After` honored;
    transport retries back off with jitter (fake clock).
  - Fix: treat `TimeoutError`/`AbortError`; no retry on timeout; reuse
    `parseRetryAfter`/`retryDelay`.
- [ ] Task 2: A03 — reservation orphan sweep
  <!-- files: src/net/llm-send.ts, src/llm/budget.ts, src/entrypoints/background.ts -->
  <!-- depends: task1 -->
  - Tests: `appendSentLog` throwing after fetch settles/releases the
    reservation; killed-worker simulation leaves an `active` row that the
    next start settles as unknown-cost under the conservative rule.
  - Fix: guard post-fetch bookkeeping; stale-reservation sweep at worker start
    using request-start time.
- [ ] Task 3: A04 + A05 — input-token estimate and billing provenance
  <!-- files: src/net/llm-send.ts, src/llm/client.ts, src/llm/budget.ts, src/jev/client.ts, src/decisions/pipeline.ts -->
  <!-- depends: task2 -->
  - Tests: oversize prompt reserves `max(declared, estimate)` or is refused;
    4xx capability-probe rejection is not counted toward the cap while
    timeout/5xx/non-JSON-200 still are; cross-check-failed Jev responses record
    usage (`BookmarksManager-eov`).
  - Fix: estimator in `sendLlmConsented`; explicit `not_billed` provenance.
- [ ] Task 4: A06 — response size caps
  <!-- files: src/jev/client.ts, src/llm/client.ts, src/jev/wire.ts, src/schemas/llm.ts -->
  <!-- depends: task3 -->
  - Tests: oversize or deeply nested success body is rejected before parse;
    non-2xx bodies are cancelled; `.max()` bounds enforced.
  - Fix: reuse the capped reader pattern from `readLlmErrorBody`.
- [ ] Task 5: A07 — job start guards
  <!-- files: src/messages/decisions.ts, src/messages/restructure.ts, src/jobs/queue.ts, src/jobs/estimate.ts, src/entrypoints/background.ts, README.md -->
  <!-- depends: task2 -->
  - Tests: second `JOB_START`/`RESTRUCTURE_START` while one is non-terminal →
    typed rejection; id-count cap; estimate returned before run.
  - Fix: server-side guard; README states which paths the USD cap covers.
- [ ] Task 6: A08 — retention and indexed reads
  <!-- files: src/db/database.ts, src/net/llm-send.ts, src/decisions/store.ts, src/jobs/queue.ts, src/entrypoints/options/SentLog.tsx, src/schemas/usage.ts -->
  <!-- depends: task3, task5 -->
  - Tests: caps hold after N inserts (audit, jobs, non-popup decisions,
    reservations, usage rollups); budget transaction reads only current-month
    rows (spy on Dexie); old rows still readable after the version bump;
    SentLog renders lazily.
  - Fix: additive Dexie version with `[providerId+month]` indexes and rollup
    rows; prune on write; `prunePopupDecisions` without full-table read.
- [ ] Task: Conductor - Automated Verification 'Phase 2: Accounting and egress robustness' (automated gates; no manual wait)
  - Full local gate + e2e (provider wire specs).

## Phase 3: Jobs and decisions resilience
<!-- execution: parallel -->

- [ ] Task 1: J01 + J02 + J09 — job failure policy, resume, circuit breaker
  <!-- files: src/jobs/queue.ts, src/jobs/runner.ts, src/schemas/job.ts, src/entrypoints/background.ts -->
  - Tests: one throwing item is recorded and skipped; `failed` resumes from
    `committedBatches`; deleted ids on resume are filtered; empty work set
    ends terminal; unexpected error → `failed` with redacted code; stale
    `running` job is re-driven by the watchdog; 429 burst opens the breaker
    and pause is honored per item.
  - Fix: per-item outcome, resumable `failed`, wrapped run, watchdog, breaker.
- [ ] Task 2: J03 — alarms keepalive for same-session jobs
  <!-- files: src/entrypoints/background.ts, wxt.config.ts, store/permissions.md, src/jobs/keepalive.ts -->
  <!-- depends: task1 -->
  - Tests: job started this session survives simulated eviction (alarm
    fires → resume); cold start does not (P06); sleeps capped; manifest check
    passes with `alarms` and `store/permissions.md` justification.
  - Fix: `chrome.storage.session` marker + periodic alarm; permission and docs.
- [ ] Task 3: J04 + J05 — idempotent decisions and send-time staleness guard
  <!-- files: src/decisions/pipeline.ts, src/decisions/store.ts, src/decisions/duplicates.ts, src/decisions/apply.ts -->
  <!-- depends: task1 -->
  - Tests: replayed batch yields one decision per `(jobId, bookmarkId, kind)`;
    re-analysis supersedes older pending rows; bookmark edited/deleted
    mid-scan is skipped, not applied and not a job failure; `assertFresh`
    covers url/title for add_tags/set_category/merge.
  - Fix: deterministic ids; guard captured from the sent snapshot.
- [ ] Task 4: J06 + J07 + J08 — approval exclusion, near-dup and escalate rules
  <!-- files: src/decisions/apply.ts, src/decisions/store.ts, src/decisions/duplicates.ts, src/decisions/policy.ts, src/jev/wire.ts, src/llm/escalate.ts -->
  <!-- depends: task3 -->
  - Tests: concurrent double approve applies once; approve-vs-reject safe;
    level-1/2 pairs are not approvable; confidence 1.4 → `unsure`, no throw;
    cancelled job stops escalation; budget-skipped escalation is flagged.
  - Fix: per-decision claim in worker + store; wire/policy clamp; rethrow
    job-authority errors.
- [ ] Task 5: J10 + J11 + J12 — restructure apply idempotency, undo target, managed rows
  <!-- files: src/restructure/apply.ts, src/restructure/diff.ts, src/messages/restructure.ts -->
  <!-- depends: task1 -->
  - Tests: double confirm applies once and pushes one snapshot; `moved === 0`
    pushes none; `RESTRUCTURE_UNDO` with a stale `snapshotId` is refused;
    managed bookmarks are `unresolved` and skipped, apply does not fail
    mid-way (`BookmarksManager-2v9`).
  - Fix: persisted applied state under a transaction/lock; `undoExpected`.
- [ ] Task 6: J13 — restructure assignment storage
  <!-- files: src/restructure/assign.ts, src/jobs/queue.ts, src/schemas/job.ts, src/messages/restructure.ts, src/db/database.ts -->
  <!-- depends: task1, task5 -->
  - Tests: 5k-bookmark restructure performs O(batches) job writes (spy);
    legacy jobs with inline assignments still apply; `latestRestructureJob`
    is indexed.
  - Fix: per-batch merge or `(jobId, bookmarkId)` table (additive).
- [ ] Task 7: J14 — summary re-admission and decision cascade
  <!-- files: src/decisions/summaries.ts, src/decisions/store.ts, src/sync/listeners.ts -->
  <!-- depends: task4 -->
  - Tests: deleted/retargeted bookmark cannot receive a summary or orphan
    meta row; deleting a bookmark removes its pending decisions.
  - Fix: re-admit before `setBookmarkSummary`; cascade on `onRemoved`.
- [ ] Task: Conductor - Automated Verification 'Phase 3: Jobs and decisions resilience' (automated gates; no manual wait)
  - Full local gate + e2e (job pause/resume/eviction simulation).

## Phase 4: Duplicates, undo and data integrity
<!-- execution: parallel -->

- [ ] Task 1: D01 — safe URL normalization
  <!-- files: src/duplicates/normalize.ts, src/duplicates/group.ts, src/io/import-plan.ts -->
  - Tests: `app.com/#/inbox` vs `#/settings`, `?ref=a` vs `?ref=b` on a
    repo host, `http` vs `https` do not group for merge or import-skip;
    true tracking-param duplicates still group; "normalized" groups are
    suggestion-only in the UI contract.
  - Fix: keep route fragments, host-scoped `ref`, scheme-aware keys.
- [ ] Task 2: D02 + D03 + D04 — safe merge
  <!-- files: src/duplicates/merge.ts, src/decisions/apply.ts, src/undo/snapshot.ts -->
  - Tests: member URL edited after grouping is refused/dropped; notes over
    10,000 chars are refused before any snapshot or write; `removeTree`
    failure discards the snapshot and retry does not double-append notes;
    `applyMerge` records the pushed `snapshotId` even when another snapshot is
    pushed concurrently.
  - Fix: live re-read, pre-validation, ordering, return `snapshotId`.
- [ ] Task 3: D05 + D06 + D10 + D11 — undo retention, peek, tag-delete, lock token
  <!-- files: src/undo/snapshot.ts, src/undo/lock.ts, src/sync/tag-ops.ts, src/schemas/undo.ts -->
  <!-- depends: task2 -->
  - Tests: 25 decision approvals do not evict a user delete snapshot; rows
    referenced by live decisions survive; `peekLatest` parses one row;
    tag-delete is atomic and discards its snapshot on failure; unrelated
    same-context `withUndoLock` call cannot bypass the lock.
  - Fix: per-origin caps, node/byte bound, reverse cursor, held token.
- [ ] Task 4: D07 + D09 — targeted undo and non-clobbering restore
  <!-- files: src/entrypoints/sidepanel/UndoToast.tsx, src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/CommandPalette.tsx, src/undo/restore.ts -->
  <!-- depends: task3 -->
  - Tests: delete in panel A, move in B, Undo in A reverts the delete only;
    palette undo likewise; merge undo keeps notes/tags edited after the merge;
    `bulk_move` undo skips a node moved since.
  - Fix: carry `snapshotId`; `undoExpected`; merge-not-replace for survivor.
- [ ] Task 5: D08 — linear-time restore
  <!-- files: src/undo/restore.ts, src/sync/mutations.ts -->
  <!-- depends: task4 -->
  - Tests: 5k-node subtree restore on the fake performs one `getChildren` per
    folder and batched `idMap` writes (spies); resume still works.
  - Fix: batch persistence, local child counts, skip repeated ancestor walk.
- [ ] Task 6: D12 + D13 — metadata tombstones and row schema versions
  <!-- files: src/sync/listeners.ts, src/sync/reconcile.ts, src/db/database.ts, src/db/meta.ts, src/undo/restore.ts -->
  <!-- depends: task5 -->
  - Tests: removing then re-creating a bookmark with the same URL within 30
    days re-attaches tags/notes; tombstones prune at retention; undo
    `nodeExists` rejects a reused id with a different URL; invalid rows are
    counted, surfaced and never overwritten without a retained copy; old rows
    without `schemaVersion` still read.
  - Fix: additive Dexie version, tombstone table, `schemaVersion`.
- [ ] Task 7: D14 — search/omnibox cost
  <!-- files: src/search/omnibox.ts, src/search/run.ts, src/duplicates/group.ts, src/sync/listeners.ts -->
  <!-- depends: task1, task6 -->
  - Tests: second omnibox query reuses the cached index; cache invalidates on
    bookmark/meta events; notes not indexed there; `group.ts` scales to 5k
    groups within a bound; no `bookmarks-changed` broadcast remains.
  - Fix: lazy cached index, exact-group index, remove dead broadcast.
- [ ] Task 8: D15 — one scheme policy
  <!-- files: src/search/openable.ts, src/io/netscape.ts -->
  - Tests: `\u0001javascript:`, `vbscript:`, `blob:`, `view-source:` are not
    openable; `http`, `https`, `mailto`, `ftp` are; import guard and open guard
    agree on a shared fixture table.
  - Fix: one shared function; allowlist.
- [ ] Task: Conductor - Automated Verification 'Phase 4: Duplicates, undo and data integrity' (automated gates; no manual wait)
  - Full local gate + e2e (merge/undo/restore specs).

## Phase 5: Import and export
<!-- execution: parallel -->

- [ ] Task 1: I05 + I06 — CSV round trip and deep export
  <!-- files: src/io/csv.ts, src/io/export-json.ts -->
  - Tests: export→import round trip keeps `-5 degrees`, `+1 tip`, `@handle`;
    an unmatched quote reports swallowed rows and recovers on the next record;
    `/` and `;` in folder/tag text round-trip; depth > 64 exports with a
    warning.
  - Fix: single-quote unescape rule, recovery/reporting, escaping, flatten.
- [ ] Task 2: I03 + I04 — tags and duplicate metadata on import
  <!-- files: src/io/import-plan.ts, src/io/import-write.ts, src/db/meta.ts -->
  - Tests: CSV/Netscape tags appear in `listTags()` and can be renamed;
    65-char tag is truncated/skipped without losing the row; duplicate skip
    merges tags/category and lists skipped URLs.
  - Fix: `TagDef` creation per key; per-tag validation; merge-on-duplicate.
- [ ] Task 3: I01 — resumable import
  <!-- files: src/io/import-write.ts, src/db/database.ts, src/schemas/import-state.ts -->
  <!-- depends: task2 -->
  - Tests: interrupting after N items persists root id + cursor; resume
    finishes without duplicates; Cancel stops cleanly; progress callbacks
    fire.
  - Fix: write-ahead root id and cursor (additive table); resume/cancel API.
- [ ] Task 4: I02 + I07 — import/export dialogs
  <!-- files: src/entrypoints/sidepanel/ImportDialog.tsx, src/entrypoints/sidepanel/ExportDialog.tsx -->
  <!-- depends: task3 -->
  - Tests: Esc/overlay/X are inert while importing; a reset run's late result
    is ignored; double confirm starts one import; reopen offers Resume;
    export omits notes when unchecked; object URL revoked after delay.
  - Fix: busy-guarded `onOpenChange`, run-id ref, re-entrancy guard, Resume
    UI, notes checkbox.
- [ ] Task: Conductor - Automated Verification 'Phase 5: Import and export' (automated gates; no manual wait)
  - Full local gate + e2e (import/export specs).

## Phase 6: UI correctness and safety
<!-- execution: parallel -->

- [ ] Task 1: U01 — confirmed, undoable Approve all
  <!-- files: src/entrypoints/sidepanel/ReviewView.tsx, src/entrypoints/sidepanel/App.tsx, src/messages/decisions.ts, src/decisions/apply.ts -->
  - Tests: Approve all opens a confirm showing count and kinds; confirming
    applies under one aggregate snapshot and shows an Undo toast; Undo
    reverts the whole batch; cancel applies nothing.
  - Fix: confirm dialog; aggregate snapshot or batch revert message.
- [ ] Task 2: U02 — Analyze through the job queue
  <!-- files: src/entrypoints/sidepanel/BulkBar.tsx, src/messages/decisions.ts -->
  <!-- depends: task1 -->
  - Tests: Analyze with N selected starts one job, shows a cost estimate,
    exposes Pause/Cancel, rejects selections over the cap.
  - Fix: route via `JOB_START`; remove the sequential loop.
- [ ] Task 3: U03 — RestructureView re-entrancy and polling
  <!-- files: src/entrypoints/sidepanel/RestructureView.tsx -->
  - Tests: double-click "Yes, apply" sends one confirm; stale poll reply does
    not overwrite a newer phase; `starting` recovers after a transient status
    failure; `selectedIds` resets per job.
  - Fix: sync ref guard, interval ref with in-flight guard, job-keyed state.
- [ ] Task 4: U04 + U05 — list keyboard safety and dnd indices
  <!-- files: src/entrypoints/sidepanel/BookmarkList.tsx, src/entrypoints/sidepanel/dnd.tsx -->
  - Tests: Delete/Escape/Ctrl+A with the context menu open do not reach the
    list; key repeat deletes once; same-parent forward multi-move lands in
    order.
  - Fix: target containment check, deleting ref, post-removal index math.
- [ ] Task 5: U06 — worker-side quick save and popup errors
  <!-- files: src/entrypoints/popup/App.tsx, src/entrypoints/popup/chrome.ts, src/entrypoints/popup/Suggestions.tsx, src/entrypoints/background.ts, src/messages/save.ts -->
  - Tests: popup context destroyed after the message is sent still yields
    bookmark + meta; failure shows an error; suggestions use an indexed query;
    `openSidePanel` failure is surfaced.
  - Fix: one `SAVE` message handled in the worker; surface failures.
- [ ] Task 6: U07 — edit, pending-edit and duplicates banner
  <!-- files: src/entrypoints/sidepanel/EditDialog.tsx, src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/DuplicatesView.tsx -->
  <!-- depends: task1 -->
  - Tests: tag added by an approval while Edit is open survives Save; pending
    edit id survives tree changes at startup; banner Undo performs the undo and
    shows its real result.
  - Fix: delta patch, consume key after resolve, call undo directly.
- [ ] Task 7: U08 — SummaryDialog on shared Dialog
  <!-- files: src/entrypoints/sidepanel/SummaryDialog.tsx, src/ui/components/dialog.tsx -->
  - Tests: focus is trapped and restored; dark theme tokens used; Close while
    running cancels or is labeled "continue in background".
  - Fix: rebuild on the Radix Dialog primitive; cancellation plumbing.
- [ ] Task 8: U09 — Options correctness
  <!-- files: src/entrypoints/options/DecisionSettings.tsx, src/entrypoints/options/ProviderSetup.tsx, src/entrypoints/options/LlmBudget.tsx, src/messages/decisions.ts -->
  <!-- depends: task2 -->
  - Tests: two stale tabs adding different blocklist entries both persist;
    permission granted after a preset switch is removed or completes the
    enable; budget card refreshes, clears stale error, rejects `0x10`/`1e3`.
  - Fix: field-level patch messages; permission cleanup; live budget.
- [ ] Task 9: U10 — error boundaries
  <!-- files: src/ui/components/ErrorBoundary.tsx, src/entrypoints/sidepanel/main.tsx, src/entrypoints/popup/main.tsx, src/entrypoints/options/main.tsx -->
  - Tests: a throwing child renders the fallback with Reload; an
    `unhandledrejection` is reported, not silent.
  - Fix: one boundary component mounted per entrypoint.
- [ ] Task 10: U11 — sidepanel render cost
  <!-- files: src/entrypoints/sidepanel/TagManager.tsx, src/ui/hooks/useBookmarkTree.ts, src/entrypoints/sidepanel/App.tsx -->
  <!-- depends: task6 -->
  - Tests: closed `TagManager` runs no live queries; a 1,000-event burst
    produces bounded tree refreshes (preserve the I02 behavior of the previous
    track).
  - Fix: mount queries only while open; throttle during writes.
- [ ] Task: Conductor - Automated Verification 'Phase 6: UI correctness and safety' (automated gates; no manual wait)
  - Full local gate + e2e; visual check of dialogs in Chromium light/dark via
    Playwright screenshots (automated, no manual wait).

## Phase 7: Provider hardening and documentation
<!-- execution: parallel -->

- [ ] Task 1: H01 + H02 — provider setup rollback and key hygiene
  <!-- files: src/messages/provider.ts, src/messages/llm-provider.ts, src/security/credentials.ts, src/security/keys.ts -->
  - Tests: failed re-enable/re-configure restores credential, settings,
    consent and budget; keys with newline/space are trimmed or rejected with a
    clear code; concurrent `saveProviderKey` and envelope save/delete do not
    leave an undecryptable envelope (`BookmarksManager-7k4`).
  - Fix: snapshot-and-restore; boundary validation; per-material-id queue.
- [ ] Task 2: H03 — wider egress lint
  <!-- files: eslint.config.mjs -->
  - Tests: lint fixture using `XMLHttpRequest`, `WebSocket`, `EventSource`,
    `navigator.sendBeacon`, `importScripts` outside `src/net/**` fails; code
    inside `src/net/**` passes (`BookmarksManager-bih`).
  - Fix: extend `no-restricted-globals`/`properties`.
- [ ] Task 3: H04 + H05 — custom host warning and injection mitigations
  <!-- files: src/entrypoints/options/LlmProviderSetup.tsx, src/entrypoints/options/ProviderSetup.tsx, src/entrypoints/sidepanel/ReviewView.tsx, src/restructure/propose.ts, src/llm/summarize.ts, src/decisions/summaries.ts -->
  <!-- depends: task1 -->
  - Tests: private-IP/intranet custom host shows a warning but saves;
    auto-applied rows show the source domain; folder names are length-limited
    and stripped of URLs/markdown; persisted summaries strip URLs/markdown.
  - Fix: reuse `isNonPublicUrl`; sanitizers; UI label.
- [ ] Task 4: H06 — documentation and store sync
  <!-- files: README.md, store/listing.md, store/privacy-policy.md, store/privacy-practices.md, store/permissions.md, store/reviewer-notes.md, site/privacy/index.html, conductor/tech-stack.md, conductor/patterns.md -->
  <!-- depends: task1, task2, task3 -->
  - Tests: `check:manifest`, `check:store`, `check:site` pass; README claims
    about key storage, background egress, budget scope and notes match code;
    consent versions and disclosure text consistent across code and store.
  - Fix: update docs only where behavior changed in this track.
- [ ] Task 5: H07 — final regression sweep
  <!-- files: tests/e2e/audit-deep-fixes.spec.ts -->
  <!-- depends: task4 -->
  - Tests: one wire-level e2e covering the cross-feature acceptance criteria
    (zero-egress on open/cold start, per-attempt log, timeout, double approve,
    undo targeting); record counts.
  - Fix: none expected; any failure re-opens the owning task.
- [ ] Task: Conductor - Automated Verification 'Phase 7: Provider hardening and documentation' (automated gates; no manual wait)
  - Final gate: `npm run lint`, `typecheck`, `test -- --run`, `build`,
    `check:manifest`, `check:bundle`, `check:store`, `check:site`,
    `xvfb-run -a npm run test:e2e` (macOS `E2E_HEADLESS=1`). Record exact
    commands and pass/fail/skip counts. State key-gated and native-prompt
    exclusions.
