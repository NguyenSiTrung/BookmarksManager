# Correctness, Performance & UI/UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `conductor` (`/conductor-implement`) to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Read `spec.md`, `learnings.md`, and the task's mapped Beads issue before claiming work.

**Goal:** Resolve all 39 findings (`B-01`–`B-16`, `P-01`–`P-13`, `U-01`–`U-10`) from the 2026-10-14 audit with failing-first regression tests, indexed/batched data operations, and responsive, accessible UI surfaces.

**Architecture:** Preserve Chrome/Dexie/service-worker boundaries. Eliminate $O(N^2)$ scans and unbatched IDB/IPC loops via precomputed lookup maps, multiEntry index queries, `MutationVerifyCache`, and single-transaction bulk operations. Keep all phases sequential and run tasks in parallel only where `<!-- files: ... -->` annotations are strictly disjoint and no `<!-- depends: ... -->` edge blocks them.

**Tech Stack:** WXT MV3, strict TypeScript 6, React 19, Dexie 4, jitless Zod 4, MiniSearch 7, Vitest 5 / Testing Library, Playwright Chromium.

**Spec:** `conductor/tracks/perf_ux_hardening_20261014/spec.md`

## Global Constraints

- **User override (2026-10-14): automated gates only, no manual checks at any phase or at completion.** Continue after an automated checkpoint passes; stop on failed/blocked checks.
- **Verify-first:** every task starts with a failing regression test against current code. If a sub-item cannot fail, record the evidence in `learnings.md` and keep the test only if it guards a plausible consumer-visible regression.
- Phases are sequential. Within a phase, only tasks with disjoint `files` and satisfied `depends` run concurrently. The coordinator owns track files, Beads operations, commits, and `git notes`.
- Per task: failing regression → minimal fix → targeted green tests → applicable local gate slice (`lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle`; `check:store`/`check:site` when touching `store/`/`site/`; e2e when touching entrypoints or egress) → update `plan.md` & `learnings.md` → local commit + `git notes add` → close mapped Bead.
- Never automatically run `git push`, `git pull`, `git fetch`, or `bd dolt push`.

---

## Phase 1: Core Sync, IndexedDB, Undo & Import Hardening
<!-- execution: parallel -->

- [ ] Task 1: MV3 DB release coordination, corrupt-meta batching, and indexed tombstone pruning (`B-04`, `P-09`)
  <!-- files: src/security/delete-all.ts, src/db/meta.ts, src/db/tombstones.ts, src/entrypoints/options/LlmBudget.tsx, tests/unit/delete-all.test.ts, tests/unit/tombstones.test.ts, tests/components/llm-budget.test.tsx -->
  - [ ] Write failing unit/component tests for worker DB release handling during `deleteAllExtensionData`, `LlmBudget` `useLiveQuery` error resilience when `db` is closed, batched `retainCorruptMeta` in `refreshMetaIntegrity`, and indexed `pruneTombstones` + bulk `tombstoneMetaByIds`.
  - [ ] Implement `RELEASE_DB_MESSAGE` coordination hook in `src/security/delete-all.ts`, add `.catch(() => [0, 0, 0] as const)` to `src/entrypoints/options/LlmBudget.tsx:148`, batch corrupt-row retention in `src/db/meta.ts`, and replace `.toArray()` / per-row loops in `src/db/tombstones.ts` with `removedAt` index `.primaryKeys()` and `bulkGet`/`bulkPut`/`bulkDelete`.

- [ ] Task 2: `MutationVerifyCache` coherence, startup reconcile tombstone fast-path, `bookmarkMeta.url` D12 maintenance, and bulk tag-ops batching (`B-09`, `B-10`, `P-05`, `P-06`)
  <!-- files: src/sync/mutations.ts, src/sync/reconcile.ts, src/sync/listeners.ts, src/sync/tag-ops.ts, src/sync/tree.ts, tests/unit/mutations.test.ts, tests/unit/reconcile.test.ts, tests/unit/tag-ops.test.ts -->
  <!-- depends: task1 -->
  - [ ] Write failing tests proving `moveNode` updates `cache.nodes` and invalidates `cache.parents` on folder moves (preventing stale childCounts and cycle bypasses), `reconcileStartup` skips `reattachTombstone` transactions when `metaTombstones` is empty, `bulkAddTag`/`bulkRemoveTag`/`bulkSetCategory` execute in one transaction with one `META_CHANGED_CHANNEL` broadcast while preserving/populating `bookmarkMeta.url`, and `onChanged` updates `bookmarkMeta.url`.
  - [ ] Update `src/sync/mutations.ts`, `src/sync/reconcile.ts`, `src/sync/listeners.ts`, `src/sync/tag-ops.ts`, and `src/sync/tree.ts` (sharing immutable folder `path` arrays across leaf children).

