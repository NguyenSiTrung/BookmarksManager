# Phase 1 Core Manager — Implementation Plan

**Goal:** Ship the offline core manager from `PROJECT_PLAN.md` §15 Phase 1: native-tree sync, side panel, quick save, tags and categories, drag and drop, import/export, local duplicates with merge and undo, `_favicon` icons, and "Delete all extension data".

**Spec:** `conductor/tracks/phase1_core_manager_20260926/spec.md`; product constraints also live in `PROJECT_PLAN.md` §§5.1, 6, 7, 12, 13.3, and 15.

**Tech Stack:** WXT, React 19, Tailwind 4, strict TypeScript, Zod 4 (jitless), Dexie 4 + `dexie-react-hooks`, shadcn/ui components on `radix-ui`, `@dnd-kit/core` + `@dnd-kit/sortable` 6.x, `@tanstack/react-virtual`, Vitest, Testing Library, Playwright.

## Global Constraints

- Every Phase 1 feature makes zero network requests. `CONSENT_VERSION` does not change.
- Add each permission only in the task that ships its feature, updating `wxt.config.ts` and `store/permissions.md` in the same commit: `bookmarks` → P1.T6, `favicon` → P4.T1, `activeTab` → P5.T1, `contextMenus` → P5.T3. Never add `scripting`, `tabs`, `downloads`, or `notifications` in this track.
- Access `chrome.*` through typed `declare const chrome` slices. Unit tests use the in-memory bookmarks fake from P1.T1.
- Import `z` only from `src/schemas/z.ts`. Message handlers are total (`{ok:true,…} | {ok:false,code,message}`).
- Parse imported files with `DOMParser` / Zod only; never assign untrusted HTML to `innerHTML`.
- Per task: observe a failing test → implement → run narrow checks → update this plan and `learnings.md` → commit only intended files locally → `git notes add -m "…"` → close the mapped Beads task. Never push, pull, fetch, or `bd dolt push`.
- Phase-end tasks are **automated checkpoints**: run the full gate (`lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle` → `E2E_HEADLESS=1 npm run test:e2e` or `xvfb-run -a npm run test:e2e`), record evidence in `learnings.md`, and mark complete on green. The only user-verification gate is the last task of the track.
- Parallel execution: each worker owns only its annotated files in an isolated worktree. The coordinator serializes edits to shared files (`package.json`, `package-lock.json`, `wxt.config.ts`, `store/permissions.md`, `src/entrypoints/background.ts`, `src/entrypoints/sidepanel/App.tsx`), `plan.md`, `learnings.md`, Beads status, and commits/notes.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Chrome API slice + fake | `src/sync/chrome-bookmarks.ts`, `tests/fakes/chrome-bookmarks.ts` | Typed bookmarks API surface; in-memory tree with events for tests |
| Schemas | `src/schemas/{meta,undo,export}.ts`, `tests/fixtures/{meta,undo,export}.ts` | BookmarkMeta, TagDef, UndoSnapshot, ExportEnvelope v1 |
| Storage | `src/db/database.ts` (v2), `src/db/meta.ts` | Dexie tables and metadata repository |
| Sync / read model | `src/sync/{listeners,reconcile,tree,mutations,tag-ops}.ts`, `src/ui/hooks/useBookmarkTree.ts` | Worker listeners, startup reconcile, view model, guarded mutations |
| Duplicates / undo | `src/duplicates/{normalize,group,merge}.ts`, `src/undo/{snapshot,restore}.ts` | URL normalization, grouping, merge; LIFO undo |
| Import / export | `src/io/{export-json,netscape,csv,import-plan,import-write}.ts` | File formats, preview planner, writer |
| UI | `src/ui/components/*`, `src/entrypoints/{sidepanel,popup,options}/*` | Side panel, popup save, delete-all |
| Worker | `src/entrypoints/background.ts`, `src/sync/context-menu.ts` | Listener registration, context-menu save |
| Store docs | `store/{permissions,privacy-policy,privacy-practices,listing,reviewer-notes}.md` | Disclosures matching shipped behavior |

---

