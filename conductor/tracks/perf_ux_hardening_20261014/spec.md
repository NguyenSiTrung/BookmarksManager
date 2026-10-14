# Correctness, Performance & UI/UX Hardening

## Overview

Resolve all 39 findings from the 2026-10-14 whole-codebase audit across three areas without rewriting the extension:
1. **Backend, Concurrency & MV3 Lifecycle Correctness (`B-01`–`B-16`)**
2. **5k–20k Bookmark Scaling & Indexing Performance (`P-01`–`P-13`)**
3. **UI/UX Workflows, Narrow Sidepanel Layout & Accessibility (`U-01`–`U-10`)**

Native Chrome bookmarks remain the source of truth. Core features stay offline; optional AI remains consent-gated and exact-origin scoped.

- **Track ID:** `perf_ux_hardening_20261014`
- **Type:** bug / performance / UX hardening
- **Priority:** High (P1)
- **Execution:** Five sequential phases; task-level parallelism enabled only where tasks have strictly disjoint `files` and no `depends` edges (annotated in `plan.md`).
- **Verification:** Automated gates only (user decision, 2026-10-14). Same override as `audit_hardening_20261001` and `deep_audit_fixes_20261005`: no manual wait at phase boundaries or at track completion; automated task, phase, and final gates stay mandatory.
- **Track dependencies:** none (all earlier tracks archived).
- **Estimate:** unset (`null`).

## Verify-First Rule

Every behavior task begins with a failing regression test (or deterministic performance benchmark) against current code. If a test cannot be made to fail because an earlier guard already covers the path, record the evidence in `learnings.md`, skip the behavior change for that item, and keep the test only if it guards a plausible consumer-visible regression.

## Functional Requirements

Line references below are from the 2026-10-14 audited baseline and will move as edits land.

### 1. Backend, Concurrency & MV3 Lifecycle (`B-01`–`B-16`)