- [ ] Task 3: Field-scoped metadata undo, recursive `UNDO_NODE_BUDGET`, protected restructure snapshots, and batched undo replay (`B-08`, `P-08b`)
  <!-- files: src/undo/snapshot.ts, src/undo/restore.ts, src/schemas/undo.ts, tests/unit/undo-snapshot.test.ts, tests/unit/undo-restore.test.ts -->
  <!-- depends: task2 -->
  - [ ] Write failing tests for field-scoped metadata undo (reverting `set_category` or `add_tags` preserves subsequent edits to `notes`/`summary`/other fields), recursive folder subtree node counting in `pushSnapshot`, protecting `db.jobs` restructure `applied.snapshotId` in `protectedIds`, `origin: "user"` default in `peekLatest`/`undoLatest`, cached `nodeExists` in `restore.ts`, and batched metadata restore with `url` preserved.
  - [ ] Implement the undo schema, snapshot eviction, and batched restore fixes in `src/schemas/undo.ts`, `src/undo/snapshot.ts`, and `src/undo/restore.ts`.

- [ ] Task 4: Resumable import claim/cancel transactional safety, `MutationVerifyCache` batching, and parser fast-paths (`B-03`, `B-16b`, `P-07`)
  <!-- files: src/io/import-write.ts, src/io/netscape.ts, src/io/export-json.ts, src/io/csv.ts, tests/unit/import-write.test.ts, tests/unit/netscape.test.ts -->
  <!-- depends: task2 -->
  - [ ] Write failing tests for concurrent `cancelImport` during an in-flight item write in `driveImport`, initial `claimedBy` stamping in `writeImport` preventing duplicate `resumeImport` execution, `ImportQueueRow.safeParse` guards before folder creation, `MutationVerifyCache` + batched `persistState` + batched `putMeta`/`mergeSkippedDuplicates`, and parser `MAX_FILE_BYTES` / Netscape `<dl>` traversal efficiency.
  - [ ] Implement transactional `persistState`, claim filtering, `MutationVerifyCache` integration, batched metadata writes, and parser optimizations in `src/io/{import-write,netscape,export-json,csv}.ts`.

- [ ] Task: Conductor - User Manual Verification 'Phase 1: Core Sync, IndexedDB, Undo & Import Hardening' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3, task4 -->

---

## Phase 2: AI Decisions, Batch Jobs, Restructure & LLM/Summary Pipeline
<!-- execution: parallel -->

- [ ] Task 1: Indexed decision store lookups, near-duplicate `merge_duplicates` approval, and serialized `revertDecision` (`B-01`, `P-02`)
  <!-- files: src/decisions/store.ts, src/decisions/apply.ts, src/duplicates/merge.ts, src/db/retention.ts, tests/unit/decisions-store.test.ts, tests/unit/decisions-apply.test.ts -->
  - [ ] Write failing tests proving: (1) approving a `merge_duplicates` decision where the two bookmarks have distinct normalized URLs merges metadata onto `keepId`, removes the duplicate bookmark, and records a valid `undoSnapshotId`; (2) `persistDecision`, `hasDecidedSlotRow`, and `sweepReviewableDecisions` query via the `*bookmarkIds` index and respect `!claimLive(other.claim)`; (3) `revertDecision` is serialized/claimed and uses field-scoped metadata undo (`pushMetaUndo`).
  - [ ] Implement near-duplicate merge support in `src/decisions/apply.ts` and `src/duplicates/merge.ts`, index-backed queries in `src/decisions/store.ts`, and fast-path count check in `src/db/retention.ts:pruneTerminalDecisionsLocked`.

