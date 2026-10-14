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
