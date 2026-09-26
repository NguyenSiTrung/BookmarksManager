# Phase 1: Core Manager

## Overview

Build the offline core of the extension from `PROJECT_PLAN.md` §5.1 and §15
Phase 1: a side-panel bookmark manager and quick-save flows backed by native
Chrome bookmarks, with tags, categories, drag and drop, import/export, local
duplicate detection with merge and undo, `_favicon` site icons, and "Delete all
extension data". Everything works with no API key and makes **zero network
requests**.

Native `chrome.bookmarks` stays the source of truth for the tree. The extension
stores only its own metadata (tags, category, notes) in IndexedDB, keyed by the
Chrome node ID. Search (MiniSearch, query syntax, command palette) is Phase 2.

## Functional Requirements

### 1. Bookmark sync (two-way, native tree is authoritative)

- Extension → Chrome: every tree edit (create, rename, edit URL, move, reorder,
  delete, create folder) goes through `chrome.bookmarks`; metadata edits go to
  IndexedDB.
- Chrome → extension: the service worker listens to `onCreated`, `onChanged`,
  `onMoved`, `onChildrenReordered`, and `onRemoved`; open UI surfaces refresh
  live.
- Metadata rows are created lazily (a bookmark with no tags, category, or notes
  has no row). `onRemoved` deletes the metadata for the removed node **and all
  removed descendants immediately**.
- On service-worker startup, a reconcile pass deletes metadata rows whose IDs
  no longer exist in the tree (covers deletions while the worker was stopped).
- Respect Chrome's fixed root folders (bookmarks bar, other, mobile) and
  `unmodifiable` (managed) nodes: they cannot be moved, renamed, or deleted,
  and the UI disables those actions.
- Metadata is local only in this track (no `chrome.storage.sync`, no cloud
  sync).

### 2. Side panel manager

- Folder tree (expand/collapse, keyboard navigable) plus a bookmark list for
  the selected folder, with list and grid views. The list is virtualized for
  10k+ items.
- Per-item actions: open, edit (title, URL, folder, tags, category, notes),
  delete, "Move to…". Multi-select with bulk move, delete, add/remove tag, and
  set category.
- Folder actions: create, rename, delete (with a count of what will be
  deleted).
- Views: All, per folder, per tag, per category, Untagged, Duplicates, Recently
  saved.
- Drag and drop (dnd-kit, keyboard sensor enabled): move and reorder bookmarks
  and folders, including multi-select drags. "Move to…" provides a non-drag
  path.

### 3. Quick save

- Popup: prefilled with the active tab's title and URL (via `activeTab`);
  choose a folder (defaults to last used), tags, category, and notes; Save. If
  the normalized URL already exists, show "Already saved in <folder>" and offer
  to edit that bookmark.
- Keyboard shortcut: manifest `commands` → `_execute_action` opens the popup.
  The suggested key avoids Chrome defaults; the user can rebind it at
  `chrome://extensions/shortcuts`.
- Context menu: "Save page to Bookmarks Manager" and "Save link to Bookmarks
  Manager" save into the last-used folder and confirm with a short action
  badge. The item then appears under "Recently saved".
- The popup has an "Open manager" button that opens the side panel.

### 4. Tags and categories

- Tags: many-to-many, with a name (1–64 characters, unique
  case-insensitively), an optional color, and an optional description (≤300
  characters). Create, rename (updates all bookmarks), recolor, and delete
  (removes the tag from all bookmarks, with a count).
- Categories: the fixed `Category` enum from §7, at most one per bookmark.
- Tag and category chips on list items; a tag manager in the side panel.

### 5. Import and export (local files only)

- Export the whole library or one folder as Netscape HTML, JSON, or CSV.
  - JSON: a versioned, Zod-validated envelope with the tree plus tags,
    categories, notes, and tag definitions.
  - CSV: title, url, folder path, tags, category, notes, created. Cells
    starting with `=`, `+`, `-`, `@`, tab, or CR are escaped against formula
    injection.
  - Exports never include API keys, key material, consent records, provider
    settings, the sent log, or decisions.
- Import from Netscape HTML, JSON, or CSV:
  - Parse with `DOMParser` and Zod (no `innerHTML`, nothing executed); enforce
    a file size cap; skip `javascript:` and `data:` URLs and invalid rows.
  - Show a preview with counts (folders, bookmarks, duplicates to skip, invalid
    rows) before writing anything. Nothing is written without Confirm.
  - Always write into a new "Imported <YYYY-MM-DD HH:mm>" folder under Other
    bookmarks, preserving the file's folder structure inside it.
  - Skip bookmarks whose normalized URL already exists; an "Import duplicates
    anyway" checkbox overrides this.
  - JSON restores tags, categories, notes, and tag definitions. HTML and CSV
    import what they carry (CSV tags and category included).
  - Show a summary afterwards. Undo = delete the import folder, offered in the
    summary.