- [ ] Task 2: Precomputed candidate selection index, single-pass `near-duplicate-plan` URL parse, per-pair error isolation, and post-network job authority guards (`B-11`, `P-01a`, `P-03a`)
  <!-- files: src/decisions/candidates.ts, src/decisions/pipeline.ts, src/decisions/duplicates.ts, src/decisions/near-duplicate-plan.ts, tests/unit/decisions-candidates.test.ts, tests/unit/decisions-pipeline.test.ts, tests/unit/decisions-duplicates.test.ts -->
  <!-- depends: task1 -->
  - [ ] Write failing tests for: (1) `PrecomputedAnalysisIndex` eliminating per-bookmark `extractDomain` / `fullFolderPath` full-library scans in `selectTagCandidates` and `selectFolderCandidates`; (2) per-pair failure isolation in `runPairs` so 1 failing near-duplicate pair does not skip the remaining pairs in a batch; (3) post-network `assertJobAuthority` checks before `persistDecision` and `approveDecision` in `pipeline.ts` and `duplicates.ts`.
  - [ ] Implement `PrecomputedAnalysisIndex` in `src/decisions/candidates.ts`, wire it through `src/decisions/pipeline.ts`, isolate per-pair errors and add post-network authority checks in `src/decisions/duplicates.ts` and `src/decisions/pipeline.ts`, and unify URL parsing in `src/decisions/near-duplicate-plan.ts`.

- [ ] Task 3: Positional bookmark batch slicing in `JobRunner`, cached `AnalysisContext`, keepalive RMW serialization, and `restructureAssignments` deduplication (`B-02`, `B-04a`, `B-07b`, `B-15`, `P-01b`, `P-04`)
  <!-- files: src/jobs/runner.ts, src/jobs/queue.ts, src/jobs/keepalive.ts, src/jobs/coordinator.ts, src/entrypoints/background.ts, tests/unit/jobs-runner.test.ts, tests/unit/jobs-queue.test.ts, tests/unit/jobs-keepalive.test.ts -->
  <!-- depends: task2 -->
  - [ ] Write failing tests for: (1) positional bookmark batch slicing in `JobRunner.run` when bookmarks in Batch 0 are deleted before pause/resume; (2) caching `AnalysisContext` across batches in `JobRunner`; (3) serialized `markSessionJob`/`unmarkSessionJob` in `keepalive.ts`, non-blocking `reDriveStaleJobs` in `queue.ts`, and watchdog preemption in `coordinator.ts`; (4) pausing `"running"` jobs and clearing keepalive when `activeProvider()` is `null` in `background.ts:drivePersistedJob` (plus handling `RELEASE_DB_MESSAGE` at the top of `background.ts`); (5) avoiding $O(B^2)$ `restructure.assignments` array rewrites in `db.jobs`.
  - [ ] Implement the fixes across `src/jobs/{runner,queue,keepalive,coordinator}.ts` and `src/entrypoints/background.ts`.

- [ ] Task 4: Restructure preflight Jev check, locked/cached `applyRestructurePlan`, clean rollback snapshot discard, and synopsis bounds (`B-07a`, `B-13`, `B-16a`, `P-08a`)
  <!-- files: src/restructure/apply.ts, src/restructure/synopsis.ts, src/restructure/propose.ts, src/messages/restructure.ts, tests/unit/restructure-apply.test.ts, tests/unit/restructure-synopsis.test.ts, tests/unit/messages-restructure.test.ts -->
  <!-- depends: task3 -->
  - [ ] Write failing tests for: (1) `startRestructure` refusing before `proposeLayout` when no consented Jev provider is active or `leafIds.length > MAX_JOB_BOOKMARK_IDS`; (2) `applyRestructurePlan` computing diff inside `serializeApply`/`withUndoLock`, using `MutationVerifyCache` + tree capture, handling vanished bookmarks on `get(id)`, discarding its undo snapshot on clean rollback, and `undoRestructurePlan` using `restoreById`; (3) `buildLibrarySynopsis` handling empty (`""`), `>400`-char, and duplicate sibling folder names; (4) `proposeLayout` using `record.tier ?? "json_schema"`.
  - [ ] Implement the restructure fixes in `src/restructure/{apply,synopsis,propose}.ts` and `src/messages/restructure.ts`.