## Phase 1: Data foundations and sync
<!-- execution: parallel -->
<!-- depends: -->

- [ ] Task 1: Typed `chrome.bookmarks` slice and in-memory fake
  <!-- files: src/sync/chrome-bookmarks.ts, tests/fakes/chrome-bookmarks.ts, tests/unit/chrome-bookmarks-fake.test.ts -->
  - [ ] Write failing tests for the fake: getTree/getSubTree/get, create/update/move/remove/removeTree, index semantics, event emission (`onCreated`, `onChanged`, `onMoved`, `onChildrenReordered`, `onRemoved` with removed `node` incl. children), fixed roots `0/1/2/3`, a managed `unmodifiable` subtree that rejects writes
  - [ ] Implement the typed slice (`declare const chrome` pattern) and the fake

- [ ] Task 2: Schemas — BookmarkMeta, TagDef, UndoSnapshot, ExportEnvelope v1
  <!-- files: src/schemas/meta.ts, src/schemas/undo.ts, src/schemas/export.ts, tests/fixtures/meta.ts, tests/fixtures/undo.ts, tests/fixtures/export.ts, tests/unit/schemas-phase1.test.ts -->
  - [ ] Valid and invalid fixtures (`satisfies z.input<…>`): tag name 1–64 and case-insensitive `nameKey`, description ≤300, notes ≤10,000, Category enum, snapshot node shapes, envelope `version: 1` with no secret-bearing fields allowed (strict objects)
  - [ ] Implement schemas importing `z` from `src/schemas/z.ts`

- [ ] Task 3: Dexie v2 tables and migration
  <!-- files: src/db/database.ts, tests/unit/database-v2.test.ts -->
  <!-- depends: task2 -->
  - [ ] Failing test with fake-indexeddb: open a v1 database with Phase 0 rows, upgrade to v2, assert rows preserved and new tables `bookmarkMeta` (`id,*tags,category,updatedAt`), `tags` (`nameKey`), `undo` (`++id,createdAt`) exist
  - [ ] Implement `version(2).stores(...)`

- [ ] Task 4: URL normalization and duplicate grouping
  <!-- files: src/duplicates/normalize.ts, src/duplicates/group.ts, tests/unit/duplicates-normalize.test.ts, tests/unit/duplicates-group.test.ts -->
  - [ ] Table-driven failing tests: scheme/host case, default ports, fragment, `www.`, http≡https, trailing slash, query sort, tracking params (`utm_*`, `fbclid`, `gclid`, `mc_eid`), non-HTTP URLs left exact-only, invalid URLs
  - [ ] Grouping tests: "exact" vs "normalized" labels, singletons excluded, stable ordering
  - [ ] Implement pure functions (no DOM, no chrome)

- [ ] Task 5: Metadata repository
  <!-- files: src/db/meta.ts, tests/unit/meta-repo.test.ts -->
  <!-- depends: task3 -->
  - [ ] Failing tests: lazy rows (empty meta ⇒ row deleted), get/put/patch, bulk delete by IDs, tag definition CRUD with case-insensitive uniqueness, tag rename/delete propagating through the `*tags` index, fresh-object writes (Dexie key write-back gotcha)
  - [ ] Implement with Zod validation on read

- [ ] Task 6: Worker sync — cascade delete, startup reconcile, change broadcast; add `bookmarks` permission
  <!-- files: src/sync/listeners.ts, src/sync/reconcile.ts, src/entrypoints/background.ts, wxt.config.ts, store/permissions.md, tests/unit/sync-listeners.test.ts, tests/unit/sync-reconcile.test.ts -->
  <!-- depends: task1, task5 -->
  - [ ] Failing tests against the fake: `onRemoved` deletes metadata for the node and every descendant in `removeInfo.node`; reconcile deletes rows whose IDs are absent; listeners never touch the network
  - [ ] Register listeners at worker startup; broadcast a typed `bookmarks-changed` message
  - [ ] Add `bookmarks` to `wxt.config.ts` and a justified row to `store/permissions.md`; `check:manifest` green

