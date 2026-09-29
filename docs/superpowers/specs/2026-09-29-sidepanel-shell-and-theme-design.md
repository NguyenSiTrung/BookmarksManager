# Side panel shell and shared theme — design

Date: 2026-09-29
Status: draft for review
Scope: sub-projects 1 (shared theme) and 2 (side panel shell) of the UI redesign.

## Background

A screen-by-screen review of the popup, side panel and Options page (captured
at 360, 480 and 1280 px) found that the side panel is the weakest surface:

- The layout targets a wide window, but a Chrome side panel is typically
  320–500 px wide. A fixed 176 px rail (`w-44`) leaves about 300 px for
  content at 480 px.
- The header packs the title, Import, Export, Review suggestions and Settings
  into one row. The title and "Review suggestions" wrap.
- Titles, URLs and folder names truncate ("Sourdou…", "https://co…",
  "Other boo…"), which makes the Duplicates screen unusable for its purpose.
- Navigation is one flat list of about 20 mixed items (views, actions, nine
  always-visible categories, tags, folders). Folders, the main hierarchy, get
  the least room. Review appears twice. AI-only entries show to users with no
  provider connected.
- The side panel uses the stock grey shadcn tokens and system font, while the
  popup and Options use a warm-neutral, teal, Geist identity scoped to
  `.popup-root` and `.options-root`. The three surfaces look like three
  products.

The popup is in good shape and Options was recently redesigned; both are only
touched here by the theme change.

## Decisions

- **Primary job of the side panel: find and open things fast.** Search and
  recent come first. Folders are secondary.
- **Layout A: search-first single column with a scope drawer** for narrow
  panels, and a permanent left scope column when the panel is wide.
- **No drag-to-folder in narrow mode.** Folders are not visible there. "Move
  to…" and the bulk bar cover moving. Drag reorder inside a list and folder
  drag in wide mode are unchanged.

## Part 1 — Shared theme

Change `src/ui/styles.css` only, plus the Tailwind font names that reference
it.

- Move the warm-neutral surfaces, the deep-teal accent, the tinted shadow
  color and Geist from the `.options-root, .popup-root` scope into the global
  `:root`. Delete the stock grey `:root` token block and its dark-mode twin.
  Dark mode keeps following `prefers-color-scheme`.
- Rename `--font-options-sans` / `--font-options-mono` to the standard
  `--font-sans` / `--font-mono` theme entries and apply the sans font on
  `body`. The Geist files are already bundled locally in the extension, so
  there is no new network request and the egress gate is unaffected.
- Keep the grain overlay (`.options-root::after`) Options-only. It is
  decorative and the side panel renders a virtualized list.
- Add two semantic tokens, `--row-hover` and `--row-selected`, exposed as the
  `bg-row-hover` / `bg-row-selected` utilities. The scope pane rows and the
  view chips consume them. Tag-chip colors are not added: `tag-chip.tsx`
  already owns them.
- The side panel inherits the new look through the shared tokens (`bg-accent`,
  `bg-primary`, dialogs, dropdowns). For example the black "Start scan" button
  becomes teal. Popup and Options should look almost identical to before.

Verification: before and after screenshots of the popup and every Options
panel using the capture script; lint, typecheck, component tests, build.

## Part 2 — Side panel shell

### Narrow mode (viewport width under 640 px)

Top to bottom:

1. **Top bar.** The existing `SearchBar` (with the Ask toggle), a `⋯` Tools
   menu and the Settings button. The visible title is removed because
   Chrome's panel header already names the extension. A visually hidden
   `<h1>Bookmarks Manager</h1>` stays for screen readers and for the e2e
   ready check.
2. **View chips.** All, Recent, Untagged, plus a "More" menu holding
   Duplicates, Review and Restructure. When the active view lives inside
   More, the More chip shows that view's label. A badge on More shows the
   pending Review count when it is greater than zero.
3. **Scope button.** A heading-level control showing the current view title
   from the existing `viewTitle` helper ("All bookmarks", the folder name,
   `#tag`, a category). It sits on the same line as the item count and
   List/Grid toggle (the `BookmarkList` toolbar gains a `leading` slot). It
   replaces the old pane title. In narrow mode it opens the scope drawer; in
   wide mode it is plain text.
4. **Content.** The list (or Review, Duplicates, Restructure view) gets the
   full panel width.