- [ ] Task 5: LLM structured-output `record.tier`, `explainDecision` folder labels/guards/sanitization, provider-scoped consent revocation, and summary extraction/accounting (`B-05`, `B-06a`, `B-12`, `B-14`)
  <!-- files: src/llm/explain.ts, src/llm/summarize.ts, src/llm/escalate.ts, src/decisions/summaries.ts, src/jev/tasks/verify-summary.ts, src/extract/page.ts, src/messages/summaries.ts, src/messages/provider.ts, src/messages/llm-provider.ts, src/consent/records.ts, store/permissions.md, store/reviewer-notes.md, tests/unit/llm-explain.test.ts, tests/unit/decisions-summaries.test.ts, tests/unit/messages-provider.test.ts, tests/unit/messages-llm-provider.test.ts -->
  - [ ] Write failing tests for: (1) `explainDecision`, `summarizePage`, and `maybeEscalateDecision` passing `record.tier ?? "json_schema"`; (2) `explainDecision` checking `row.guard` freshness, resolving `move` folder IDs to folder paths, and sanitizing `rationale` via `stripUrlsAndMarkdown` (also in `maybeEscalateDecision`); (3) revoking an LLM provider preserving Jev consents and shared host permissions (`https://openrouter.ai/*`, `http://localhost/*`) when a Jev provider is still configured (and vice versa); (4) `summarizeExtracted` recording `appendUsage` for `jev_summary_verify`, omitting `tabId` on the `persist`-stage `admitSummary` re-check, and preflight reporting active-tab URL mismatch / origin permission status.
  - [ ] Implement the fixes across `src/llm/{explain,summarize,escalate}.ts`, `src/decisions/summaries.ts`, `src/jev/tasks/verify-summary.ts`, `src/extract/page.ts`, `src/messages/{summaries,provider,llm-provider}.ts`, `src/consent/records.ts`, and `store/{permissions,reviewer-notes}.md`.

- [ ] Task: Conductor - User Manual Verification 'Phase 2: AI Decisions, Batch Jobs, Restructure & LLM/Summary Pipeline' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3, task4, task5 -->

---

## Phase 3: Search Engine, Omnibox & QueryInput Ergonomics
<!-- execution: parallel -->

- [ ] Task 1: Precomputed `treeOrderRank`, filter-before-hit allocation in `allDocs`, incremental duplicate URL buckets, bulk MiniSearch vacuum/rebuild, and Omnibox live-cache (`P-12`)
  <!-- files: src/search/index.ts, src/search/run.ts, src/search/live-cache.ts, src/search/omnibox.ts, tests/unit/search-run.test.ts, tests/unit/search-live-cache.test.ts, tests/unit/omnibox.test.ts -->
  - [ ] Write failing unit tests for precomputed `treeOrderRank`, filtering `SearchDocument` before `SearchHit` allocation on wildcard queries, incremental duplicate bucket updates in `createLiveSearchCache` without re-normalizing untouched URLs, bulk-diff rebuild/vacuum in `applyDocDiff`, and incremental cache retention in `createSharedSearchIndex` (`omnibox.ts`).
  - [ ] Implement the search and omnibox optimizations in `src/search/{index,run,live-cache,omnibox}.ts`.

- [ ] Task 2: Filter suggestion precision (`is:dead` removal, prefix matching) and `QueryInput` keyboard/`Escape` ergonomics (`U-06a-c`)
  <!-- files: src/search/suggest.ts, src/ui/components/query-input.tsx, tests/unit/search-suggest.test.ts, tests/components/query-input.test.tsx -->
  - [ ] Write failing unit and component tests for: removing `"dead"` from `IS_VALUES` in `suggest.ts`; prefix-only filter key matching and not auto-opening key suggestions on empty/whitespace input; `Escape` clearing the query with `setDismissed(true)` so the suggestion menu does not immediately pop open; resetting `activeIndex` to `-1` on `onChange`; and scrolling the active option into view.
  - [ ] Update `src/search/suggest.ts` and `src/ui/components/query-input.tsx`.

- [ ] Task: Conductor - User Manual Verification 'Phase 3: Search Engine, Omnibox & QueryInput Ergonomics' (Protocol in workflow.md)
  <!-- depends: task1, task2 -->

---

## Phase 4: Side Panel, Popup & Options UI/UX, Performance & Accessibility
<!-- execution: parallel -->

