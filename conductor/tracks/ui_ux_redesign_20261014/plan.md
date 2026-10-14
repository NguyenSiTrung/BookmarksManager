<!-- Last Revised: 2026-10-14 (Revision 1 — aligned Phase 4 Task 3 with P-10 lazy tag loading, DECISIONS_TRIGGERS, and popup search form invariants) -->
# UI/UX Refactor & Ergonomics Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `conductor` (`/conductor-implement`) to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Read `spec.md`, `learnings.md`, and the task's mapped Beads issue before claiming work.

**Goal:** Deliver all 13 UI/UX refactor and redesign requirements (`UX-01`–`UX-13`) across shared primitives, the Side Panel manager, Quick-Save Popup, Dialogs, and Options with failing-first tests, headless Chromium visual inspection, and full CI gate verification.

**Architecture:** Extract shared, accessible UI primitives (`TagField` with `TagDef` combobox autocomplete, `ConsentFacts` card disclosures) and enrich existing views (`BookmarkList`, `ScopePane`, `ScopeHeading`, `ViewChips`, `SearchBar`, `BulkBar`, `MoveToDialog`, `ReviewView`, `SummaryDialog`, `Popup`, `ProviderSetup`) without adding runtime npm dependencies or altering background worker trust boundaries. Keep all phases sequential and run tasks in parallel only where `<!-- files: ... -->` annotations are strictly disjoint and no `<!-- depends: ... -->` edge blocks them.

**Tech Stack:** WXT MV3, strict TypeScript 6, React 19, Tailwind CSS 4, Radix UI 1.6, Dexie 4, Vitest 5 / Testing Library, Playwright Chromium.

**Spec:** `conductor/tracks/ui_ux_redesign_20261014/spec.md`

## Global Constraints

- **Automated gates + visual inspection:** No manual blocking wait at phase boundaries or at track completion; automated task, phase, and final gates plus headless Chromium visual inspection (`view_media`) are mandatory.
- **Verify-first:** Every task starts with a failing unit or component test against current code.
- Phases are sequential. Within a phase, only tasks with disjoint `files` and satisfied `depends` run concurrently.
- Per task: failing test → minimal implementation → targeted green tests → applicable local gate slice (`lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle`) → update `plan.md` & `learnings.md` → local commit + `git notes add` → close mapped Bead.
- Never automatically run `git push`, `git pull`, `git fetch`, or `bd dolt push`.

---

## Phase 1: Shared Primitives — `TagField` Autocomplete & `MoveToDialog` Upgrade
<!-- execution: parallel -->

- [x] Task 1: Shared `TagField` with `TagDef` combobox autocomplete & colored chips (`UX-01`)
  <!-- files: src/ui/components/tag-field.tsx, src/entrypoints/popup/TagField.tsx, tests/components/tag-field.test.tsx -->
  - [x] Write failing component tests in `tests/components/tag-field.test.tsx` verifying: (1) typing in `TagField` with `availableTags` renders matching unselected tags (`data-testid="tag-field-suggestions"`) with color dots; (2) `ArrowDown`/`ArrowUp` and `Enter` or `MouseDown` accept a highlighted suggestion and clear input; (3) `Enter` or `,` with no highlighted suggestion commits the typed text; (4) `Escape` closes suggestions without losing input focus; and (5) staged chips render their `color` from `availableTags`.
  - [x] Implement `src/ui/components/tag-field.tsx` and re-export it from `src/entrypoints/popup/TagField.tsx`.

- [x] Task 2: `MoveToDialog` folder filter input & inline `+ New folder` creation (`UX-03`)
  <!-- files: src/entrypoints/sidepanel/MoveToDialog.tsx, tests/components/move-to-dialog.test.tsx -->
  - [x] Write failing component tests in `tests/components/move-to-dialog.test.tsx` verifying: (1) typing in `"Filter folders"` narrows destination folder buttons case-insensitively by label; (2) clicking `"+ New folder"` opens an inline folder name input, creates the folder under the selected parent (or `"Bookmarks bar"` default) via `createFolder`, selects the newly created folder as the destination, and enables immediate move.
  - [x] Implement folder filtering and inline subfolder creation in `src/entrypoints/sidepanel/MoveToDialog.tsx`.

