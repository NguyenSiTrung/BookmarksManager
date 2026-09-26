# Phase 2: Search

## Overview

Build local search from `PROJECT_PLAN.md` §5.1 and §15 Phase 2: a MiniSearch
fuzzy index over title, URL, domain, tags, and notes; a query syntax with
filters; a side-panel search bar; a Ctrl/Cmd+K command palette; a popup search
box; and a `bm` omnibox keyword. Everything runs on the device and makes
**zero network requests**. No search query is stored or sent anywhere.

Architecture: one pure module, `src/search/` (no `chrome`, DOM, or React),
owns the query parser, index building, and matching. Each context keeps its
own in-memory index built from the live tree and metadata; no index snapshot
is persisted.

- **Side panel:** builds on mount and applies diff-based incremental updates
  (MiniSearch `add`/`discard`/`replace`) as the tree, metadata, or tag
  definitions change.
- **Popup:** builds lazily after first paint, so the 150 ms open target is
  unaffected.
- **Service worker (omnibox):** builds a fresh index when a keyword session
  starts (`onInputStarted`) and keeps it only for that session, so it never
  serves stale data after side-panel edits. MV3 worker restarts simply
  rebuild.

Rationale: a worker-owned shared index would need rebuild-on-wake anyway,
cross-context invalidation for Dexie writes made by the side panel, and a
message round trip per keystroke; a persisted snapshot adds staleness and
migration cost to save a sub-second rebuild. Phase 4's Jev re-rank can take a
shortlist of IDs from the UI.

## Functional Requirements

### 1. Index and matching (`src/search/index.ts`)

- One document per bookmark: `title`, `url`, `domain` (host without `www.`),
  tag display names, `notes`, plus stored fields used for filtering (id,
  folder ancestor ids and titles, `dateAdded`, category, tag nameKeys).
- Free-text terms are ANDed, with prefix matching and typo tolerance
  (MiniSearch `fuzzy`). Field boosts rank title highest, then tags, then
  domain, URL, and notes.
- Results are ordered by relevance. A query with filters but no free text
  keeps the library's tree order.
- Bookmarks with `javascript:` or `data:` URLs are indexed and listed, but
  their open actions are disabled on every surface.

### 2. Query syntax (`src/search/query.ts`)

- Filters: `tag:`, `folder:`, `domain:`, `category:`, `before:`, `after:`,
  `is:duplicate`, `is:untagged`, `is:dead`.
- Quoted values (`folder:"Work stuff"`, `tag:"machine learning"`) and quoted
  exact phrases (`"async rust"`).
- Negation with a leading `-` on any filter or term (`-tag:old`,
  `-domain:example.com`).
- Semantics:
  - `tag:` matches a tag name case-insensitively; repeated `tag:` filters must
    all match (AND).
  - `folder:` matches any ancestor folder title case-insensitively (subtree
    semantics, like the folder view); a value containing `/` matches a
    contiguous ancestor path such as `Dev/Rust`.
  - `domain:` matches the host or any subdomain (`domain:github.com` matches
    `gist.github.com`), ignoring `www.`.
  - `category:` takes one of the fixed `Category` values.
  - `before:`/`after:` take `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` in local time
    against `dateAdded`; `after:` includes the given period, `before:`
    excludes it.
  - `is:duplicate` uses the existing `groupDuplicates`; `is:untagged` matches
    the Untagged view's rule.
  - Repeated single-valued keys (`folder:`, `domain:`, `category:`) match any
    of their values (OR). Different keys are always ANDed.
- `is:dead` is recognized, matches nothing, and shows "Link checking isn't
  available yet" (it needs the release 1.1 link checker).
- An unknown `key:` token is treated as free text (pasted URLs still search).
  A malformed value for a known key (bad date, unknown category, empty value)
  produces a visible warning for that token, and the token is ignored.
- The parser is total: it returns a typed AST plus warnings and never throws.

### 3. Autocomplete (`src/search/suggest.ts`)

- In the side-panel search bar and the palette: suggest filter keys for a
  partial key, and values after `tag:`, `folder:`, `category:`, and `is:`
  (tag names, folder titles, category values, `duplicate`/`untagged`/`dead`).
- Keyboard selectable; values containing spaces are inserted quoted.

### 4. Side-panel search bar

- A search input above the bookmark list. `/` focuses it when focus is not in
  a text field; `Esc` clears it.
