<!-- Last Revised: 2026-10-14 (Revision 1 — aligned UX-02/UX-12 with P-10 lazy tag loading, DECISIONS_TRIGGERS, and popup search form invariants) -->
# UI/UX Refactor & Ergonomics Redesign

## Overview

Upgrade the **Side Panel Manager**, **Quick-Save Popup**, **Dialogs**, and **Options** surfaces into a cohesive, low-friction, and information-rich bookmark management experience without rewriting the extension's architecture or adding runtime dependencies.

This track resolves the structural UX gaps identified in the 2026-10-14 UI/UX audit across four pillars:
1. **Shared Tagging & Folder Ergonomics:** Unify `TagField` (`src/ui/components/tag-field.tsx`) with live `TagDef` combobox autocomplete (displaying tag color dots and names) across the Popup, `EditDialog`, and `BulkBar` (`TagPromptDialog`); add live search filtering and inline `+ New folder` creation to `MoveToDialog`.
2. **Side Panel Bookmark Rows & Sidebar Richness:** Add one-click open actions and metadata cues (colored `TagChip` dots, personal `notes` and saved AI `summary` indicators, and parent folder breadcrumb badges in non-folder views) to `BookmarkList`; add tag color dots and bookmark counts to `ScopePane`.
3. **Side Panel Navigation, Search & Bulk Bar Polish:** Make narrow-panel (`<640px`) folder/tag browsing unmistakable with a dedicated icon-badged drawer trigger in `ScopeHeading`; promote `Review suggestions` to a top-level chip in `ViewChips` whenever `pendingCount > 0`; add a leading `SearchIcon`, clear (`×`) button, and `Ctrl/⌘K` command-palette shortcut pill to `QueryInput`/`TopBar`; and streamline `BulkBar` so selection controls stay compact and readable at 320px width.
4. **AI Workflows, Dialogs, Popup & Options Cohesion:** Format `SummaryDialog` disclosures with the shared `ConsentFacts` card layout; upgrade `ReviewView` with primary visual weight on `Approve` plus a collapsible `Applied history` section (`listApplied()`) supporting post-toast `Undo` (`REVERT_DECISION`, resolving `BookmarksManager-tax`); streamline `popup/App.tsx` search-open transitions and auto-trigger `SAVE_SUGGEST` when `jev_decisions` consent is already granted; and surface inline `jev_decisions` consent status + a direct jump action inside `ProviderSetup.tsx` once a Jev provider is enabled.

Native Chrome bookmarks remain the source of truth. Core features stay 100% offline; optional AI remains strictly consent-gated and exact-origin scoped.

- **Track ID:** `ui_ux_redesign_20261014`
- **Type:** feature / refactor / UI-UX polish
- **Priority:** High (P1)
- **Execution:** Five sequential phases; task-level parallelism enabled where tasks have strictly disjoint `files` and no `depends` edges (annotated in `plan.md`).
- **Verification:** Automated gates + headless Chromium visual verification (`view_media` inspection of rendered screenshots). No manual blocking wait at phase boundaries or at track completion; automated task, phase, and final gates are mandatory.
- **Track dependencies:** none.
- **Estimate:** unset (`null`).

## Design & Architectural Decisions

1. **Bookmark Row Activation vs. Selection (`UX-04`):**
   - Preserve the existing WAI-ARIA listbox selection contract (`onClick` selects the row, `Shift+Click` range-selects, `Ctrl/Cmd+Click` toggles, `onDoubleClick` and `Enter` activate/open the URL) so all keyboard navigation, drag-and-drop, and existing selection tests remain intact.
   - Add an explicit one-click **`Open` icon button** (`ExternalLinkIcon`, `aria-label="Open <title>"`) inside the row's action cluster (alongside the `⋯` menu, revealed on hover/focus/selection) so pointer users have an obvious single-click open affordance without needing to discover double-click.
2. **Preserve Semantic Selectors & ARIA Contracts:**
   - Keep existing ARIA roles, accessible names (`"Tools"`, `"Settings"`, `"All"`, `"Recent"`, `"Untagged"`, `"More"`, `"Browse"`, `"Search bookmarks"`), and `data-*` attributes (`data-tag`, `data-tag-more`, `data-category`, `data-row-controls`, `data-dnd-drag`, `data-decision-id`) intact so existing component and e2e suites remain green while new ergonomics are layered in.

## Functional Requirements

### 1. Shared Primitives: `TagField` Autocomplete & `MoveToDialog` Upgrade (`UX-01`–`UX-03`)