- [x] Task 3: Wire `TagField` & tag autocomplete into `EditDialog` and `BulkBar` (`UX-02`)
  <!-- files: src/entrypoints/sidepanel/EditDialog.tsx, src/entrypoints/sidepanel/BulkBar.tsx, tests/components/sidepanel-actions.test.tsx -->
  <!-- depends: task1 -->
  - [x] Write failing component tests verifying: (1) `EditDialog` uses the unified `TagField` with `availableTags` autocomplete and `Backspace` removal while preserving `"Add tag"` button reachability; and (2) `BulkBar`'s `TagPromptDialog` offers clickable/keyboard-selectable tag suggestions from existing tags (prioritizing tags on selected bookmarks in `"remove"` mode).
  - [x] Update `src/entrypoints/sidepanel/EditDialog.tsx` and `src/entrypoints/sidepanel/BulkBar.tsx`.

- [x] Task: Conductor - User Manual Verification 'Phase 1: Shared Primitives — TagField Autocomplete & MoveToDialog Upgrade' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3 -->

---

## Phase 2: Side Panel Bookmark List Ergonomics & Scope Sidebar Richness
<!-- execution: parallel -->

- [x] Task 1: `BookmarkList` one-click open button, colored tag dots, note/summary indicators & folder path context (`UX-04`, `UX-05`)
  <!-- files: src/entrypoints/sidepanel/BookmarkList.tsx, src/entrypoints/sidepanel/row-text.ts, tests/components/sidepanel-rows.test.tsx -->
  - [x] Write failing component tests in `tests/components/sidepanel-rows.test.tsx` verifying: (1) list rows and grid cards render a one-click `Open <title>` button inside `[data-row-controls]` for openable URLs that triggers `onActivateItem` without altering selection, with roving `tabIndex={active ? 0 : -1}`; (2) `[data-tag]` chips render tag color dots when `tagColorByKey` / `tagDefs` provides a color; (3) rows/cards with `meta.notes` or `meta.summary` render `[data-has-notes="true"]` / `[data-has-summary="true"]` indicators; and (4) when `showFolderPath` is true, rows display the immediate parent folder title alongside the domain.
  - [x] Implement the row/card enhancements in `src/entrypoints/sidepanel/BookmarkList.tsx` and `src/entrypoints/sidepanel/row-text.ts`.

- [x] Task 2: `ScopePane` tag color dots & bookmark counts (`UX-06`)
  <!-- files: src/entrypoints/sidepanel/ScopePane.tsx, src/entrypoints/sidepanel/scope.ts, tests/components/sidepanel-scope-pane.test.tsx -->
  - [x] Write failing component tests in `tests/components/sidepanel-scope-pane.test.tsx` verifying: (1) `tagCounts(metas, tree)` computes live bookmark counts per tag `nameKey` (ignoring orphaned meta rows); and (2) `ScopePane` renders a color dot (`tag.color`) and the bookmark count badge on each tag row while preserving `aria-label={tag.name}` so `getByRole("button", { name: tag.name })` stays exact.
  - [x] Implement `tagCounts` in `src/entrypoints/sidepanel/scope.ts` and update `src/entrypoints/sidepanel/ScopePane.tsx`.

- [x] Task: Conductor - User Manual Verification 'Phase 2: Side Panel Bookmark List Ergonomics & Scope Sidebar Richness' (Protocol in workflow.md)
  <!-- depends: task1, task2 -->

---

## Phase 3: Side Panel Shell, Search Bar & Bulk Bar Streamlining
<!-- execution: parallel -->

