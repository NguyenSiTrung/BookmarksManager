# Side panel content: rows, Duplicates and empty states

Date: 2026-09-29
Status: approved in chat, pending written-spec review
Scope: sub-project 3 of the UI redesign (sub-projects 1 and 2, theme and
shell, are done; see `2026-09-29-sidepanel-shell-and-theme-design.md`).

## Goal

Make the side panel's content as calm and scannable as its new shell:

1. List rows show what identifies a bookmark (title, domain) and hide
   controls until they are needed.
2. Duplicate groups show only what differs between members (their folders).
3. Every empty case says what is happening and offers at most one next step.

Primary job stays "find and open fast" (decided in the shell spec).

## Part 1: List rows

File: `src/entrypoints/sidepanel/BookmarkList.tsx` (the `Option` component).

- **Secondary line** shows the domain: the URL's hostname without a leading
  `www.`. If the URL does not parse, the raw URL is shown. The full URL is the
  row's `title` attribute (tooltip). New pure helper
  `displayDomain(url: string): string` in
  `src/entrypoints/sidepanel/row-text.ts`.
- **Hover-revealed controls.** The kebab wrapper and the drag handle stay in
  the DOM and keep their width, so nothing shifts. They are transparent until
  the row is hovered, contains focus, or is selected (`aria-selected`). Under
  `@media (hover: none)` they are always visible. Both remain focusable, so
  keyboard users reach them by tabbing; focus-within reveals them. The row
  gets a `group/row` class for this.
- **Chips.** Text size 11px (from 10px). At most 2 tag chips render, followed
  by a `+N` chip when more exist; that chip's `title` lists the hidden tag
  names. The category chip uses a soft primary tint (`bg-primary/10
  text-primary`). Chip helper `visibleTags(tags, max)` lives in `row-text.ts`.
- **Unchanged:** row height (`LIST_ROW_HEIGHT` 40, required by the
  virtualizer), the Grid layout, drag and drop, selection and roving focus.

## Part 2: Duplicates

File: `src/entrypoints/sidepanel/DuplicatesView.tsx`.

- **Group header:** kind badge, the first member's title, its domain, and
  `N members`, each once. `group.key` moves to the header's `title` attribute.
  The `data-testid`, `data-group-key`, `data-kind` and `aria-label` attributes
  stay.
- **Member row:** the primary text is the folder path (`item.path`, last two
  segments joined with ` / `, full path as tooltip). A secondary line shows
  `Added <date>` when `dateAdded` exists, formatted with `toLocaleDateString`
  (`{ day: "numeric", month: "short", year: "numeric" }`). The member's own
  title appears as an extra line only when it differs from the header title.
  Chips, tag count and `has notes` stay.
- **Actions:** `Keep this one` keeps its label and behaviour. `Open` becomes an
  icon button with the same `aria-label` (`Open <title>`) and `title` (URL).
  Keeping, removing and removed states are unchanged.
- **Unchanged:** merge, confirm panel, undo, failure and outcome banners.

## Part 3: Empty states

New files: `src/ui/components/empty-state.tsx` and
`src/entrypoints/sidepanel/empty-state.ts`.

`EmptyState` props: `title: string`, `hint?: string`,
`action?: { label: string; onSelect(): void }`. It renders a centred block with
a heading-weight title, a muted hint and an optional secondary button. It is
static content, so it has no live-region role.

`emptyStateFor(view, query, ctx)` is pure and returns
`{ title, hint?, action?: "import" | "clear-search" | "scan" | "setup-ai" }`
or `undefined` when the view is not empty. `ctx` carries `aiConnected` and
`libraryEmpty`.

| Case | Title | Hint | Action |
|---|---|---|---|
| Library empty (all view) | No bookmarks yet | Import a file, or save pages with the toolbar button. | Import… |
| Folder empty | This folder is empty | Use “Move to…” on a bookmark to put it here. | none |
| Search, no results | No results for “<query>” | Try fewer words or check the spelling. | Clear search |
| Untagged | Everything is tagged | Bookmarks without tags would show up here. | none |
| Recent | Nothing saved recently | Newly saved bookmarks appear here. | none |
| Tag | No bookmarks with this tag | Tag bookmarks from their ⋯ menu. | none |
| Category | No bookmarks in this category | Categories are set when you edit a bookmark. | none |
| Duplicates | No duplicates found | Every bookmark URL is unique. | none |
| Review, AI connected | Nothing to review | Suggestions from a scan appear here. | Scan library… |
| Review, no AI | Nothing to review | Connect an AI provider to get suggestions. | Set up AI… |

Wiring:

- `BookmarkList` gains `empty?: ReactNode`; when `items.length === 0` it renders
  `empty` (default: today's line, so standalone tests keep passing).
- `DuplicatesView` and `ReviewView` gain `empty?: ReactNode` with their
  current text as the default.
- `App` maps the `emptyStateFor` result to an `EmptyState` element, binding
  actions to existing handlers: Import… and Scan library… and Set up AI… use
  `handleTools`; Clear search calls `setSearchQuery("")`.
- The loading line in `DuplicatesView` ("Scanning for duplicates…") stays.

## Testing

- Unit: `displayDomain` (plain, `www.`, port, unparsable, empty), `visibleTags`
  (under, at, over the cap), `emptyStateFor` (every table row plus the
  non-empty `undefined` case).
- Component: row shows domain and not path, tooltip holds the full URL, kebab
  and drag handle are in the DOM, the `+N` chip appears and lists hidden tags;
  Duplicates header and member layout, Open icon button name, existing merge
  flow tests unchanged; `EmptyState` renders title, hint and action and fires
  `onSelect`; App-level: an empty library shows Import…, a no-hit search shows
  Clear search and it clears the box.
- Update existing tests where copy changed (`duplicates-view.test.tsx` uses
  `/No duplicates/`, which still matches).
- Manual pass at 360, 480 and 1280 px with `/tmp/capture/capture.mjs`,
  including an empty-library capture; regenerate the store screenshot.
- Gates: `npm run lint`, `typecheck`, `build`, the `check:*` scripts, unit and
  component suites, and the `shell`, `core-manager` and `decisions` e2e specs
  (row text assertions that used full URLs need review).

## Out of scope

- Grid cards, Review and Restructure row visuals.
- Dialogs (Import drop zone, scan cost copy).
- Options and popup polish.
- Any change to data flow, views or the virtualizer.