| ID | Requirement |
|---|---|
| UX-01 | Extract and upgrade `TagField` into `src/ui/components/tag-field.tsx` (re-exporting from `src/entrypoints/popup/TagField.tsx` for compatibility). Add an optional `availableTags?: readonly TagDef[]` prop: when focused and typing (or via `ArrowDown`), render an accessible autocomplete suggestion list (`data-testid="tag-field-suggestions"`) of matching unselected tags (case-insensitive match on `name` or `nameKey`), showing each tag's color dot (`tag.color`) and display name. `ArrowDown`/`ArrowUp` navigate suggestions, `Enter` or `MouseDown` commits the highlighted suggestion chip (when no suggestion is highlighted, `Enter` or `,` commits the raw typed text as before), and `Escape` dismisses the suggestion list before bubbling. Render each staged chip's `color` from `availableTags` when present. |
| UX-02 | Replace the separate chip box + text input in `src/entrypoints/sidepanel/EditDialog.tsx` with the shared `TagField` component, passing `availableTags={tagDefs}` (or derived from `tagNameByKey`/`tagDefs`) so editing a bookmark supports inline chip entry, `Backspace` chip removal, and tag autocomplete. In `src/entrypoints/sidepanel/BulkBar.tsx` (`TagPromptDialog`), add tag autocomplete suggestions from `db.tags` (for `"remove"`, prioritize/filter to tags present on the selected bookmarks when available, falling back to defined tags) so users can click or arrow-select existing tags instead of typing from memory. Also pass `availableTags={tagDefs}` into `src/entrypoints/popup/App.tsx`'s `TagField` (loading `listTags()` lazily when `TagField` is focused or search is opened, preserving `P-10`). |
| UX-03 | Upgrade `src/entrypoints/sidepanel/MoveToDialog.tsx` with: (a) a search/filter input (`aria-label="Filter folders"`, `placeholder="Filter folders…"`) that filters `destinations` case-insensitively by folder title/path (auto-shown or always available above the destination list); and (b) an inline `"+ New folder"` toggle/form inside `MoveToDialog` that creates a subfolder under the currently selected destination (or `"Bookmarks bar"`/`"Other bookmarks"` default) via `createFolder`, refreshes/selects the newly created folder ID, and lets the user complete the move in one flow. |

### 2. Side Panel Bookmark List & Scope Sidebar Richness (`UX-04`–`UX-06`)

| ID | Requirement |
|---|---|
| UX-04 | In `src/entrypoints/sidepanel/BookmarkList.tsx` (both `list` and `grid` layouts): add a one-click `Open` icon button (`ExternalLinkIcon`, `aria-label={\`Open \${title}\`}`) inside `[data-row-controls]` before the `⋯` actions menu when `isOpenableUrl(item.url)` is true, calling `onActivate(item)` on click without changing row selection. Keep `tabIndex={active ? 0 : -1}` on all buttons inside `[data-row-controls]`. |
| UX-05 | Enrich `BookmarkList.tsx` metadata rendering: (a) pass `tagDefs` or `tagColorByKey` into `BookmarkList` so `[data-tag]` chips render a colored dot when the tag has a custom `color`; (b) render subtle indicator badges/icons on rows/cards when `meta?.notes` is non-empty (`data-has-notes="true"`, `title="Has notes"`) or `meta?.summary` is non-empty (`data-has-summary="true"`, `title="Has saved summary"`); and (c) when `showFolderPath` is true (enabled in `App.tsx` for non-folder views: `all`, `recent`, `untagged`, `tag`, `category`, `search`), display the bookmark's immediate parent folder title (`item.path[item.path.length - 1]`) alongside the domain line (`domain · Folder`). |
| UX-06 | Upgrade `src/entrypoints/sidepanel/ScopePane.tsx` `Tags` section to display each tag's color dot (`tag.color`, matching `TagChip`) and its bookmark count on the trailing edge (matching the `Categories` section's count pill), computed from `metas` and `tree.bookmarks` in `src/entrypoints/sidepanel/scope.ts` (`tagCounts`). Keep each tag button's accessible name compatible (`getByRole("button", { name: /^#?Ops/ })` or `aria-label={tag.name}`). |

### 3. Side Panel Shell, Search Bar & Bulk Bar Streamlining (`UX-07`–`UX-09`)

| ID | Requirement |
|---|---|
| UX-07 | Improve narrow-panel (`<640px`) navigation and view switching: (a) in `src/entrypoints/sidepanel/ScopeHeading.tsx`, style the narrow-mode drawer trigger as an unmistakable interactive pill button with a leading folder/sidebar icon (`PanelRightIcon` or `FolderIcon`), subtle border/background (`border border-border/80 bg-card px-2 py-1`), and trailing chevron while keeping its accessible name as `title` (`getByRole("button", { name: title })`); (b) in `src/entrypoints/sidepanel/ViewChips.tsx`, when `pendingCount > 0`, render `Review suggestions` (with its `{pendingCount}` badge) as a direct top-level chip alongside `All`, `Recent`, and `Untagged` (while keeping `More` available for `Duplicates`/`Restructure` and also keeping `Review suggestions` reachable in `More` so existing menu flows continue to work); and (c) make the List/Grid view toggle in `BookmarkList.tsx` compact on narrow viewports (`aria-label="List view"` / `aria-label="Grid view"` with responsive labels so `<640px` never crowds the scope heading). |
| UX-08 | Upgrade `src/ui/components/query-input.tsx`, `src/entrypoints/sidepanel/SearchBar.tsx`, and `src/entrypoints/sidepanel/TopBar.tsx`: (a) add a leading `SearchIcon` and a trailing clear (`×`, `aria-label="Clear search"`) button when `value !== ""` inside `QueryInput`; (b) add a filter-syntax hint chip/row or focus helper on `SearchBar` showing common filter tokens (`tag:`, `folder:`, `in:`, `has:`) that inserts the filter prefix on click; and (c) add a dedicated `Command palette` icon/shortcut button (`⌘K` / `Ctrl+K`, `aria-label="Command palette"`) in `TopBar` and show keyboard shortcut hints inside the `Tools` dropdown menu. |
| UX-09 | Streamline `src/entrypoints/sidepanel/BulkBar.tsx` for narrow side panels: style the selection count as a compact pill with an inline clear (`×`) button (`Clear selection`), group primary actions (`Move to…`, `Delete`, `Add tag`, `Remove tag`, `Set category`, `Analyze`) with clean compact spacing (`gap-1 px-2 py-1`), and dynamically measure or offset `UndoToast` (`src/entrypoints/sidepanel/UndoToast.tsx`) so a multi-line `BulkBar` never overlaps the toast. |