| ID | Requirement |
|---|---|
| B-01 | `approveDecision` on a `merge_duplicates` decision (`src/decisions/apply.ts:375-391`) must merge metadata and remove the duplicate bookmark via `mergeGroup` (`src/duplicates/merge.ts:218-262, 335-341`) even when the pair's URLs do not normalize equal (because `planNearDuplicates` at `src/decisions/near-duplicate-plan.ts:265-282` excludes normalized-equal URLs and `assertFresh` already verifies snapshot URL/title identity). If `result.removedIds.length === 0` or `result.snapshotId === undefined`, refuse with `DecisionApplyError("stale")` rather than transitioning to `"applied"` without an undo snapshot. |
| B-02 | `JobRunner.run` bookmark phase (`src/jobs/runner.ts:413-468, 591-595`) must slice `job.bookmarkIds` positionally per batch (`index * batchSize` to `(index + 1) * batchSize`) and filter each batch slice against `liveById` (matching the pair phase at `src/jobs/runner.ts:633-635`), preventing mid-job bookmark deletions from shifting batch boundaries and re-sending already-billed bookmarks across pause/resume or worker restarts. |
| B-03 | In `src/io/import-write.ts:311-314, 491-615, 703-722, 829-834`: `writeImport` stamps `claimedBy: crypto.randomUUID()` on the initial `ImportState`; `persistState` updates `db.importStates` conditionally inside a transaction and refuses to overwrite if the row is missing, `status === "cancelled"`, or `claimedBy !== state.claimedBy`; `listInterruptedImports` filters out rows with an active claim (`claimedBy !== undefined && Date.now() - Date.parse(updatedAt) < CLAIM_TTL_MS`). |
| B-04 | `src/entrypoints/background.ts:675-763` handles `RELEASE_DB_MESSAGE` (`"bookmarksManager:release-db"`) before protocol dispatch, suppresses/aborts in-flight worker startup DB writes while releasing, and closes `db` with `disableAutoOpen: true` (`src/security/delete-all.ts:197-255, 355-375`). `src/entrypoints/options/LlmBudget.tsx:148-156` attaches `.catch(() => [0, 0, 0] as const)` to its `useLiveQuery` callback. |
| B-05 | Provider revocation in `src/messages/provider.ts:435-485` and `src/messages/llm-provider.ts:756-820` revokes only the consent scopes owned by that provider layer (`jev_test` / `jev_decisions` / `jev_summary_verify` vs. `llm_test` / `llm_explain` / `llm_escalate` / `llm_restructure` / `llm_summary`) via `src/consent/records.ts:127-143`, and only calls `chrome.permissions.remove` when no remaining configured Jev or LLM provider still resolves to the same `permissionPattern`. |
| B-06 | Side-panel page summarization (`src/entrypoints/sidepanel/SummaryDialog.tsx:136-158`, `src/extract/page.ts:144-245`, `src/messages/summaries.ts`) checks active-tab URL compatibility during preflight when readable, and requests runtime origin permission from the user's `"Agree and summarize"` click (using the existing optional `https://*/*` / loopback capability in `wxt.config.ts`) when `activeTab` is not active on the target tab. `store/permissions.md` and `store/reviewer-notes.md` stay synchronized with `check:manifest` and `check:store`. |
| B-07 | `startRestructure` (`src/messages/restructure.ts:300-446`) verifies an active consented Jev provider (`jev_decisions`) and `leafIds.length <= MAX_JOB_BOOKMARK_IDS` before calling `proposeLayout`, and does not manually set `job.status = "running"` before `drivePersistedJob`. In `drivePersistedJob` (`src/entrypoints/background.ts:368-375`), when `activeProvider()` is `null`, any `"running"`/`"pending"` job is transitioned to `"paused"` and unmarked via `unmarkSessionJob(jobId)`. |
| B-08 | Undo stack hardening (`src/undo/snapshot.ts:220-310`, `src/undo/restore.ts:505-535, 710-725`, `src/decisions/apply.ts:251-267`, `src/schemas/undo.ts`): `add_tags` and `set_category` decision undo snapshots record and restore field-scoped deltas so reverting one decision never clobbers subsequent edits to `notes`, `summary`, `tags`, or `category`; `pushSnapshot` counts `UndoNode` subtrees recursively for `UNDO_NODE_BUDGET`, includes `job.restructure.applied.snapshotId` from `db.jobs` in `protectedIds`, and uses indexed status queries; `peekLatest`/`undoLatest` default to `origin: "user"`. |
| B-09 | `moveNode`, `removeNode`, and `removeTree` in `src/sync/mutations.ts:120-165, 235-268, 520-550` update `cache.nodes` and clear `cache.parents` when folders are moved or removed so subsequent cached mutations see accurate parent IDs and ancestor chains. |
| B-10 | Populate and maintain `bookmarkMeta.url` (D12) across `src/sync/tag-ops.ts`, `src/sync/mutations.ts`, `src/decisions/summaries.ts`, `src/entrypoints/sidepanel/EditDialog.tsx`, `src/undo/restore.ts`, and `src/sync/listeners.ts:handleChanged` so worker-suspended bookmark deletions preserve URL tombstones during `reconcileMetadata()`. |
| B-11 | Isolate per-pair failures in `runPairs` (`src/decisions/duplicates.ts:401-497`) / `JobRunner.run` (`src/jobs/runner.ts:628-660`) so one failing near-duplicate pair does not abort the remaining pairs in a 25-pair batch; re-check `assertJobAuthority` after network calls before calling `persistDecision` or `approveDecision` in `src/decisions/pipeline.ts:740-815` and `src/decisions/duplicates.ts`. |
| B-12 | Record `jev_summary_verify` token/cost usage via `appendUsage` in `summarizeExtracted` (`src/decisions/summaries.ts:318-358`, `src/jev/tasks/verify-summary.ts:75-87`), and call `admitSummary(input.bookmarkId, extract)` without `input.tabId` at the final `persist` stage so background continuation succeeds even if the user navigated or closed the tab during LLM/Jev calls. |
| B-13 | `applyRestructurePlan` (`src/restructure/apply.ts:183-372`) computes its diff inside `serializeApply`/`withUndoLock`, handles vanished bookmarks on `get(row.bookmarkId)` without failing as `mutation_failed`, calls `discardById(snapshotId)` when rollback cleanly restores all moves/folders, and `undoRestructurePlan` uses `restoreById(snapshotId)`. |
| B-14 | Pass `tier: record.tier ?? "json_schema"` in `explainDecision` (`src/llm/explain.ts:224`), `summarizePage` (`src/llm/summarize.ts:95`), `maybeEscalateDecision` (`src/llm/escalate.ts:169`), and `proposeLayout` (`src/restructure/propose.ts:75`). In `explainDecision`, check `row.guard` freshness, resolve `move` folder IDs to folder paths instead of `"folder id <id>"`, and sanitize `rationale` via `stripUrlsAndMarkdown` (also in `maybeEscalateDecision`). |
| B-15 | Serialize `markSessionJob`, `unmarkSessionJob`, and `drainSessionJobs` in `src/jobs/keepalive.ts:115-140`; fire `relaunch` non-blockingly in `reDriveStaleJobs` (`src/jobs/queue.ts:782-820`) and allow watchdog preemption of wedged owners in `src/jobs/coordinator.ts:8-20`. |
| B-16 | Filter empty (`""`) folder paths, truncate folder paths `> 400` chars (`RESTRUCTURE_LIMITS.path`), and merge duplicate sibling folder title buckets in `buildLibrarySynopsis` (`src/restructure/synopsis.ts:115-166`); validate `latestRestructureJob` with `Job.safeParse` (`src/messages/restructure.ts:456-462`); validate `ImportQueueRow.safeParse` in `writeImport` and `resumeImport` and move initial queue/state writes inside `writeImport`'s `try/catch` before Chrome folder creation (`src/io/import-write.ts:655-735, 787-796`). |