- [ ] Task 1: Sidepanel search/view routing, `Ctrl+Z` undo, multi-delete confirmation, `UndoToast` hover/offset, `BulkBar` `snapshotId` & job card visibility, `useAiConnected` scope filter, and `CommandPalette` / closed-dialog guards (`P-03b`, `P-13b`, `U-01`, `U-03b`, `U-05`, `U-09b`, `U-10d`)
  <!-- files: src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/useAiConnected.ts, src/entrypoints/sidepanel/BulkBar.tsx, src/entrypoints/sidepanel/UndoToast.tsx, src/entrypoints/sidepanel/CommandPalette.tsx, src/entrypoints/sidepanel/palette.ts, src/entrypoints/sidepanel/TopBar.tsx, src/entrypoints/sidepanel/ScanPanel.tsx, src/entrypoints/sidepanel/ExportDialog.tsx, tests/components/sidepanel-app.test.tsx, tests/components/bulk-bar.test.tsx, tests/components/command-palette.test.tsx -->
  - [ ] Write failing component tests for: selecting a folder/tag/category/chip while `searchQuery !== ""` clearing search and updating active state; `useAiConnected` ignoring `llm_test`; `BulkBar` passing `snapshotId` on delete toast and keeping the running selection-analysis card visible when selection is cleared; confirmation dialog before multi-item/folder deletion; `Ctrl/Cmd+Z` triggering undo; `UndoToast` pausing on hover/focus and offsetting above `BulkBar`; closed-dialog memo short-circuits; and `CommandPalette` `aria-activedescendant`, `scrollIntoView`, hover state, new commands, and Tools menu entry.
  - [ ] Implement the fixes across `src/entrypoints/sidepanel/{App,useAiConnected,BulkBar,UndoToast,CommandPalette,palette,TopBar,ScanPanel,ExportDialog}.tsx`.

- [ ] Task 2: `BookmarkList`, `FolderTree`, `dnd.tsx`, `DuplicatesView`, `ReviewView`, `RestructureView` & `TagManager`: narrow-layout resilience, virtualization, selection memoization, DnD indicators & roving `tabIndex` (`P-11`, `P-13a`, `U-07`, `U-08a-c`, `U-09c`, `U-10a-c`)
  <!-- files: src/entrypoints/sidepanel/BookmarkList.tsx, src/entrypoints/sidepanel/FolderTree.tsx, src/entrypoints/sidepanel/dnd.tsx, src/entrypoints/sidepanel/DuplicatesView.tsx, src/entrypoints/sidepanel/ReviewView.tsx, src/entrypoints/sidepanel/RestructureView.tsx, src/entrypoints/sidepanel/TagManager.tsx, src/entrypoints/sidepanel/ScopeHeading.tsx, src/ui/components/favicon.tsx, tests/components/bookmark-list.test.tsx, tests/components/duplicates-view.test.tsx, tests/components/review-view.test.tsx, tests/components/restructure-view.test.tsx -->
  <!-- depends: task1 -->
  - [ ] Write failing component tests for: `useBookmarkSelection` memoizing `retain` and `orderIndexMap`; virtualized `DuplicatesView` group rendering; `useDropZone` exposing `validOver` and rendering visual drop indicators on slots/folders, grid card `DragHandle`, and narrow-mode `ScopeHeading` drag-over drawer open; narrow-width tag truncation and action wrapping in `BookmarkList`, `DuplicatesView`, `ReviewView`, and `TagManager`; `RestructureView` displaying `job.error`, indeterminate initial progress, and no `tabIndex={0}` on static `<li>` rows; `FaviconPlaceholder` `aria-hidden="true"`; and roving `tabIndex={active ? 0 : -1}` on inner row controls.
  - [ ] Implement the fixes across `src/entrypoints/sidepanel/{BookmarkList,FolderTree,dnd,DuplicatesView,ReviewView,RestructureView,TagManager,ScopeHeading}.tsx` and `src/ui/components/favicon.tsx`.