### 4. AI Workflows, Dialogs, Popup & Options Cohesion (`UX-10`–`UX-13`)

| ID | Requirement |
|---|---|
| UX-10 | Refactor `src/entrypoints/sidepanel/SummaryDialog.tsx`'s `disclosure` phase to render each hop (`llm_summary` and `jev_summary_verify`) inside a styled card using the shared `ConsentFacts` structure (Recipient, Sent, Never sent, Why, When, grant status badge, and required unchecked agreement checkbox when ungranted), and polish the `saved` / `done` summary view with a model/verified badge and a `"Copy summary"` action button. |
| UX-11 | Upgrade `src/entrypoints/sidepanel/ReviewView.tsx` and `src/decisions/store.ts` (`BookmarksManager-tax`): (a) give the per-row `Approve` button primary visual distinction (`border-primary/40 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground`) so it stands out from `Explain` and `Reject`; and (b) add `listApplied()` in `src/decisions/store.ts` (streaming into `App.tsx` alongside `listReviewable()` and `listAutoApplied()`) and render a collapsible `Recently applied` / `Applied history` section in `ReviewView.tsx` showing manually `applied` and `auto_applied` decisions with provenance and a working `Undo` (`REVERT_DECISION`) button even after the 8-second toast has expired. |
| UX-12 | Smooth the Quick-Save Popup (`src/entrypoints/popup/App.tsx`, `src/entrypoints/popup/Search.tsx`): (a) when `searchOpen === true` and `query === ""`, render quick filter-prefix pills (`tag:`, `folder:`, `in:`, `has:`) inside `PopupSearch` (`data-testid="popup-search-hint"`) that insert the filter token on click while keeping `<form>` mounted until `searchQuery !== ""`; and (b) load `tagDefs` lazily on `TagField` focus (`suggestionRequested`) so `TagField` offers live `TagDef` combobox autocomplete in the popup while preserving the `P-10` lazy-read invariant and the store-disclosed `DECISIONS_TRIGGERS` rule (zero egress on popup open; `SAVE_SUGGEST` fires only on `Tags` focus or `Suggest` click). |
| UX-13 | Bridge the `Connections` → `Permissions` mental model in `src/entrypoints/options/ProviderSetup.tsx` and `src/entrypoints/options/OptionsApp.tsx`: when a Jev provider is enabled (`status?.enabled === true`), display its live `Bookmark analysis consent` status (`Consent granted` badge vs. a callout with an `"Configure analysis consent in Permissions →"` action button that navigates to `#permissions`) directly inside the enabled provider card in `Connections`. |

## Non-Functional Requirements

- **Zero new runtime npm dependencies** and **zero new manifest permissions**.
- All Zod schemas continue importing from `src/schemas/z.ts`.
- All outbound `fetch` calls remain strictly inside `src/net/**` behind the existing egress gates.
- All interactive controls meet WCAG 2.1 AA keyboard accessibility (`focus-visible:ring-2`, proper ARIA roles/labels, roving `tabIndex` where applicable).

## Acceptance Criteria

1. Every task begins with a failing unit or component test and makes it pass with a clean, minimal implementation.
2. Visual verification of affected surfaces (Side Panel narrow & wide, Popup save & search, Dialogs, ReviewView, Options) in headless Chromium inspected via `view_media`.
3. Full local gate passes: `npm run lint` → `npm run typecheck` → `npx vitest run` → `npm run build` → `npm run check:manifest` → `npm run check:bundle` → `npm run check:store` → `npm run check:site` → `xvfb-run -a npm run test:e2e`.
4. Every completed task is committed locally with a `git notes add -m "..."` summary and its mapped Beads issue closed (including `BookmarksManager-tax`).

## Out of Scope

- v1.1 opt-in link checker (`is:dead` network probing).
- New AI capabilities or changes to Jev/LLM wire protocols.