### 2. Performance & Scaling (`P-01`–`P-13`)

| ID | Requirement |
|---|---|
| P-01 | Precompute `PrecomputedAnalysisIndex` (`domainTagFreq: Map<string, Map<string, number>>`, pre-tokenized `tagTokens`, `folderTokens`) once per `AnalysisContext` (`src/decisions/candidates.ts:111-125, 162-254`) and cache `AnalysisContext` across batches in `JobRunner` (`src/jobs/runner.ts:460-563`, invalidating on bookmark/meta changes), eliminating $O(N^2)$ per-bookmark URL/folder scans and per-batch `getTree()`/`listMeta()` reloads. |
| P-02 | Use the `*bookmarkIds` multiEntry index in `persistDecision`, `hasDecidedSlotRow`, and `sweepReviewableDecisions` (`src/decisions/store.ts:191-205, 285-315, 377-409`), guard `!claimLive(other.claim)` on supersession deletes, and serialize `revertDecision` (`src/decisions/apply.ts:577-633`). Also avoid full-partition sort in `pruneTerminalDecisionsLocked` (`src/db/retention.ts:285-315`) when count is within cap. |
| P-03 | Combine `extractDomain` and `normalizeUrl` into a single `new URL()` parse in `prepare()` (`src/decisions/near-duplicate-plan.ts:166-210`), and gate `scanBookmarks` allocation in `src/entrypoints/sidepanel/App.tsx:287-294` on `scanOpen === true`. |
| P-04 | Avoid $O(B^2)$ full-array rewrites and Zod re-parses of `restructure.assignments` inside `db.jobs` on every batch (`src/jobs/queue.ts:750-776`) by reading assignments from `db.restructureAssignments` when building restructure plans/diffs. |
| P-05 | In `reconcileStartup()` (`src/sync/reconcile.ts:127-129`), fetch `db.metaTombstones.toCollection().primaryKeys()` first and only invoke `reattachTombstone(url, id)` for URLs present in both `tombstoneUrls` and `urlToId` (eliminating 20,000 sequential IDB `rw` transactions on startup when `metaTombstones` is empty). |
| P-06 | Batch `bulkAddTag`, `bulkRemoveTag`, and `bulkSetCategory` (`src/sync/tag-ops.ts:122-243`) into a single Dexie `rw` transaction using `bulkGet`/`bulkPut`/`bulkDelete` and a single post-commit `emitMetaChanged()`. Share immutable folder `path` arrays across direct leaf children in `flattenTree` (`src/sync/tree.ts:96-135`). |
| P-07 | Pass a `MutationVerifyCache` into `driveImport` (`src/io/import-write.ts:488-665`), batch `persistState` checkpoints every 25–50 items (and on pause/abort/completion), batch `putMeta` and `mergeSkippedDuplicates` with a single `emitMetaChanged()`, use the `text.length * 3 <= MAX_FILE_BYTES` fast-path before `TextEncoder` in `src/io/{netscape,export-json,csv}.ts`, and replace descendant `dt.querySelectorAll("dl")` in `src/io/netscape.ts:276-290` with a shallow child/element check. |
| P-08 | Seed `MutationVerifyCache` from `liveTree` and capture nodes from `liveTree` in `applyRestructurePlan` (`src/restructure/apply.ts:227-268`). In `src/undo/restore.ts:255-283, 493-677`, consult `ctx.verify.nodes` inside `nodeExists(parentId, ctx)` and batch metadata restoration in `restoreMetaRows`, `restoreRestructure`, and `restoreTagDelete` with a single `emitMetaChanged()`. |
| P-09 | Batch corrupt-row retention in `refreshMetaIntegrity` (`src/db/meta.ts:147-166, 681-705`), use `removedAt` index `.primaryKeys()` in `pruneTombstones`, and use `bulkGet`/`bulkPut`/`bulkDelete` in `tombstoneMetaByIds` (`src/db/tombstones.ts:81-145`). |
| P-10 | In `src/entrypoints/popup/App.tsx:317-334, 413, 419-425`, defer `listMeta()`/`listTags()` and `useSearchIndex` construction until `searchOpen === true`, and precompute a `Map<string, BookmarkItem>` of `normalizedUrl -> item` keyed on `[tree]` so `duplicate` lookup on URL edits is $O(1)$. |
| P-11 | Memoize `retain(rawSelected, orderedIds)` and `orderIndexMap` in `useBookmarkSelection` (`src/entrypoints/sidepanel/BookmarkList.tsx:167-218`). |
| P-12 | Precompute `treeOrderRank: ReadonlyMap<string, number>` in `createLiveSearchCache` and `buildSearchHandle` (`src/search/run.ts:242-254`, `src/search/live-cache.ts:195`); filter against `SearchDocument` before allocating `SearchHit` objects in `allDocs` (`src/search/run.ts:290-302`); maintain incremental duplicate URL buckets in `createLiveSearchCache` (`src/search/live-cache.ts:189-192`); rebuild or vacuum MiniSearch when bulk diffs exceed 30% of index size (`src/search/index.ts:306-320`); and back `createSharedSearchIndex` in `src/search/omnibox.ts:113-147` with `createLiveSearchCache`. |
| P-13 | Virtualize the duplicate groups list in `src/entrypoints/sidepanel/DuplicatesView.tsx:148-190` using `@tanstack/react-virtual`, and short-circuit `CommandPalette.tsx:61-65` and `ExportDialog.tsx:417-424` `useMemo`s when `open === false`. |