- A non-empty query switches the list to a new `{ kind: "search"; query }`
  `SidePanelView` over the whole library, with a result count announced
  through `aria-live`. Clearing the query returns to the previous view.
- Results support the existing row actions, multi-select, and bulk actions.
  Drop slots stay off (results are not in tree order — existing pattern).
- Parser warnings appear inline under the input.

### 5. Command palette (Ctrl/Cmd+K in the side panel)

- Built on the existing Radix Dialog with an ARIA combobox + listbox (no
  `cmdk`; ranking stays with MiniSearch).
- Sections:
  - Bookmark results from the same search.
  - Jump to: All, Recently saved, Untagged, Duplicates, each folder, tag, and
    category.
  - Commands: Import, Export, Tag manager, New folder, Undo last action, Open
    Options.
- Per-result actions: Open (Enter), Open in new tab (Ctrl/Cmd+Enter), Reveal
  in folder, Edit, Copy URL. Copy uses `navigator.clipboard.writeText` from
  the user gesture with no `clipboardWrite` permission; a failure shows an
  error toast.
- Arrow keys move, Enter runs, Esc closes and restores the previous focus.

### 6. Popup search

- A search input at the top of the quick-save popup. While it has text, a
  results list (top 10) replaces the save form; clearing it brings the form
  back unchanged.
- Enter or click opens the result in a new tab; Ctrl/Cmd+Enter opens it in the
  current tab (`chrome.tabs.create`/`update`, no `tabs` permission).
- The index builds after first paint; until ready the input shows a short
  "Indexing…" state.

### 7. Omnibox keyword `bm`

- Manifest key `omnibox: { keyword: "bm" }` (a manifest key, not a
  permission).
- `onInputChanged` returns up to 8 suggestions (title, then domain and folder
  path) using the same query syntax. Every user-derived string in a
  suggestion description is XML-escaped (omnibox descriptions are XML
  markup).
- `onInputEntered` opens the chosen URL per the disposition (current tab, new
  foreground tab, new background tab). Free text that is not a suggestion
  opens the top result; with no result nothing happens. `javascript:` and
  `data:` URLs are never opened.
- Handlers are total and never log query or bookmark data.

## Non-Functional Requirements

- Zero network requests on every search surface; the e2e zero-egress spec
  exercises the search bar, the palette, and popup search. `CONSENT_VERSION`
  is unchanged.
- No new permissions. The `omnibox` manifest key is covered by a manifest
  test and described in `store/listing.md`, `store/reviewer-notes.md`, and the
  privacy documents ("search runs on your device; queries are not stored or
  sent").
- Performance at 10k bookmarks: median query under 50 ms (Vitest test on a
  synthetic 10k fixture); side-panel index build under 500 ms; popup
  interactive in under 150 ms.
- Accessibility: every surface is keyboard operable; the palette follows the
  ARIA combobox pattern; focus is restored on close and always visible.
- `z` is imported only from `src/schemas/z.ts`; any worker↔UI message is a
  total, Zod-validated union (per `conductor/patterns.md`).
- New dependency: `minisearch` ^7.2.0; `check:bundle` must stay green.
- Verification: phase ends are automated checkpoints (full gate green). The
  only manual user verification is at the end of the track.

## Acceptance Criteria

- Typing in the side-panel bar filters the whole library with fuzzy, prefix,
  typo-tolerant matching over title, URL, domain, tags, and notes; changes
  made elsewhere appear in results without a reload.
- Every filter, quoted values, negation, and the AND/OR rules behave as
  specified (table-driven parser and executor tests); `is:dead` shows the
  "not available yet" hint; malformed filters warn instead of failing.
- Ctrl/Cmd+K opens the palette; bookmark results, jump targets, and commands
  all work from the keyboard.
- The popup finds and opens a bookmark without opening the side panel.
- `bm <query>` in the address bar suggests bookmarks and opens the chosen one;
  titles containing `<`, `&`, or quotes render safely.
- A query takes under 50 ms at 10k bookmarks.
- Full gate green: lint, typecheck, unit/component tests, build,
  `check:manifest`, `check:bundle`, e2e (including zero egress with search
  exercised).

## Out of Scope

- Jev search re-rank and "no match" detection (Phase 4); any AI search.
- Recent or saved searches; smart collections (v2).
- Field-scoped text filters (`title:`, `url:`, `notes:`).
- Persisted index snapshots or a service-worker-owned shared index.
- Match highlighting; page-content search.
- A working `is:dead` (needs the 1.1 link checker).