**Scope drawer.** A sheet over the panel (a Radix dialog styled as a sheet)
containing, in order: the existing `FolderTree` with its folder actions and
context menus, Tags, and Categories. Categories appear only when they have at
least one bookmark, and show counts. Choosing a scope closes the drawer and
returns focus to the scope button. `Esc` closes it.

### Wide mode (viewport width 640 px and up)

The scope content renders as a permanent left column of about 224 px. It is
the same `ScopePane` component with a different host. The host is chosen in
JavaScript by `useIsWide()` (`matchMedia("(min-width: 640px)")`) so that
exactly one host renders. A CSS container query would render both hosts and
duplicate the folder tree in the DOM. A side panel's viewport width is the
panel width. When `matchMedia` is unavailable (jsdom) the hook reports wide.
The top bar and chips stay as in narrow mode.

### Tools menu and AI visibility

- Tools menu items: Import, Export, Manage tags, and Scan library when a
  provider is connected.
- With no provider connected, Scan library is replaced by a single "Set up
  AI…" entry that opens Options.
- Restructure appears in the More menu (not Tools) only when a provider is
  connected. Duplicates is always in More.
- Review appears in More only when suggestions are pending or a provider is
  connected. Visibility is one small pure function of (provider connected,
  pending count).
- "Provider connected" means any consent row at the current consent version
  whose scope is not the synthetic `jev_test` scope.

### Unchanged

The `SidePanelView` union and `views.ts` resolution, selection handling, the
command palette (`Ctrl+K`), the `/` shortcut, all dialogs' internals, and the
Review, Duplicates and Restructure content. Those views only benefit from the
extra width.

## Code structure

`App.tsx` (about 1,120 lines) currently owns state, the header, the rail and
every dialog. Split the shell into focused files under
`src/entrypoints/sidepanel/`:

| File | Responsibility |
|---|---|
| `TopBar.tsx` | Search bar slot, Tools menu, Settings button |
| `ViewChips.tsx` | Chip row, More menu, active-label and badge logic |
| `ScopeHeading.tsx` | Scope label heading; drawer trigger in narrow mode |
| `ScopePane.tsx` | Folders, tags, categories content (host-agnostic) |
| `ScopeDrawer.tsx` | Sheet host for narrow mode |
| `scope.ts` | Pure helpers: category counts, More-menu views, AI visibility rule |
| `useIsWide.ts` | `matchMedia` hook (reports wide when unavailable) |
| `useAiConnected.ts` | Live "provider connected" read from Dexie |

`App.tsx` keeps view state, selection, dialogs and toasts, and composes these
pieces. Dialogs stay where they are; Tools menu items only open them. Data
flow is unchanged: `tree`, `tagDefs` and `metas` feed the pure helpers.

## Error and empty states

- The drawer shows the existing "Loading…" state until the tree has loaded.
- An empty Tags or Categories section is omitted rather than rendered empty.

## Testing

- Vitest component tests: `TopBar`, `ViewChips` (overflow, active label,
  badge), `ScopePane` (non-empty categories with counts), `ScopeDrawer` (open,
  select, close, focus return, `Esc`).
- Unit tests for `scope.ts` (category counts, scope label, AI visibility).
- Update the e2e helpers for the moved controls: Import and Export through the
  Tools menu, folder tree items through the drawer. Keep role-based selectors.
  The existing e2e drift tracked as `BookmarksManager-gyx` overlaps this and
  should be considered when planning.
- Manual pass at 360, 480 and 1280 px, light and dark, using
  `/tmp/capture/capture.mjs` for before and after screenshots.
- Gates: `npm run lint`, `npm run typecheck`, `npm run test -- --run`,
  `npm run build`, and the `check:*` scripts.

## Rollout

Two commits, in order, following the repo's commit-per-task rule and never
pushing:

1. Shared theme (Part 1). Low risk and independently shippable.
2. Side panel shell (Part 2).

Regenerate the store screenshot (`UPDATE_STORE_ASSETS=1`) after both land.

## Out of scope

Later sub-projects, each with its own spec:

- Row visuals: favicon, domain, tag chips, hover-revealed actions and drag
  handle; the Duplicates row layout; empty states with next actions.
- Dialogs: Import drop zone, left-aligned copy, plain-language scan cost.
- Options and popup polish: collapsed disclosures, deduplicated consent text,
  disabled-button style, popup search placement.