### 3. UI/UX, Narrow Sidepanel Layout & Accessibility (`U-01`–`U-10`)

| ID | Requirement |
|---|---|
| U-01 | Clear `setSearchQuery("")` for all view selections in `selectView` (`src/entrypoints/sidepanel/App.tsx:314-318, 711-715`) and pass `activeView` to `ViewChips` and `ScopePane` so no chip or folder falsely appears active during global search. |
| U-02 | Render saved `bookmarkMeta.summary` in `SummaryDialog.tsx` (showing the existing summary first with `"Re-summarize"` and `"Clear summary"` buttons) and inside `EditDialog.tsx`; skip the full disclosure wall in `SummaryDialog` when both `llm_summary` and `jev_summary_verify` are already granted, and require an unchecked agreement `<Checkbox>` when either grant is missing. |
| U-03 | Add a per-feature permissions section in `src/entrypoints/options/DecisionSettings.tsx` displaying active status and `Revoke` buttons for `llm_explain`, `llm_restructure`, `llm_summary`, and `jev_summary_verify`; exclude `LLM_TEST_SCOPE` in `src/entrypoints/sidepanel/useAiConnected.ts:15-24`. |
| U-04 | Commit uncommitted non-empty `tagInput.trim()` on Save in both `src/entrypoints/popup/App.tsx:385-430` and `src/entrypoints/sidepanel/EditDialog.tsx:142-205`; gate `Tags`, `Category`, and `Notes` behind `{isBookmark && (...)}` in `EditDialog.tsx:222-324` and enforce `maxLength` bounds. |
| U-05 | Pass `snapshotId: result.snapshotId` on `BulkBar` delete toast (`src/entrypoints/sidepanel/BulkBar.tsx:289-293`); require confirmation before deleting multiple bookmarks or any folder; add global `Ctrl/Cmd+Z` undo in `src/entrypoints/sidepanel/App.tsx`; pause `UndoToast` auto-hide on pointer hover / focus (`src/entrypoints/sidepanel/UndoToast.tsx:72, 249-289`); and offset `UndoToast` above `BulkBar` when selection is non-empty. |
| U-06 | Remove unimplemented `"dead"` from `IS_VALUES` in `src/search/suggest.ts:211`; restrict filter-key suggestions to non-empty prefix matches; in `src/ui/components/query-input.tsx:62-70, 114-154`, call `setDismissed(true)` on `Escape`, reset `setActiveIndex(-1)` on `onChange`, and `scrollIntoView({ block: "nearest" })` the active suggestion; wire filter suggestions into `src/entrypoints/popup/Search.tsx`. |
| U-07 | Expose `validOver` (`isOver && !invalid`) from `useDropZone` (`src/entrypoints/sidepanel/dnd.tsx:591-648`) to render a top insertion line (`border-t-2 border-primary`) on reorder slots and a highlight ring (`ring-2 ring-primary bg-accent/40`) on folder drop targets; add `DragHandle` to grid cards in `BookmarkList.tsx`; and auto-open `ScopeDrawer` when dragging over `ScopeHeading` in narrow mode (`< 640px`). |
| U-08 | Fix narrow sidepanel (`320px–360px`) horizontal crushing: add `max-w-[72px] truncate` to list-row tag chips and `shrink-0 whitespace-nowrap` to the toolbar item count in `BookmarkList.tsx:454-490, 762-826`; cap visible tags and wrap member actions in `DuplicatesView.tsx:271-332`; wrap row actions cleanly in `ReviewView.tsx:1158-1271`; add `flex-wrap` to `TagRow` in `TagManager.tsx:315-356`; and add `max-h-[85vh] overflow-y-auto` + `focus-visible:ring-2` classes to `EditDialog.tsx`, `FolderActions.tsx`, and `BulkBar.tsx`. |
| U-09 | In `src/entrypoints/options/DecisionSettings.tsx:783-795, 1012-1015, 1232-1274`: fix `<Disclosure>` controlled state so the built-in blocklist does not snap shut on re-render, render feedback alerts near the acted-on card, query consent across all presets for card descriptions, handle `Enter` in `#blocklist-entry`, and update `"above"` copy to `"in Connections"`. Keep `BulkBar`'s job status strip mounted while `showAnalyzeCard` is true even when selection is empty (`BulkBar.tsx:273`). Render `job.error` and initial indeterminate progress in `RestructureView.tsx:616-637`. In `popup/App.tsx` and `popup/Suggestions.tsx`, show loading/empty/unconfigured feedback for `Suggest`, toggle search closed when clicking the Search button while `searchOpen === true`, and render `<ErrorAlert>` outside the unmounted `<form>`. |
| U-10 | Set `aria-hidden="true"` on `FaviconPlaceholder` (`src/ui/components/favicon.tsx:96-102`); set `tabIndex={active ? 0 : -1}` on inner row action/drag buttons in `BookmarkList.tsx`, `FolderTree.tsx`, and `ReviewView.tsx`; remove `tabIndex={0}` from static `<li>` rows in `RestructureView.tsx:314, 355`; fix `CommandPalette.tsx:182, 238` `aria-activedescendant` when empty, add `scrollIntoView` and hover highlight, add `Review`/`Restructure`/`Scan` to `palette.ts`, and add `"Command palette…"` to `TopBar` Tools menu; add `focus-visible:ring-2` to `#popup-title` in `PageCard.tsx:92`. |

## Non-Functional Requirements

- No new runtime npm dependencies or install-time manifest permissions.
- All Zod schemas continue importing from `src/schemas/z.ts` (MV3 CSP jitless mode).
- All outbound `fetch` calls remain strictly inside `src/net/**` behind the existing egress gates.
- Performance benchmarks in `tests/unit/decisions-perf.test.ts` and `tests/unit/search-perf.test.ts` use best-of-N minimum estimators (`conductor/workflow.md`).

## Acceptance Criteria

1. Every behavior task starts with a failing unit, component, or performance test and makes it pass with a minimal, clean fix.
2. Full local gate passes: `npm run lint` → `npm run typecheck` → `npx vitest run` → `npm run build` → `npm run check:manifest` → `npm run check:bundle` → `npm run check:store` → `npm run check:site` → `xvfb-run -a npm run test:e2e`.
3. Every completed task is committed locally with a `git notes add -m "..."` summary and its mapped Beads issue closed.

## Out of Scope

- v1.1 opt-in link checker (`is:dead` network probing).
- Unrelated P3 backlog items unless touched by the requirements above.
