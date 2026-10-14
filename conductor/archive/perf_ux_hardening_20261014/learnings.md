# Track Learnings: perf_ux_hardening_20261014

Patterns, gotchas, and context discovered during implementation.

## Approved Decisions (2026-10-14)

- Scope includes all 39 findings from the 2026-10-14 whole-codebase audit: Backend/MV3 correctness (`B-01`–`B-16`), 5k–20k scaling performance (`P-01`–`P-13`), and UI/UX & accessibility (`U-01`–`U-10`).
- Side-panel page summarization (`B-06`) requests runtime origin permission on the user's `"Agree and summarize"` click (using the existing optional `https://*/*` / loopback capability) when `activeTab` is not active on the target tab.
- High (P1) priority, automated gates only (no manual wait at phase boundaries or completion), and task-level parallel execution enabled for file-disjoint tasks within phases.

## Codebase Patterns (Inherited from `conductor/patterns.md` & `deep_audit_fixes_20261005`)

- **Strict TypeScript & CSP-safe Zod:** `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; import `z` exclusively from `src/schemas/z.ts` (jitless mode).
- **Total Message Handlers & Fail-Closed Gates:** `runtime.onMessage` handlers return `{ok:true,…} | {ok:false,code,message}` Zod unions and never throw or leak `cause` objects. Outbound network calls live only in `src/net/{send,llm-send}.ts`.
- **Dexie & Concurrency Invariants:** Read-modify-write belongs inside the table's `rw` transaction. Dexie `add`/`put` mutates inbound keys onto caller objects—always pass fresh copies.
- **Undo & Mutation Ordering:** Enable writes settings → key → consent; revoke removes consent first. Undo replay must be idempotent and resumable under `withUndoLock`; flow-owned snapshots use `discardById(snapshotId)` / `restoreById(snapshotId)` rather than stack-head `discardLatest()` / `undoExpected()` when concurrent snapshots can interleave.
- **Parallel-Safe Performance Tests:** Never assert a single wall-clock sample under 17-worker Vitest load; use best-of-N minimum estimators (`tests/unit/search-perf.test.ts`) or injected cadence seams (`pollMs`, `undoToastAutoHideMs`).
- **Store & Manifest Discipline:** Keep `store/permissions.md`, `store/reviewer-notes.md`, and `wxt.config.ts` aligned; verify with `npm run check:manifest` and `npm run check:store`.

---

<!-- Learnings from implementation will be appended below -->

## [2026-10-14] - Phase 1 Task 1: MV3 DB release coordination, corrupt-meta batching, and indexed tombstone pruning (`B-04`, `P-09`)
- **Implemented:** Added `handleDbReleaseMessage(message, onRelease)` in `src/security/delete-all.ts` closing `db` with `{ disableAutoOpen: true }`, guarded `LlmBudget`'s `useLiveQuery` with `.catch(() => [0, 0, 0] as const)`, batched corrupt-row retention via `retainCorruptMetaBatch` in `src/db/meta.ts`, and updated `pruneTombstones` / `tombstoneMetaByIds` in `src/db/tombstones.ts` to use `removedAt` index `.primaryKeys()` and `bulkGet`/`bulkPut`/`bulkDelete`. Also added `.claude/**` to `eslint.config.mjs` `ignores`.
- **Files changed:** `eslint.config.mjs`, `src/security/delete-all.ts`, `src/db/meta.ts`, `src/db/tombstones.ts`, `src/entrypoints/options/LlmBudget.tsx`, `tests/unit/delete-all.test.ts`, `tests/unit/meta-tombstones.test.ts`, `tests/components/options-llm-budget.test.tsx`
- **Commit:** `3d2b29a`
- **Learnings:**
  - Patterns: `handleDbReleaseMessage(message, onRelease)` lets both extension pages (`registerDbReleaseListener`) and the service worker (`background.ts`) share one synchronous `disableAutoOpen: true` release path while allowing caller-owned release callbacks.
  - Gotchas: `useLiveQuery` callbacks that touch `db` on the Options page reject when `db.close({ disableAutoOpen: true })` runs during delete-all; attaching `.catch()` inside the querier prevents unhandled rejections and allows the live effect to settle cleanly.
---

## [2026-10-14] - Phase 1 Task 2: `MutationVerifyCache` coherence, startup reconcile tombstone fast-path, `bookmarkMeta.url` D12 maintenance, and bulk tag-ops batching (`B-09`, `B-10`, `P-05`, `P-06`)
- **Implemented:** Updated `moveNode`, `removeNode`, and `removeTree` in `src/sync/mutations.ts` to keep `cache.nodes` current and clear `cache.parents` when folders move or are removed; added `db.metaTombstones.toCollection().primaryKeys()` pre-check in `reconcileMetadata` (`src/sync/reconcile.ts`); maintained `bookmarkMeta.url` in `createBookmark`/`updateBookmark`, `onChanged` (`src/sync/listeners.ts`), and `bulkAddTag`/`bulkSetCategory` (`src/sync/tag-ops.ts`); batched `bulkAddTag`/`bulkRemoveTag`/`bulkSetCategory` into a single `rw` transaction with `bulkGet`/`bulkPut`/`bulkDelete` and one post-commit `emitMetaChanged()`; and skipped leaf `childPath` allocations in `flattenTree` (`src/sync/tree.ts`).
- **Files changed:** `src/sync/mutations.ts`, `src/sync/reconcile.ts`, `src/sync/listeners.ts`, `src/sync/tag-ops.ts`, `src/sync/tree.ts`, `tests/unit/sync-mutations.test.ts`, `tests/unit/sync-reconcile.test.ts`, `tests/unit/tag-ops.test.ts`, `tests/unit/sync-tree.test.ts`
- **Commit:** `b63f9ec`
- **Learnings:**
  - Patterns: Resolve live bookmark URLs via `chrome.bookmarks.get(uniqueIds)` (with per-id fallback) *outside* the IndexedDB transaction before `bulkGet`/`bulkPut` so IDB transactions never wait on Chrome IPC.
  - Gotchas: Moving a folder invalidates the cached ancestor chains (`cache.parents`) of the moved folder and all its descendants; clearing `cache.parents` on cross-parent folder moves prevents stale cycle-check bypasses and false-positive cycle rejections.
---

## [2026-10-14] - Phase 1 Tasks 3 & 4: Field-scoped metadata undo, recursive `UNDO_NODE_BUDGET`, transactional import claims, and batched IO/restore (`B-03`, `B-08`, `B-10`, `B-16b`, `P-07`, `P-08b`)
- **Implemented:** Added `UndoMetaDelta` for field-scoped metadata undo (`tags` / `category`), recursive `countUndoNodes` and `db.jobs` restructure snapshot protection in `pushSnapshot`, `origin: "user"` default in `peekLatest`/`undoLatest` (with `{ origin: "any" }` in `runUndoExpected` and `discardLatest`), batched `restoreMetaRows`/`restoreRestructure`/`restoreTagDelete` with `ctx.verify.nodes` reuse, transactional `persistState` with `claimedBy`/cancel checks in `import-write.ts`, and UTF-8 upper-bound fast-paths + direct-child `<dl>` traversal in `src/io/{netscape,export-json,csv}.ts`.
- **Files changed:** `src/schemas/undo.ts`, `src/undo/snapshot.ts`, `src/undo/restore.ts`, `src/io/import-write.ts`, `src/io/netscape.ts`, `src/io/export-json.ts`, `src/io/csv.ts`, `tests/unit/undo.test.ts`, `tests/unit/undo-retention.test.ts`, `tests/unit/decisions-apply.test.ts`, `tests/unit/io-import.test.ts`, `tests/unit/io-netscape.test.ts`, `tests/unit/io-json.test.ts`, `tests/unit/io-csv.test.ts`
- **Commits:** `abea0b8`, `ccec374`
- **Learnings:**
  - Patterns: Check `Dexie.currentTransaction === null || Dexie.currentTransaction.storeNames.includes("jobs")` in `pushSnapshot` so nested calls inside outer transactions that omit `db.jobs` (e.g., `deleteTagWithUndo`) never fail with missing-store transaction errors.
  - Gotchas: When `peekLatest()` defaults to `origin: "user"` so UI/hotkey undo skips decision snapshots, internal ID-targeted stack checks (`runUndoExpected`, `discardLatest`) must pass `{ origin: "any" }`.
---

## [2026-10-14] - Phase 2 Tasks 1, 2 & 5: Indexed decision store, `PrecomputedAnalysisIndex`, pair error isolation, LLM `record.tier`, and scoped consent/summary hardening (`B-01`, `B-05`, `B-06a`, `B-08`, `B-11`, `B-12`, `B-14`, `P-01a`, `P-02`, `P-03a`)
- **Implemented:** Added `allowDistinctUrls` to `mergeGroup` and empty-merge `stale` refusal in `applyMerge`; wired field-scoped `UndoMetaDelta` in `applyTags`/`applyCategory`; serialized and claim-guarded `revertDecision`; switched `hasDecidedSlotRow`, `persistDecision`, and `deleteReviewableByBookmarkIds` to the `*bookmarkIds` multiEntry index with `!claimLive` supersession guard; added `PrecomputedAnalysisIndex` and `WeakMap` caches in `src/decisions/candidates.ts`; unified URL parsing in `src/decisions/near-duplicate-plan.ts`; isolated non-fatal pair errors in `runPairs` and added post-network `assertJobAuthority` checks in `pipeline.ts` and `duplicates.ts`; propagated `record.tier ?? "json_schema"` in `explainDecision`/`summarizePage`/`maybeEscalateDecision`, added guard freshness + folder path resolution + `stripUrlsAndMarkdown` sanitization in `explainDecision`, scoped `revokeConsentsAtOrigin` to `JEV_CONSENT_SCOPES` vs `LLM_CONSENT_SCOPES` with shared-origin permission checks, and added `jev_summary_verify` usage recording + persist-stage `admitSummary` without `tabId` + preflight tab/origin checks.
- **Files changed:** `src/decisions/{store,apply,candidates,pipeline,duplicates,near-duplicate-plan,summaries}.ts`, `src/duplicates/merge.ts`, `src/db/retention.ts`, `src/llm/{explain,summarize,escalate}.ts`, `src/jev/tasks/verify-summary.ts`, `src/extract/page.ts`, `src/messages/{summaries,provider,llm-provider}.ts`, `src/consent/records.ts`, `store/{permissions,reviewer-notes}.md`, and unit tests.
- **Commits:** `1c3faa6`, `e6f9fb3`, `a8451a2`
- **Learnings:**
  - Patterns: Combine explicit `PrecomputedAnalysisIndex` on `AnalysisContext` with `WeakMap` caches keyed on `corpus`/`tagDefs`/`tree` inside `candidates.ts` so both job-level callers and direct callers get $O(1)$ per-bookmark lookup after the first pass.
  - Gotchas: Revoking an LLM or Jev provider that shares a `permissionPattern` (`https://openrouter.ai/*` or `http://localhost/*`) with another configured provider must check both `JEV_PROVIDER_IDS` and `listLlmProviders()` before calling `chrome.permissions.remove`.
---

## [2026-10-14] - Phase 2 Tasks 3 & 4: Positional job batch slicing, keepalive serialization, non-blocking stale-job watchdog, and restructure preflight/rollback hardening (`B-02`, `B-04a`, `B-07`, `B-13`, `B-15`, `B-16a`, `P-01b`, `P-04`, `P-08a`)
- **Implemented:** Sliced `job.bookmarkIds` positionally per batch before `liveById` filtering and recorded isolated per-pair failures in `JobRunner`; cached `PrecomputedAnalysisIndex` in `createPipelineAnalyzer`/`loadAnalysisContext`; serialized keepalive session storage RMW (`markSessionJob`/`unmarkSessionJob`/`drainSessionJobs`), made `reDriveStaleJobs` non-blocking, and added `{ preempt: true }` in `coordinateJob`; handled `RELEASE_DB_MESSAGE` and paused jobs when `activeProvider()` is `null` in `background.ts`; added Jev + `MAX_JOB_BOOKMARK_IDS` preflight checks and removed premature `setJobStatus("running")` in `startRestructure`; moved diff computation inside `serializeApply`/`withUndoLock`, seeded `MutationVerifyCache`, handled vanished bookmarks, called `discardById` on clean rollback, and used `restoreById` in `undoRestructurePlan`; bounded/merged folder paths in `buildLibrarySynopsis` and passed `record.tier` in `proposeLayout`.
- **Files changed:** `src/jobs/{runner,queue,keepalive,coordinator}.ts`, `src/entrypoints/background.ts`, `src/restructure/{apply,synopsis,propose}.ts`, `src/messages/restructure.ts`, and unit tests.
- **Commits:** `00ba0c9`, `7832cc6`
- **Learnings:**
  - Patterns: Moving `getTree()` and `buildRestructureDiff` inside `serializeApply`/`withUndoLock` (after checking `stillApplied`) prevents concurrent confirm calls from racing on stale tree state and lets `applyRestructurePlan` seed `MutationVerifyCache` once from the same tree snapshot.
  - Gotchas: Because `startRestructure` now verifies `readActiveJevProvider("jev_decisions")` before calling `proposeLayout`, integration tests that drive `RESTRUCTURE_START` must seed an enabled Jev provider settings row and `jev_decisions` consent alongside the LLM provider.
---

## [2026-10-14] - Phase 3 Tasks 1 & 2: Search index/run/live-cache/omnibox performance and `suggest.ts` / `QueryInput` ergonomics (`P-12`, `U-06a-c`)
- **Implemented:** Added precomputed `treeOrderRank` and `docs` map to `RunQueryContext` so term-free queries filter `SearchDocument` entries directly in `treeOrder` without allocating wildcard `SearchHit` objects for the entire corpus; replaced full-library `normalizeUrl` rescanning on every `createLiveSearchCache.update` with incremental `byRawUrl`/`byNormKey`/`dupBuckets` tracking; updated `applyDocDiff` to rebuild in-place (`removeAll` + `addAll`) or vacuum on bulk diffs; backed `omnibox.ts` `loadSessionIndex` with `createLiveSearchCache({ indexedFields: OMNIBOX_INDEXED_FIELDS })`; removed unimplemented `"dead"` from `is:` suggestions in `suggest.ts`; restricted filter-key completions to non-empty prefix matches (plus lone `-`) and suppressed auto-open on empty/whitespace input; and updated `QueryInput` to reset `activeIndex` on `onChange`, set `dismissed = true` on `Escape` when closed, and scroll the active option into view.
- **Files:** `src/search/index.ts`, `src/search/run.ts`, `src/search/live-cache.ts`, `src/search/omnibox.ts`, `src/search/suggest.ts`, `src/ui/components/query-input.tsx`, `tests/unit/search-index.test.ts`, `tests/unit/search-run.test.ts`, `tests/unit/search-live-cache.test.ts`, `tests/unit/omnibox.test.ts`, `tests/unit/search-suggest.test.ts`, `tests/components/query-input.test.tsx`
- **Commit:** `9453369`, `0b48937`
- **Learnings:**
  - Patterns: Term-free search queries (`plainTerms.length + exactSubs.length === 0`) never have `phrases` and `filtersOk` only inspects `SearchDocument` fields, so filtering `ctx.docs` in `ctx.treeOrder` avoids `index.search(MiniSearch.wildcard)`'s $O(N)$ `SearchResult` allocation and `.sort()`.
  - Gotchas: `IS_VALUES` in `src/search/query.ts` must keep `"dead"` so `parseQuery("is:dead")` continues to emit its unsupported-filter warning, while `src/search/suggest.ts` filters `"dead"` out of `SUGGESTED_IS_VALUES`.
---

## [2026-10-14] - Phase 4 Tasks 1–5: Side Panel, Popup & Options UI/UX, Performance & Accessibility (`B-06b`, `P-03b`, `P-10`, `P-11`, `P-13a-b`, `U-01`–`U-05`, `U-06d`, `U-07`–`U-10`)
- **Implemented:** Cleared `searchQuery` across all view selections and passed `activeView` to `ScopePane`/`ViewChips`; excluded `llm_test` in `readAiConnected`; added `snapshotId` on `BulkBar` delete toasts, persistent `analyze_selection` job status strip when selection is cleared, `Ctrl/Cmd+Z` undo, hover/focus pause and `BulkBar` offset on `UndoToast`; deferred `scanBookmarks`/`ScanPanel` and `ExportDialog`/`CommandPalette` work when closed; added `CommandPalette` `aria-activedescendant` guard, `scrollIntoView`, hover highlight, `scan`/`review`/`restructure` commands, and `TopBar` Tools menu entry; memoized `useBookmarkSelection` and `BookmarkList` `indexById`; virtualized `DuplicatesView` with `@tanstack/react-virtual`; added `validOver` drop indicators, grid card `DragHandle`, and narrow-mode `ScopeHeading` drag-over drawer open; added narrow-width tag truncation and action wrapping across `BookmarkList`, `DuplicatesView`, `ReviewView`, and `TagManager`; rendered `job.error` and indeterminate initial progress in `RestructureView` and removed `tabIndex={0}` on static `<li>` rows; marked `FaviconPlaceholder` `aria-hidden="true"` and applied roving `tabIndex={active ? 0 : -1}` to inner row controls; displayed/cleared saved summaries and requested runtime host permissions on click in `SummaryDialog`; committed pending `tagInput` on Save, gated folder fields, displayed/cleared saved summaries, and stamped `metaPatch.url` in `EditDialog`; deferred `listMeta`/`listTags`/`useSearchIndex` until `searchOpen`, memoized $O(1)$ duplicate URL lookup, committed pending `tagInput` on Save, added filter autocomplete in `PopupSearch`, toggled search via header icon, rendered `<ErrorAlert>` while searching, and added explicit `Suggest` status feedback in Popup; and added per-feature consent management, all-preset consent status, controlled Built-in blocklist `<Disclosure>`, `#blocklist-entry` `Enter` key, inline card feedback, and `"in Connections"` copy in `DecisionSettings.tsx`.
- **Files:** `src/entrypoints/sidepanel/{App,useAiConnected,BulkBar,UndoToast,CommandPalette,palette,TopBar,ExportDialog,BookmarkList,FolderTree,dnd,DuplicatesView,ReviewView,RestructureView,TagManager,ScopeHeading,SummaryDialog,EditDialog,FolderActions}.{ts,tsx}`, `src/ui/components/favicon.tsx`, `src/entrypoints/popup/{App,Search,Suggestions,PageCard}.tsx`, `src/entrypoints/options/DecisionSettings.tsx`, `tests/components/**`
- **Commit:** `d356401`, `e171e50`, `480f911`, `cda4bb1`, `2a90417`
- **Learnings:**
  - Patterns: For `@tanstack/react-virtual` in views tested in jsdom without stubbed element rects (`DuplicatesView`), falling back to rendering the first `Math.min(groups.length, VIRTUAL_THRESHOLD)` items when `virtualizer.getVirtualItems().length === 0` keeps existing small-corpus component tests working while bounding DOM nodes on large duplicate sets.
  - Gotchas: Requesting optional host permissions (`chrome.permissions.request`) for `SummaryDialog` must happen inside the user's synchronous click handler on `"Agree and summarize"` before dispatching `LLM_SUMMARIZE` to the service worker.
---

## [2026-10-14] - Phase 5 Task 1: Performance & E2E regressions, full CI gate, and documentation sync (`B-01`–`B-16`, `P-01`–`P-13`, `U-01`–`U-10`)
- **Implemented:** Added 10k-bookmark performance benchmarks for `PrecomputedAnalysisIndex`, `*bookmarkIds` indexed `persistDecision`, startup `reconcileMetadata`, filter-before-hit `runQuery`, and incremental `createLiveSearchCache.update`; added Playwright e2e regression coverage for near-duplicate `merge_duplicates` approval, search-to-folder routing, and saved summary view/clear; synchronized `conductor/{product,tech-stack,patterns}.md`; and verified the full local gate (`lint`, `typecheck`, 167 unit/component test files / 3,037 tests, `build`, `check:manifest`, `check:bundle`, `check:store`, `check:site`, and 49 Playwright e2e specs).
- **Files:** `tests/unit/decisions-perf.test.ts`, `tests/unit/search-perf.test.ts`, `tests/e2e/audit-deep-fixes.spec.ts`, `tests/e2e/llm.spec.ts`, `conductor/product.md`, `conductor/tech-stack.md`, `conductor/patterns.md`
- **Commit:** `d7cbfc2`
- **Learnings:**
  - Patterns: Best-of-N (`Math.min`) sampling across 10k-bookmark scaling benchmarks (`decisions-perf.test.ts`, `search-perf.test.ts`) isolates algorithmic speedups from 17-worker Vitest scheduler jitter.
  - Gotchas: E2E tests driving `RESTRUCTURE_START` via the UI (`llm.spec.ts:409`) must enable a Jev provider and grant `jev_decisions` consent alongside the LLM provider because `startRestructure` now validates `readActiveJevProvider(DECISIONS_CONSENT_SCOPE)` before calling `proposeLayout`.
---
