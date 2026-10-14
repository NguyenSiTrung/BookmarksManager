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