- [ ] Task 3: `SummaryDialog` & `EditDialog`: view/clear saved summaries, runtime origin grant on click, folder-field gating, and uncommitted tag input commit (`B-06b`, `U-02`, `U-04b`, `U-08d`)
  <!-- files: src/entrypoints/sidepanel/SummaryDialog.tsx, src/entrypoints/sidepanel/EditDialog.tsx, src/entrypoints/sidepanel/FolderActions.tsx, tests/components/summary-dialog.test.tsx, tests/components/edit-dialog.test.tsx -->
  <!-- depends: task1 -->
  - [ ] Write failing component tests for: `SummaryDialog` displaying an existing `meta.summary` with `Re-summarize` and `Clear summary` actions, requiring an unchecked agreement checkbox when consent is missing, skipping the full disclosure wall when already consented, and requesting runtime origin permission on click when needed; `EditDialog` displaying saved summary (with `Clear`), committing non-empty `tagInput` on Save, hiding `Tags`/`Category`/`Notes` when editing a folder, setting `metaPatch.url`, and applying `max-h-[85vh] overflow-y-auto` + `focus-visible:ring-2`.
  - [ ] Update `src/entrypoints/sidepanel/{SummaryDialog,EditDialog,FolderActions}.tsx`.

- [ ] Task 4: Popup lazy search index, $O(1)$ duplicate URL lookup, `QueryInput` autocomplete, uncommitted tag commit, and `Suggest`/search feedback (`P-10`, `U-04a`, `U-06d`, `U-09d`)
  <!-- files: src/entrypoints/popup/App.tsx, src/entrypoints/popup/Search.tsx, src/entrypoints/popup/Suggestions.tsx, src/entrypoints/popup/PageCard.tsx, tests/components/popup.test.tsx -->
  - [ ] Write failing component tests for: deferring `listMeta`/`listTags` and `useSearchIndex` in `popup/App.tsx` until `searchOpen === true`; $O(1)$ memoized `normalizedUrl` duplicate lookup; committing non-empty `tagInput` on Save; toggling search closed via the header Search button; rendering `<ErrorAlert>` while searching; filter autocomplete in `PopupSearch`; loading/empty/unconfigured feedback for `Suggest`; and `focus-visible:ring-2` on `#popup-title`.
  - [ ] Update `src/entrypoints/popup/{App,Search,Suggestions,PageCard}.tsx`.

- [ ] Task 5: Options `DecisionSettings` per-feature consent management, `<Disclosure>` controlled state, inline card feedback, and `#blocklist-entry` `Enter` handling (`U-03a`, `U-09a`)
  <!-- files: src/entrypoints/options/DecisionSettings.tsx, tests/components/decision-settings.test.tsx -->
  - [ ] Write failing component tests for: inspecting and revoking `llm_explain`, `llm_restructure`, `llm_summary`, and `jev_summary_verify` in `DecisionSettings.tsx`; built-in blocklist `<Disclosure>` staying open across re-renders; inline feedback alerts near acted-on cards; unselected preset cards showing consent status; pressing `Enter` in `#blocklist-entry` adding the entry; and updated `"in Connections"` copy.
  - [ ] Update `src/entrypoints/options/DecisionSettings.tsx`.

- [ ] Task: Conductor - User Manual Verification 'Phase 4: Side Panel, Popup & Options UI/UX, Performance & Accessibility' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3, task4, task5 -->

---

## Phase 5: End-to-End Verification, Performance Benchmarks & Documentation Sync
<!-- execution: sequential -->

- [ ] Task 1: Performance & E2E regressions, full CI gate, and documentation sync
  <!-- files: tests/unit/decisions-perf.test.ts, tests/unit/search-perf.test.ts, tests/e2e/audit-deep-fixes.spec.ts, conductor/product.md, conductor/tech-stack.md, conductor/patterns.md -->
  - [ ] Add 10k-bookmark performance assertions for precomputed candidate selection, indexed decision persistence, and startup reconciliation, plus e2e regression coverage for near-duplicate `merge_duplicates` approval, search-to-folder navigation, and summary display/persistence.
  - [ ] Run the full local gate (`npm run lint` → `npm run typecheck` → `npx vitest run` → `npm run build` → `npm run check:manifest` → `npm run check:bundle` → `npm run check:store` → `npm run check:site` → `xvfb-run -a npm run test:e2e`) and synchronize `conductor/{product,tech-stack,patterns}.md`.

- [ ] Task: Conductor - User Manual Verification 'Phase 5: End-to-End Verification, Performance Benchmarks & Documentation Sync' (Protocol in workflow.md)
  <!-- depends: task1 -->