- [x] Task 1: Narrow-mode `ScopeHeading` pill trigger & `ViewChips` dynamic `Review` promotion (`UX-07`)
  <!-- files: src/entrypoints/sidepanel/ScopeHeading.tsx, src/entrypoints/sidepanel/ViewChips.tsx, tests/components/sidepanel-scope-drawer.test.tsx, tests/components/sidepanel-chips.test.tsx -->
  - [x] Write failing component tests verifying: (1) `ScopeHeading` in narrow mode renders an icon-badged pill button (`data-testid="scope-drawer-trigger"`) while keeping `getByRole("button", { name: title })`; and (2) `ViewChips` promotes `Review suggestions` (with its `{pendingCount}` badge) to a top-level chip whenever `pendingCount > 0` (and when `activeKind === "review"`), while keeping `More` functional for all menu items.
  - [x] Update `src/entrypoints/sidepanel/ScopeHeading.tsx` and `src/entrypoints/sidepanel/ViewChips.tsx`.

- [x] Task 2: `QueryInput` search icon & clear button, `SearchBar` filter chips, and `TopBar` command-palette shortcut button (`UX-08`)
  <!-- files: src/ui/components/query-input.tsx, src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/TopBar.tsx, src/ui/components/icons.tsx, tests/components/query-input.test.tsx, tests/components/sidepanel-topbar.test.tsx, tests/components/sidepanel-search.test.tsx -->
  - [x] Write failing component tests verifying: (1) `QueryInput` renders a leading `SearchIcon` and a `"Clear search"` (`×`) button when `value !== ""` that clears the query and returns focus to the input; (2) `SearchBar` renders quick filter-prefix pills (`tag:`, `folder:`, `in:`, `has:`) when focused on an empty query that insert the filter token; and (3) `TopBar` renders a direct `"Command palette"` button (`Ctrl+K` / `⌘K`) alongside `Tools` and `Settings`.
  - [x] Implement the upgrades in `src/ui/components/query-input.tsx`, `src/entrypoints/sidepanel/SearchBar.tsx`, `src/entrypoints/sidepanel/TopBar.tsx`, and `src/ui/components/icons.tsx`.

- [x] Task 3: Wire `App.tsx` props (`tagCounts`, `tagColorByKey`, `showFolderPath`, `tagDefs`) & compact `BulkBar` / `UndoToast` layout (`UX-05`, `UX-06`, `UX-09`)
  <!-- files: src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/BulkBar.tsx, src/entrypoints/sidepanel/UndoToast.tsx, tests/components/sidepanel-shell.test.tsx -->
  <!-- depends: task1, task2 -->
  - [x] Write failing component tests in `tests/components/sidepanel-shell.test.tsx` verifying `App` passes `tagCounts`, `tagColorByKey`, `tagDefs`, and `showFolderPath` (`activeView.kind !== "folder"`) to `ScopePane`, `BookmarkList`, and `EditDialog`, and `TopBar`'s `"Command palette"` button opens the command palette.
  - [x] Update `src/entrypoints/sidepanel/App.tsx`, `src/entrypoints/sidepanel/BulkBar.tsx`, and `src/entrypoints/sidepanel/UndoToast.tsx`.

- [x] Task: Conductor - User Manual Verification 'Phase 3: Side Panel Shell, Search Bar & Bulk Bar Streamlining' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3 -->

---

## Phase 4: AI Workflows, Dialogs, Popup & Options Cohesion
<!-- execution: parallel -->

- [x] Task 1: `SummaryDialog` `ConsentFacts` card formatting, model badge & `"Copy summary"` (`UX-10`)
  <!-- files: src/entrypoints/sidepanel/SummaryDialog.tsx, tests/components/summary-dialog.test.tsx -->
  - [x] Write failing component tests in `tests/components/summary-dialog.test.tsx` verifying: (1) the `disclosure` phase renders structured `Recipient` / `Sent` / `Never sent` / `Why` / `When` facts for both hops with grant badges; and (2) the `saved` and `done` phases offer a `"Copy summary"` button that writes the summary text to `navigator.clipboard.writeText`.
  - [x] Update `src/entrypoints/sidepanel/SummaryDialog.tsx`.