### 6. Local duplicate detection with merge

- Deterministic URL normalization in code: lowercase scheme and host, drop the
  default port and fragment, drop `www.`, treat http and https as equal, strip
  a trailing slash, sort query parameters, and drop common tracking parameters
  (`utm_*`, `fbclid`, `gclid`, `mc_eid`, …). Groups are labeled "exact" or
  "normalized".
- The Duplicates view lists groups; items show a duplicate badge.
- "Keep this one" merge: union the group's tags onto the kept bookmark, join
  notes with a separator, keep the kept item's category (else the first one
  found), then delete the others.

### 7. Undo

- Delete, bulk move, merge, and tag delete write an undo snapshot to IndexedDB
  first (nodes with parent, index, title, and URL, plus their metadata).
- An "Undo" toast plus an undo action for the most recent operations (LIFO, at
  most 20 kept). Undo re-creates deleted nodes in their original parent and
  index and remaps metadata to the new Chrome IDs. If the original parent is
  gone, it restores into Other bookmarks and says so.

### 8. Site icons

- Icons use `chrome-extension://<id>/_favicon/?pageUrl=…&size=…` (`favicon`
  permission). No third-party icon service; a neutral placeholder on failure.

### 9. Delete all extension data

- An Options-page button with a confirm dialog that states exactly what is
  deleted and that **native Chrome bookmarks are not touched**.
- Deletes the whole IndexedDB database (metadata, tags, undo, decisions,
  consents, sent log, key material), clears `chrome.storage.local`, and removes
  all granted optional host permissions. The UI returns to a first-run state.

## Non-Functional Requirements

- Zero network requests across all Phase 1 features (extends the e2e
  zero-egress assertion). `CONSENT_VERSION` is unchanged.
- Permissions are added only for shipped features: `bookmarks`,
  `contextMenus`, `activeTab`, `favicon`. `store/permissions.md` and
  `wxt.config.ts` change in the same commit; `check:manifest` passes.
  `scripting` stays out until page extraction ships.
- `store/` docs (privacy policy, privacy practices, listing, reviewer notes)
  describe the new local data (tags, notes, categories, undo snapshots) and
  local file import/export, and nothing more.
- Performance: popup interactive in under 150 ms; the side panel renders a
  10k-bookmark library and scrolls smoothly (virtualized).
- Accessibility: all actions keyboard reachable; dialogs and menus manage focus
  correctly (shadcn/ui on Radix); visible focus; ARIA tree for folders.
- All message payloads, stored rows, and imported files are validated with Zod
  (jitless import site `src/schemas/z.ts`); message handlers are total, per
  `conductor/patterns.md`.
- New dependencies: `radix-ui` (through selectively copied shadcn/ui
  components), `@dnd-kit/core` and `@dnd-kit/sortable` (stable 6.x),
  `@tanstack/react-virtual`, `dexie-react-hooks`. Zustand and TanStack Query
  are deferred. The Dexie schema migrates v1 → v2 without data loss.
- Verification: phase ends are automated checkpoints (full gate green). The
  only manual user verification is at the end of the track.

## Acceptance Criteria

- Changes made in Chrome's own bookmark manager appear in the side panel
  without a reload; deleting a bookmark there removes its metadata immediately.
- A user can save the current tab from the popup, the shortcut, and the
  context menu, with folder, tags, category, and notes.
- Tags and categories can be created, edited, assigned in bulk, and removed;
  tag renames and deletes propagate to all bookmarks.
- Bookmarks and folders can be moved and reordered by mouse and keyboard drag,
  and through "Move to…".
- Export → import round-trips (JSON restores tags, categories, and notes);
  exports contain no secrets or consent data (tested); CSV formula cells are
  escaped.
- Import shows a preview, writes into a new dated folder, and skips duplicates
  by default.
- Duplicate groups are detected; merge keeps the tag and note union; undo
  restores the deleted bookmarks and their metadata.
- "Delete all extension data" leaves native bookmarks intact and returns the
  extension to a first-run state, with host permissions removed.
- Full gate green: lint, typecheck, unit/component tests, build,
  `check:manifest`, `check:bundle`, e2e (including zero egress with bookmark
  features exercised).

## Out of Scope

- Search index, query syntax (`tag:`, `is:dead`, …), command palette (Phase 2).
- Any AI, Jev, or LLM feature; review queue; decision audit log (Phases 3–5).
- Link checker, `scripting`, page extraction, `alarms` (1.1, Phase 4, v2).
- Cross-device metadata sync; orphan-metadata retention.
- Smart collections, passphrase key mode, sensitive-site blocklist.
