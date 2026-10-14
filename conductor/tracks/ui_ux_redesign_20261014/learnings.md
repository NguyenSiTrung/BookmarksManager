# Track Learnings: ui_ux_redesign_20261014

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

- **Strict TypeScript:** `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; all Zod schemas import `z` from `src/schemas/z.ts`.
- **Zero-egress invariant:** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, and `importScripts` are banned outside `src/net/**`. Any auto-triggered UI helper (such as popup `SAVE_SUGGEST`) must check local `db.consents` first and never emit network traffic when unconsented.
- **ARIA & selector preservation:** Existing component and e2e suites query by role and accessible name (`"Tools"`, `"Settings"`, `"All"`, `"Recent"`, `"Untagged"`, `"More"`, `"Browse"`, `"Search bookmarks"`, `treeitem`, `option`). Keep accessible names and `data-*` hooks (`data-tag`, `data-tag-more`, `data-category`, `data-row-controls`, `data-dnd-drag`, `data-decision-id`) intact when enhancing markup.
- **Roving `tabIndex` in lists/trees:** Any interactive button added inside a `BookmarkList` row (`[data-row-controls]`), `FolderTree` row, or `ReviewView` row must receive `tabIndex={active ? 0 : -1}` and stop click/keydown propagation so it does not hijack row selection or roving focus.
- **RTL/Vitest conventions (`globals: false`):** Set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually in `afterEach`.

---

<!-- Learnings from implementation will be appended below -->

## [2026-10-14 08:06] - Phase 1 Task 1: Shared `TagField` with `TagDef` combobox autocomplete & colored chips (`UX-01`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Extracted `TagField` into `src/ui/components/tag-field.tsx` (with compatibility re-export from `src/entrypoints/popup/TagField.tsx`), adding optional `availableTags?: readonly TagDef[]` combobox autocomplete (`data-testid="tag-field-suggestions"`), keyboard navigation (`ArrowDown`/`ArrowUp`/`Enter`/`Escape`), `MouseDown` acceptance, and chip color resolution from `availableTags`.
- **Files changed:** `src/ui/components/tag-field.tsx`, `src/entrypoints/popup/TagField.tsx`, `tests/components/tag-field.test.tsx`
- **Learnings:**
  - Patterns: Gating suggestion popup visibility on `(input.trim() !== "" || arrowOpened)` prevents a bare focus on an empty `TagField` from emitting `role="option"` elements that could collide with outer listboxes or popup suggestion tests, while still opening on typing or `ArrowDown`.
  - Gotchas: Wrapping `onCommit()` in an arrow callback on the inline Add button prevents React's `MouseEvent` from being passed as the optional `label?: string` parameter.
---

## [2026-10-14 08:10] - Phase 1 Task 2: `MoveToDialog` folder filter input & inline `+ New folder` creation (`UX-03`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Added case-insensitive destination filtering (`aria-label="Filter folders"`) and inline subfolder creation (`"+ New folder"` → `createFolder` under the selected destination or `"Bookmarks bar"` default) to `MoveToDialog.tsx`, immediately selecting the newly created folder for one-flow moves.
- **Files changed:** `src/entrypoints/sidepanel/MoveToDialog.tsx`, `tests/components/move-to-dialog.test.tsx`
- **Learnings:**
  - Patterns: Recording optimistically created folders in local `createdFolders` state deduplicated against `folderDestinations(tree)` lets `MoveToDialog` immediately render and select the new destination even before the parent's coalesced `tree` prop refreshes (or in standalone component tests with a static `tree`).
  - Gotchas: Avoid naming any inline close button `"Cancel"` inside a dialog that already has a footer `"Cancel"` button so `within(dialog).getByRole("button", { name: "Cancel" })` stays unambiguous.
---

## [2026-10-14 08:14] - Phase 1 Task 3: Wire `TagField` & tag autocomplete into `EditDialog` and `BulkBar` (`UX-02`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Replaced the separate tag chip list + input in `EditDialog.tsx` with the shared `TagField` (with live `listTags()` fallback when `tagDefs` prop is omitted), and added `data-testid="tag-prompt-suggestions"` existing-tag autocomplete to `BulkBar.tsx`'s `TagPromptDialog` (filtering to tags on the selected bookmarks in `"remove"` mode).
- **Files changed:** `src/entrypoints/sidepanel/EditDialog.tsx`, `src/entrypoints/sidepanel/BulkBar.tsx`, `tests/components/sidepanel-actions.test.tsx`
- **Learnings:**
  - Patterns: In `TagPromptDialog`, pressing `Enter` while a suggestion is highlighted (`clampedIndex >= 0` and `name !== suggestion.name`) fills the input first and clears the highlight so a subsequent `Enter` or button click submits.
  - Gotchas: `createTag(name, options)` takes `{ color }` in an options object rather than a positional color string.
---

## [2026-10-14 08:19] - Phase 2 Task 1: `BookmarkList` one-click open button, colored tag dots, note/summary indicators & folder path context (`UX-04`, `UX-05`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Added one-click `Open <title>` button inside `[data-row-controls]` for openable URLs (`isOpenableUrl`), `[data-tag-dot]` colored dots on row/card tag chips, `[data-has-notes]` and `[data-has-summary]` SVG indicators, `immediateFolder` context (`domain · Folder` when `showFolderPath` is true), and responsive List/Grid toggle labels (`aria-label="List view"` / `"Grid view"`).
- **Files changed:** `src/entrypoints/sidepanel/BookmarkList.tsx`, `src/entrypoints/sidepanel/row-text.ts`, `tests/components/sidepanel-rows.test.tsx`
- **Learnings:**
  - Patterns: Rendering `[data-row-controls]` whenever `openable || actions !== undefined` ensures standalone `<BookmarkList>` instances still render the one-click `Open <title>` button and stop click/keydown propagation from selecting the row.
  - Gotchas: Using SVG icons inside `[data-has-notes]` / `[data-has-summary]` and empty `<span data-tag-dot>` elements preserves existing `row.textContent` assertions.
---

## [2026-10-14 08:21] - Phase 2 Task 2: `ScopePane` tag color dots & bookmark counts (`UX-06`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Added `tagCounts(metas, tree)` in `src/entrypoints/sidepanel/scope.ts` (filtering out orphaned meta rows) and rendered each tag's color dot (`[data-tag-dot]`) and trailing bookmark count (`[data-tag-count]`) in `ScopePane.tsx` while keeping `aria-label={tag.name}` on the tag button.
- **Files changed:** `src/entrypoints/sidepanel/scope.ts`, `src/entrypoints/sidepanel/ScopePane.tsx`, `tests/components/sidepanel-scope-pane.test.tsx`
- **Learnings:**
  - Patterns: Setting `aria-label={tag.name}` on the `ScopePane` tag button preserves exact `getByRole("button", { name: tag.name })` queries when trailing count badges are added inside the button.
---

## [2026-10-14 08:26] - Phase 3 Task 1: Narrow-mode `ScopeHeading` pill trigger & `ViewChips` dynamic `Review` promotion (`UX-07`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Styled `ScopeHeading`'s narrow-mode drawer trigger as an icon-badged pill button (`data-testid="scope-drawer-trigger"`, leading `FolderIcon` + trailing `ChevronDownIcon`), and promoted `Review suggestions` to a top-level chip in `ViewChips` whenever `pendingCount > 0 || activeKind === "review"` while keeping `More` labelled `"More"` when `activeKind === "review"` so `openMoreView` and existing menu flows remain intact.
- **Files changed:** `src/entrypoints/sidepanel/ScopeHeading.tsx`, `src/entrypoints/sidepanel/ViewChips.tsx`, `tests/components/sidepanel-scope-drawer.test.tsx`, `tests/components/sidepanel-chips.test.tsx`
- **Learnings:**
  - Gotchas: When `Review suggestions` is promoted to a top-level chip, excluding `review` from `activeMore` on the `More` trigger prevents duplicate buttons named `"Review suggestions"` when `activeKind === "review"` and keeps `getByRole("button", { name: /^More/ })` stable for E2E `openMoreView` helpers.
---

## [2026-10-14 08:30] - Phase 3 Task 2: `QueryInput` search icon & clear button, `SearchBar` filter chips, and `TopBar` command-palette shortcut button (`UX-08`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Added leading `SearchIcon` and trailing `"Clear search"` (`×`) button to `QueryInput`, added quick filter-prefix pills (`tag:`, `folder:`, `in:`, `has:`) on focus to `SearchBar`, and added a direct `"Command palette"` (`⌘K`) button and menu shortcut badge to `TopBar`.
- **Files changed:** `src/ui/components/query-input.tsx`, `src/entrypoints/sidepanel/SearchBar.tsx`, `src/entrypoints/sidepanel/TopBar.tsx`, `tests/components/query-input.test.tsx`, `tests/components/sidepanel-topbar.test.tsx`, `tests/components/sidepanel-search.test.tsx`
- **Learnings:**
  - Gotchas: When a side-panel search has 0 results (`resultCount === 0`), the empty state already renders a `"Clear search"` CTA button (`sidepanel-empty.test.tsx`). Passing `hideClearButton={resultCount === 0}` from `SearchBar` to `QueryInput` avoids duplicate buttons with `name: "Clear search"` when 0 results are shown.
---

## [2026-10-14 08:33] - Phase 3 Task 3: Wire `App.tsx` props (`tagCounts`, `tagColorByKey`, `showFolderPath`, `tagDefs`) & compact `BulkBar` / `UndoToast` layout (`UX-05`, `UX-06`, `UX-09`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Wired `tagCounts`, `tagColorByKey`, `tagDefs`, and `showFolderPath={activeView.kind !== "folder"}` in `src/entrypoints/sidepanel/App.tsx`, compacted `BulkBar`'s `{count} selected` pill with an inline `Clear selection` (`×`) button, and added `max-sm:bottom-20` offset to `UndoToast` when `offsetForBulkBar` is active.
- **Files changed:** `src/entrypoints/sidepanel/App.tsx`, `src/entrypoints/sidepanel/BulkBar.tsx`, `src/entrypoints/sidepanel/UndoToast.tsx`, `tests/components/sidepanel-shell.test.tsx`
- **Learnings:**
  - Patterns: Embedding `<button aria-label="Clear selection">×</button>` inside the `{count} selected` pill keeps `getByRole("button", { name: "Clear selection" })` working while saving horizontal toolbar width on 320px narrow panels.
---

## [2026-10-14 08:36] - Phase 4 Task 1: `SummaryDialog` `ConsentFacts` card formatting, model badge & `"Copy summary"` (`UX-10`)
Thread: T-01a1396b-6a35-77a4-90ea-865a78dc5383
- **Implemented:** Refactored `SummaryDialog.tsx`'s `disclosure` phase to render each hop (`llm_summary` and `jev_summary_verify`) inside a styled card using `ConsentFacts` with grant status badges, and added Verified/model badges plus a `"Copy summary"` button in the `saved` and `done` phases.
- **Files changed:** `src/entrypoints/sidepanel/SummaryDialog.tsx`, `tests/components/summary-dialog.test.tsx`
- **Learnings:**
  - Patterns: Reusing `ConsentFacts` inside `SummaryDialog` renders `props.origin` inside its own `<code>` chip, preserving exact `findByText(origin)` assertions while unifying disclosure layout across Options and Side Panel.
---