- [ ] Task 7: Tree read model and live hook
  <!-- files: src/sync/tree.ts, src/ui/hooks/useBookmarkTree.ts, tests/unit/sync-tree.test.ts, tests/components/useBookmarkTree.test.tsx -->
  <!-- depends: task1 -->
  - [ ] Failing tests: flatten to folders/bookmarks maps, folder paths, `isRoot`/`isManaged` flags, children order; hook re-renders on fake events and unsubscribes on unmount
  - [ ] Implement

- [ ] Task 8: Checkpoint — automated gate for Phase 1 (evidence in `learnings.md`)
  <!-- depends: task1, task2, task3, task4, task5, task6, task7 -->

---

## Phase 2: Mutations, undo, merge, tag operations
<!-- execution: parallel -->
<!-- depends: phase1 -->

- [ ] Task 1: Guarded mutation service
  <!-- files: src/sync/mutations.ts, tests/unit/sync-mutations.test.ts -->
  - [ ] Failing tests: create bookmark/folder, update title/URL, move/reorder, remove/removeTree; reject root and managed nodes with typed errors; metadata written alongside where given
  - [ ] Implement over the typed slice

- [ ] Task 2: Undo stack
  <!-- files: src/undo/snapshot.ts, src/undo/restore.ts, tests/unit/undo.test.ts -->
  <!-- depends: task1 -->
  - [ ] Failing tests: snapshot before delete / bulk move / tag delete; LIFO restore re-creates nodes at original parent+index with ID remap for metadata; cap at 20 (oldest dropped); missing parent ⇒ restore into Other bookmarks with a reported fallback
  - [ ] Implement using the `undo` table

- [ ] Task 3: Duplicate merge
  <!-- files: src/duplicates/merge.ts, tests/unit/duplicates-merge.test.ts -->
  <!-- depends: task2 -->
  - [ ] Failing tests: tag union, notes joined with a separator, category rule (kept, else first found), others deleted, undo restores all
  - [ ] Implement

- [ ] Task 4: Bulk tag and category operations
  <!-- files: src/sync/tag-ops.ts, tests/unit/tag-ops.test.ts -->
  <!-- depends: task2 -->
  - [ ] Failing tests: bulk add/remove tag, set/clear category, tag rename/recolor/delete with affected counts, tag delete undoable
  - [ ] Implement

- [ ] Task 5: Checkpoint — automated gate for Phase 2 (evidence in `learnings.md`)
  <!-- depends: task1, task2, task3, task4 -->

---

## Phase 3: Import and export
<!-- execution: parallel -->
<!-- depends: phase1 -->

- [ ] Task 1: JSON export/import envelope
  <!-- files: src/io/export-json.ts, tests/unit/io-json.test.ts -->
  - [ ] Failing tests: whole-library and single-folder export; round trip restores tree, tags, categories, notes, tag definitions; seeded keys, key material, consents, provider settings, sentLog, and decisions are absent from output; invalid envelopes rejected
  - [ ] Implement