- [x] Task 2: `ReviewView` primary `Approve` styling & collapsible `Applied history` with `Undo` (`UX-11`, `BookmarksManager-tax`)
  <!-- files: src/decisions/store.ts, src/entrypoints/sidepanel/ReviewView.tsx, src/entrypoints/sidepanel/App.tsx, tests/unit/decisions-store.test.ts, tests/components/review-view.test.tsx -->
  - [x] Write failing unit and component tests verifying: (1) `listApplied()` in `src/decisions/store.ts` returns recent `applied` decision rows ordered newest-first; (2) `ReviewView` renders both manually `applied` and `auto_applied` rows inside the applied-history section (`aria-label="Auto-applied suggestions"` / collapsible history) with a working `Undo` (`REVERT_DECISION`) button; and (3) per-row `Approve` buttons carry primary accent classes.
  - [x] Implement `listApplied()` in `src/decisions/store.ts` and update `src/entrypoints/sidepanel/ReviewView.tsx` and `src/entrypoints/sidepanel/App.tsx`.

- [~] Task 3: Quick-Save Popup search-open transition, `TagField` autocomplete & consent-aware suggest (`UX-02`, `UX-12`)
  <!-- files: src/entrypoints/popup/App.tsx, src/entrypoints/popup/Search.tsx, tests/components/popup-save.test.tsx, tests/components/popup-search.test.tsx, tests/components/popup-suggestions.test.tsx -->
  - [ ] Write failing component tests verifying: (1) opening popup search (`searchOpen === true`) displays quick filter-prefix pills (`tag:`, `folder:`, `in:`, `has:`, `data-testid="popup-search-hint"`) in `PopupSearch` when `query === ""` that insert the filter token on click; and (2) focusing `TagField` in `popup/App.tsx` lazily loads `tagDefs` (preserving `P-10` on mount) and passes them as `availableTags` to `TagField` for combobox autocomplete while preserving zero egress on popup open.
  - [ ] Update `src/entrypoints/popup/App.tsx` and `src/entrypoints/popup/Search.tsx`.

- [ ] Task 4: Options `ProviderSetup` inline analysis-consent status & jump to `Permissions` (`UX-13`)
  <!-- files: src/entrypoints/options/ProviderSetup.tsx, src/entrypoints/options/OptionsApp.tsx, tests/components/provider-setup.test.tsx, tests/components/options-app.test.tsx -->
  - [ ] Write failing component tests verifying: (1) when a Jev provider is enabled in `ProviderSetup`, it displays whether `Bookmark analysis consent` (`jev_decisions`) is granted at that provider's origin; and (2) when not yet granted, it renders a `"Review analysis consent in Permissions"` action button that switches `OptionsApp` to the `Permissions` panel.
  - [ ] Update `src/entrypoints/options/ProviderSetup.tsx` and `src/entrypoints/options/OptionsApp.tsx`.

- [ ] Task: Conductor - User Manual Verification 'Phase 4: AI Workflows, Dialogs, Popup & Options Cohesion' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3, task4 -->

---

## Phase 5: Visual Inspection, End-to-End Verification & Documentation Sync
<!-- execution: sequential -->

- [ ] Task 1: Headless Chromium visual verification, E2E regressions, full CI gate & docs sync
  <!-- files: tests/e2e/dialog-visuals.spec.ts, conductor/product.md, conductor/tech-stack.md, conductor/patterns.md -->
  - [ ] Run Playwright visual captures (`tests/e2e/dialog-visuals.spec.ts` and targeted narrow/wide sidepanel, popup, and options screenshots), inspect every rendered state with `view_media`, and fix any visual or layout defects.
  - [ ] Run the full local gate (`npm run lint` → `npm run typecheck` → `npx vitest run` → `npm run build` → `npm run check:manifest` → `npm run check:bundle` → `npm run check:store` → `npm run check:site` → `xvfb-run -a npm run test:e2e`), close `BookmarksManager-tax`, and synchronize `conductor/{product,tech-stack,patterns}.md`.

- [ ] Task: Conductor - User Manual Verification 'Phase 5: Visual Inspection, End-to-End Verification & Documentation Sync' (Protocol in workflow.md)
  <!-- depends: task1 -->