- [ ] Task 2: Netscape HTML export and import parser
  <!-- files: src/io/netscape.ts, tests/unit/io-netscape.test.ts, tests/fixtures/netscape/*.html -->
  - [ ] Failing tests with Chrome/Firefox export fixtures: nested folders, `ADD_DATE`, `TAGS`, HTML entities, `javascript:`/`data:` skipped, malformed markup, size cap; export escapes titles/URLs
  - [ ] Implement with `DOMParser` (no `innerHTML`)

- [ ] Task 3: CSV export and import
  <!-- files: src/io/csv.ts, tests/unit/io-csv.test.ts -->
  - [ ] Failing tests: RFC 4180 quoting, embedded newlines/quotes, formula-injection escaping for `= + - @`, tab, CR, tag/category columns, header validation, invalid rows counted
  - [ ] Implement

- [ ] Task 4: Import planner and writer
  <!-- files: src/io/import-plan.ts, src/io/import-write.ts, tests/unit/io-import.test.ts -->
  <!-- depends: task1, task2, task3 -->
  - [ ] Failing tests: preview counts (folders, bookmarks, duplicates, invalid) without writes; duplicate skip by normalized URL with override; writes into "Imported <YYYY-MM-DD HH:mm>" under Other bookmarks preserving structure; metadata restore for JSON/CSV; summary; undo removes the import folder
  - [ ] Implement

- [ ] Task 5: Checkpoint — automated gate for Phase 3 (evidence in `learnings.md`)
  <!-- depends: task1, task2, task3, task4 -->

---

## Phase 4: Side panel UI
<!-- execution: parallel -->
<!-- depends: phase2, phase3 -->

- [ ] Task 1: UI dependencies, shadcn/ui primitives, favicon component; add `favicon` permission
  <!-- files: package.json, package-lock.json, src/ui/components/dialog.tsx, src/ui/components/dropdown-menu.tsx, src/ui/components/popover.tsx, src/ui/components/checkbox.tsx, src/ui/components/favicon.tsx, src/ui/lib/cn.ts, wxt.config.ts, store/permissions.md, tests/components/favicon.test.tsx -->
  - [ ] Install `radix-ui`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@tanstack/react-virtual`, `dexie-react-hooks` (verify current versions and React 19 peers at install)
  - [ ] Copy only Dialog, DropdownMenu, Popover, Checkbox from shadcn/ui; `check:bundle` stays green
  - [ ] Failing test: Favicon renders `chrome-extension://<id>/_favicon/?pageUrl=…&size=…` and a placeholder on error
  - [ ] Add `favicon` to `wxt.config.ts` and `store/permissions.md`

- [ ] Task 2: Layout — folder tree, virtualized list/grid, views
  <!-- files: src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/FolderTree.tsx, src/entrypoints/sidepanel/BookmarkList.tsx, src/entrypoints/sidepanel/views.ts, tests/components/sidepanel-layout.test.tsx -->
  <!-- depends: task1 -->
  - [ ] Failing tests: ARIA tree keyboard navigation (arrows, Home/End, expand/collapse), list/grid toggle, virtualization with 10k items, views All / folder / tag / category / Untagged / Duplicates / Recently saved
  - [ ] Implement

- [ ] Task 3: Item and folder actions
  <!-- files: src/entrypoints/sidepanel/EditDialog.tsx, src/entrypoints/sidepanel/BulkBar.tsx, src/entrypoints/sidepanel/MoveToDialog.tsx, src/entrypoints/sidepanel/FolderActions.tsx, src/entrypoints/sidepanel/UndoToast.tsx, tests/components/sidepanel-actions.test.tsx -->
  <!-- depends: task2 -->
  - [ ] Failing tests: edit title/URL/folder/tags/category/notes; multi-select + bulk move/delete/tag/category; Move to…; folder create/rename/delete with count; undo toast; disabled actions on root/managed nodes
  - [ ] Implement

- [ ] Task 4: Drag and drop
  <!-- files: src/entrypoints/sidepanel/dnd.tsx, src/entrypoints/sidepanel/FolderTree.tsx, src/entrypoints/sidepanel/BookmarkList.tsx, tests/components/sidepanel-dnd.test.tsx -->
  <!-- depends: task3 -->
  - [ ] Failing tests: keyboard-sensor drag moves and reorders bookmarks and folders, multi-select drag, drops onto root/managed nodes or into own descendants rejected, bulk move undoable
  - [ ] Implement with dnd-kit

- [ ] Task 5: Tag manager and category UI
  <!-- files: src/entrypoints/sidepanel/TagManager.tsx, src/ui/components/tag-chip.tsx, src/ui/components/category-select.tsx, tests/components/tag-manager.test.tsx -->
  <!-- depends: task2 -->
  - [ ] Failing tests: create/rename/recolor/delete with counts, description length limit, chips on items, category select
  - [ ] Implement

- [ ] Task 6: Duplicates view with merge
  <!-- files: src/entrypoints/sidepanel/DuplicatesView.tsx, tests/components/duplicates-view.test.tsx -->
  <!-- depends: task2 -->
  - [ ] Failing tests: groups with exact/normalized labels, badges, "Keep this one" merge, undo
  - [ ] Implement

- [ ] Task 7: Import/export UI
  <!-- files: src/entrypoints/sidepanel/ImportDialog.tsx, src/entrypoints/sidepanel/ExportDialog.tsx, tests/components/import-export.test.tsx -->
  <!-- depends: task2 -->
  - [ ] Failing tests: file picker, preview counts, "Import duplicates anyway", Confirm writes, summary with "Delete import folder", export chooser (format + scope) downloads via Blob + anchor (no `downloads` permission)
  - [ ] Implement

- [ ] Task 8: Checkpoint — automated gate for Phase 4 (evidence in `learnings.md`)
  <!-- depends: task1, task2, task3, task4, task5, task6, task7 -->

---

## Phase 5: Quick save, delete-all, store readiness
<!-- execution: parallel -->
<!-- depends: phase4 -->

- [ ] Task 1: Popup quick save; add `activeTab` permission
  <!-- files: src/entrypoints/popup/*, src/sync/last-folder.ts, wxt.config.ts, store/permissions.md, tests/components/popup-save.test.tsx -->
  - [ ] Failing tests: prefilled title/URL from the active tab, last-used folder default, tags/category/notes, "Already saved in <folder>" with edit, "Open manager" opens the side panel, render budget under 150 ms
  - [ ] Implement; add `activeTab` to `wxt.config.ts` and `store/permissions.md`

- [ ] Task 2: Keyboard shortcut
  <!-- files: wxt.config.ts, tests/unit/manifest-commands.test.ts -->
  <!-- depends: task1 -->
  - [ ] Failing test: built manifest has `commands._execute_action` with a suggested key that avoids Chrome defaults
  - [ ] Implement

- [ ] Task 3: Context menu save; add `contextMenus` permission
  <!-- files: src/sync/context-menu.ts, src/entrypoints/background.ts, wxt.config.ts, store/permissions.md, tests/unit/context-menu.test.ts -->
  <!-- depends: task2 -->
  - [ ] Failing tests: "Save page" / "Save link" items registered on install, click saves into the last-used folder, badge confirmation clears, incognito tabs handled, no network
  - [ ] Implement; add `contextMenus` to `wxt.config.ts` and `store/permissions.md`

- [ ] Task 4: Delete all extension data
  <!-- files: src/security/delete-all.ts, src/entrypoints/options/DeleteAllData.tsx, tests/unit/delete-all.test.ts, tests/components/delete-all.test.tsx -->
  - [ ] Failing tests: confirm dialog copy lists what is deleted and says native bookmarks are untouched; deletes the Dexie database, clears `chrome.storage.local`, removes granted optional host permissions; native bookmark fake unchanged; UI returns to first-run state
  - [ ] Implement

- [ ] Task 5: Store docs and PROJECT_PLAN status
  <!-- files: store/privacy-policy.md, store/privacy-practices.md, store/listing.md, store/reviewer-notes.md, PROJECT_PLAN.md -->
  <!-- depends: task1, task2, task3, task4 -->
  - [ ] Describe only shipped local behavior (tags, notes, categories, undo snapshots, local file import/export, `_favicon`); reviewer notes explain testing without a key
  - [ ] Update `PROJECT_PLAN.md` §1.1 and §15 Phase 1 status; confirm `check:manifest` and doc/permission grep consistency

- [ ] Task 6: End-to-end specs
  <!-- files: tests/e2e/core-manager.spec.ts, tests/e2e/helpers/*.ts -->
  <!-- depends: task1, task2, task3, task4 -->
  - [ ] Side panel shows worker-created bookmarks and updates live on external changes; move via drag/"Move to…"; import → export round trip; delete-all leaves bookmarks intact; zero `^https?://` requests after `context.close()` with all features exercised; 10k-seed render
  - [ ] Implement

- [ ] Task 7: Checkpoint — automated gate for Phase 5 (evidence in `learnings.md`)
  <!-- depends: task1, task2, task3, task4, task5, task6 -->

- [ ] Task 8: Conductor - User Manual Verification 'Phase 1 Core Manager' (Protocol in workflow.md) — the only manual verification, at the end of the track
  <!-- depends: task7 -->
