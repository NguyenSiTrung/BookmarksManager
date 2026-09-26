# Track Learnings: phase2_search_20260926

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list: `conductor/patterns.md`. The ones most relevant to search:

- Import `z` only from `src/schemas/z.ts` (jitless, MV3 CSP); `check:bundle` must stay green after adding `minisearch`.
- Lazy `declare const chrome` slices throw synchronously when a surface is absent or partial — wrap every caller boundary (omnibox registration, tabs calls) and test absent AND partial surfaces. Registration is all-or-nothing with cleanup.
- Handlers are total: return `{ok:true,…} | {ok:false,code,message}` unions; never leak exception `cause` objects.
- `src/entrypoints/sidepanel/views.ts` is pure; drop slots are only meaningful in tree-ordered views (`all`/`folder`) — a `search` view must keep them off.
- dnd-kit keyboard events bubble into app key handlers — guard `/` and Ctrl/Cmd+K handlers with `if (event.defaultPrevented) return;` and skip when focus is in a text field.
- Cross-surface state needs live subscriptions, not mount-time reads (an already-open panel never remounts).
- RTL conventions (`globals: false`): set `IS_REACT_ACT_ENVIRONMENT`, call `cleanup()` manually, prefer `findByRole`; `waitFor` async outcomes before asserting "nothing changed".
- Egress assertions filter OUT internal schemes (`chrome-extension:`, `chrome:`, `data:`, `blob:`, `about:`) and run after `context.close()`.
- Playwright e2e uses `channel: "chromium"`; headed under `xvfb-run -a`.
- Any new manifest key needs a manifest test and matching `store/` docs in the same change.

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-26 16:02] - Phase 1 Task 6 + Task 7: perf test + phase checkpoint
- **Implemented:** `tests/unit/search-perf.test.ts` — deterministic synthetic 10k corpus (no RNG); asserts index build < 500 ms and median-of-medians query < 50 ms across 13 query shapes (text, rare term, quoted filter, domain/folder/date filters, negation, phrase, is: flags, mixed, empty).
- **Files changed:** tests/unit/search-perf.test.ts
- **Commit:** b3b6bd6
- **Checkpoint evidence (full gate on main @ b3b6bd6):**
  - `lint` — 0 errors (1 pre-existing react-hooks/incompatible-library warning on useVirtualizer)
  - `typecheck` — clean
  - `vitest run` — **1522/1522 tests, 53 files** (up from 1128; +394 search tests)
  - `build` — OK, 1.01 MB total output
  - `check:manifest` — OK; `check:bundle` — OK (no eval/remote scripts; minisearch is CSP-safe)
  - `xvfb-run -a test:e2e` — **7/7 passed** incl. zero-egress spec
  - Perf measured: build 213 ms; median query ~15 ms; worst shape 22.6 ms — all well under 500/50 ms bounds
- **Learnings:**
  - Gotcha: vitest swallows `console.log` in tests — use `--disable-console-intercept` to probe real timings.

## [2026-09-26 15:57] - Phase 1 Task 3: Query executor
- **Implemented:** `runQuery(index, query, ctx)` → `{hits: SearchHit[], warnings}`; accepts raw string or ParsedQuery. `ctx = { treeOrder: readonly string[] (required), duplicateIds?: ReadonlySet<string> }`; `collectDuplicateIds(bookmarks)` unions `groupDuplicates` members — compute ONCE per corpus change, not per keystroke.
- **Files changed:** src/search/run.ts, tests/unit/search-run.test.ts
- **Commit:** 0e6ec6c
- **Learnings:**
  - MiniSearch has NO positional index — exact phrases are emulated: per-subquery `{prefix:false, fuzzy:false}` word-AND plus literal verification (phrase words co-occur in one indexed field; lowercased phrase present in that field's stored text). Words shared only via `notes` (indexed, not stored) stay unverified — recall over precision.
  - Exact subqueries must be placed LAST in the AND query — `match` entries merge via `Object.assign` (later wins), otherwise a phrase word shared with a fuzzy term bypasses verification.
  - Negated terms cost one extra `index.search()` each (exclusion set).
  - `before:`/`after:` resolve local-time bounds via `new Date(0)` + `setFullYear`/`setHours` (year<100 → 1900 pitfall avoided); undated docs fail positive date filters but pass negated ones.
  - Filter-only/all-negated/empty queries use `MiniSearch.wildcard` re-sorted by `treeOrder` (Map-rank stable sort); ids absent from treeOrder go last.
  - Semantics pinned: `tag:` ANDs; `folder:`/`domain:`/`category:` OR within key; negated values AND over the OR; `folder:a/b` = contiguous lowercase ancestor subsequence; `domain:` strips `www.` from filter value, `.`+value suffix rule prevents `notexample.com` punning.

## [2026-09-26 15:57] - Phase 1 Task 4: Autocomplete suggestions
- **Implemented:** `suggestFilters(text, cursor, sources?) → Suggestion[]` — `{kind: "key"|"value", key, label, insertText, replaceFrom, replaceTo}`; UI splices `text.slice(0,replaceFrom) + insertText + text.slice(replaceTo)`. Values with whitespace arrive quoted in insertText; `IS_VALUES` includes `dead`; `before:`/`after:`/`domain:`/quoted-spans → `[]`.
- **Files changed:** src/search/suggest.ts, tests/unit/search-suggest.test.ts
- **Commit:** de59303
- **Learnings:**
  - "Active token" = raw `[start,end]` span containing cursor (inclusive) — cursor at token start edits the token, doesn't insert before it.
  - Cursor in a `key:` token's key region replaces only `key:`; in value region replaces colon→token-end (swallows stray typed quotes).
  - Ranking: prefix group before substring group, then shorter length → earlier offset → source order; case-insensitive dedupe, first casing wins.
  - Values containing a literal `"` can't round-trip (no escape syntax) — quoted only on whitespace; rare edge documented in module docstring.

## [2026-09-26 15:31] - Phase 1 Task 2: MiniSearch index + diff updates
- **Implemented:** `src/search/index.ts` — `SearchSourceBookmark`→`SearchDocument` mapping (`extractDomain` strips `www.`, tag nameKeys→display names via `TagNameMap`, ancestor ids+titles stored aligned, `dateAdded`/`category`/`tagKeys` stored), `buildIndex`/`createSearchIndex`/`applyDocDiff` (upsert-tolerant via `index.has()`), `SearchHit` (title/url/domain stored → display-ready). `minisearch@7.2.0` installed.
- **Files changed:** src/search/index.ts, tests/unit/search-index.test.ts, tests/fixtures/search.ts, package.json, package-lock.json
- **Commit:** be93aab
- **Learnings:**
  - MiniSearch sums per-field scores — a `domain` hit always also hits `url` (host ⊂ URL), so boosts must be non-uniformly spaced (title:5, tags:4, domain:2, url:1, notes:0.5) to keep title>tags>domain>url>notes.
  - `applyDocDiff` order: discards → replaces → adds; MiniSearch add/discard/replace throw on dup/missing ids, guard with `index.has()`.
  - Auto-vacuum only at `dirtCount>=20 && dirtFactor>=0.1` — compare sorted id SETS in diff-vs-rebuild tests (scores can perturb microscopically); `index.vacuum()` exists if parity needed.
  - `fuzzy: 0.2` → max edit distance `round(len*0.2)`; terms ≤2 chars get zero tolerance. Default tokenizer splits on punctuation (`github.com` → `github`,`com`) — helps `domain:` matching.
---

## [2026-09-26 15:29] - Phase 1 Task 1: Query parser
- **Implemented:** `parseQuery(input): ParsedQuery` — total, never throws. AST: `terms: QueryTerm[]` ({text, exact, negated}), `filters: QueryFilter[]` (discriminated union on `key`: tag/folder/domain → string value; category → `Category`; before/after → `DateBound` {precision: year|month|day}; is → `IsFlag` = "duplicate"|"untagged"), `warnings: QueryWarning[]` ({token, message}).
- **Files changed:** src/search/query.ts, tests/unit/search-query.test.ts
- **Commit:** 7bb3752
- **Learnings:**
  - Contract: `is:dead` never enters the AST — warning "Link checking isn't available yet", token dropped (incl. `-is:dead`); `IS_VALUES` (incl. "dead") and `FILTER_KEYS` are exported consts for suggest.ts.
  - Contract: unknown `key:` → free text (quote-stripped); filter keys are case-sensitive lowercase (`TAG:x` is free text); category values match the enum exactly.
  - Contract: `QueryTerm.exact` marks fully-quoted phrases; embedded quoted segments can leave spaces in `term.text` — the executor must AND the words.
  - Gotcha: date validation is calendar-real (`2024-02-30`, `2023-02-29`, month 00/13 all warn) via `setFullYear` round-trip; `0000`/`9999` valid.
  - Tokenizer: unterminated quote consumes to EOL silently; `-` negates only directly before a non-space char; shell-style `a"b c"d` → `ab cd`.
---

## [2026-09-26 15:26] - Phase 1 Task 5: Openable-URL guard and typed tabs slice
- **Implemented:** `isOpenableUrl(url)` pure guard (denylist: `javascript:`/`data:`/blank rejected after ASCII-tab/newline strip + case-insensitive scheme check) and `openBookmarkUrl(url, disposition)` over a lazy `chrome.tabs` slice — `current`→`tabs.update`, `foreground`→`tabs.create(active:true)`, `background`→`tabs.create(active:false)`; total `{ok:true}|{ok:false,code}` results; absent/partial surfaces → `unavailable`, rejected promises → `api`.
- **Files changed:** src/search/openable.ts, src/sync/tabs.ts, tests/unit/search-openable.test.ts, tests/unit/tabs.test.ts
- **Commit:** 44a76cf
- **Learnings:**
  - Patterns: `isOpenableUrl` normalizes away ASCII tab/newline before scheme compare (WHATWG-style) so `java\tscript:` can't slip through; denylist beats allowlist because Chrome's own per-scheme refusals degrade to a typed `api` failure.
  - Context: `tabs.update` modeled only in no-tabId form (active tab of current window) — right target for popup/omnibox "current" opens; no `tabs` permission needed.
  - API for downstream: `import { isOpenableUrl } from "../search/openable"`, `import { openBookmarkUrl } from "../sync/tabs"` (`OpenUrlDisposition = "current"|"foreground"|"background"`).
---

## [2026-09-26 16:20] - Phase 2 Task 2: Search view and search bar
- **Implemented:** `{kind:"search"; query}` in `SidePanelView`; `resolveView(view, tree, metas, search?)` calls `runQuery(search.index, query, search.ctx)` and maps hit IDs back to live `BookmarkItem`s ([] while index null or query blank). `SearchBar` is a controlled input: Esc clears (stopPropagation so list-level Esc handlers don't fire), parser warnings render inline, result count in `role="status"`. App derives `activeView = query==="" ? view : {kind:"search"}` (memoized) — previous view is never overwritten, so clearing restores it for free. `/` keydown on `document` focuses the input, guarded by `defaultPrevented` + input/textarea/select/contenteditable checks. `reorderable` now gated on `all|folder` only.
- **Files changed:** src/entrypoints/sidepanel/views.ts, src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/App.tsx, src/search/run.ts (SearchIndexHandle), src/ui/hooks/useSearchIndex.ts (re-export), tests/components/sidepanel-search.test.tsx
- **Commit:** b0a1406
- **Learnings:**
  - Pattern: `SearchIndexHandle` lives in pure `run.ts` (not the hook) so `views.ts` keeps zero React imports — UI-layer types the pure layer needs get declared in the pure layer and re-exported from the hook.
  - Gotcha: `[data-dnd-drop]` matches BOTH reorder slots (`slot:*` on rows) and sidebar folder move targets (`folder:*` on the tree) — asserting "no drop slots" must prefix-match `slot:`; folder targets correctly stay live during search.
  - Gotcha: fuzzy 0.2 makes short queries collide ("zeta" hits "Beta"); test queries asserting 0 results need ≥2 edit distance from every indexed token.
  - Gotcha: single-letter terms only prefix-match tokens starting with them — `a` ≠ substring match.
  - Pattern: no jest-dom in this repo — use `toBeNull()`/`toBeTruthy()`/`textContent`/`.value`, never `toBeInTheDocument`/`toHaveTextContent`.
---

## [2026-09-26 16:30] - Phase 2 Task 3: QueryInput with autocomplete
- **Implemented:** `src/ui/components/query-input.tsx` — controlled input over `suggestFilters`; ARIA combobox (`aria-expanded`/`aria-controls`/`aria-activedescendant` on input, `role="listbox"`/`option` popup). Arrow keys cycle (wrap), ArrowDown reopens a dismissed popup, Enter accepts only a highlighted option (falls through so surfaces keep Enter-to-open), Esc dismisses the popup first and forwards to `onEscape` once closed. `SearchBar` now renders QueryInput with `sources={tags,folders}` built in App (root folders excluded — empty titles).
- **Files changed:** src/ui/components/query-input.tsx, src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/App.tsx, tests/components/query-input.test.tsx, tests/components/sidepanel-search.test.tsx (combobox role + listbox scoping)
- **Commit:** 63690b2
- **Learnings:**
  - Gotcha: suggest "fresh context" needs the caret strictly OUTSIDE every token span — a single interior space still belongs to the preceding token (inclusive end); only ≥2 spaces, trailing whitespace, or an empty query reach it.
  - Gotcha: `role="combobox"` replaces the `type="search"` implicit role — tests must query `combobox`, and suggestion `role="option"`s collide with result-list options; scope result assertions to the `aria-label="Bookmarks"` listbox.
  - Pattern: caret-aware suggestions need `onSelect`/`onKeyUp` caret sync plus a `pendingCaret` ref applied in `useLayoutEffect` after `value` changes (controlled-input caret can't be set mid-change).
  - Pattern: Enter with NO highlighted option must not preventDefault — the popup/palette surfaces need Enter for "open first result".
---

## [2026-09-26 16:42] - Phase 2 Task 4: Command palette
- **Implemented:** `palette.ts` (pure) — `buildPaletteSections({query, search, tree, tagDefs})` → Bookmarks (runQuery hits) + Views + Folders + Tags + Categories; non-empty query substring-narrows jump sections, empty sections drop, null index just omits Bookmarks. `CommandPalette.tsx` — Radix Dialog, combobox input driving a grouped listbox, index-0 pre-highlight, wrap-around arrows, Enter dispatches (jump→view switch + clears active search; bookmark→open). App: Ctrl/Cmd+K toggles via document keydown.
- **Files changed:** src/entrypoints/sidepanel/palette.ts, src/entrypoints/sidepanel/CommandPalette.tsx, src/entrypoints/sidepanel/App.tsx, tests/unit/palette-items.test.ts, tests/components/command-palette.test.tsx
- **Commit:** f1d61f9
- **Learnings:**
  - Gotcha: `FolderNode.isRoot` covers Chrome's FIXED roots (ids 1-3: "Bookmarks bar", "Other bookmarks") — those are real jump/`folder:` targets; only the synthetic "0" has empty title. Filter by `title !== ""`, not `!isRoot`.
  - Gotcha: `folderTitles`/`folderIds` are STORED fields, not indexed — free text never matches folder names; only `folder:` filters them.
  - Rule: new react-hooks eslint bans setState in effects AND in-JSX mutations — use render-phase state adjustment (`if (open !== prevOpen)`), derived clamps (`Math.min(active, len-1)`), and useMemo for per-section flat offsets.
  - Gotcha: Radix Dialog focus restore doesn't reach elements focused without a trigger (e.g. `/`-focused search input) — capture `document.activeElement` on open and `.focus()` it via queueMicrotask after close.
---

## [2026-09-26 16:57] - Phase 2 Task 5: Palette commands + actions
- **Implemented:** `COMMANDS` section (Import/Export/Manage tags/New folder/Undo/Open options), substring-narrowed like jumps; bookmark items carry `openable: isOpenableUrl(url)` — `javascript:`/`data:` rows keep Reveal/Edit/Copy but no opens, and Enter no-ops. Opens route through `openBookmarkUrl` (Enter→foreground, Ctrl/Cmd+Enter→background); typed failures → error toast. Per-option `⋯` DropdownMenu: Reveal in folder (jump to parent + `selectOnly`), Edit…, Copy URL → clipboard → "Copied URL" / error toast.
- **Files changed:** palette.ts, CommandPalette.tsx, App.tsx, tests/components/command-palette-actions.test.tsx, tests/components/command-palette.test.tsx (tabs stub), tests/unit/palette-items.test.ts (Commands section)
- **Commit:** 3502b03
- **Learnings:**
  - Gotcha: Radix DropdownMenuTrigger opens on POINTERDOWN — `fireEvent.click` alone won't open it in jsdom; fire `pointerDown` + `click`.
  - Pattern: palette opens use `openBookmarkUrl` (typed slice), not `window.open` — failures surface as error toasts; tests stub `chrome.tabs.create` not `window.open`.
  - Gotcha: `chrome.runtime.openOptionsPage` needs its own lazy slice — the test stub provides only `{bookmarks, tabs, runtime:{getURL}}`; a bare `chrome.runtime.openOptionsPage()` call is undefined→guarded.
  - Pattern: `FolderActionRequest.kind:"create"` takes the PARENT FolderNode — palette's "New folder" resolves the folder-in-view or falls back to "1" (Bookmarks bar).
---

## [2026-09-26 17:00] - Phase 2 checkpoint — automated gate GREEN
- **Gate evidence (run on main @ ce72e85):**
  - `npm run lint` — 0 errors, 1 pre-existing warning (TanStack `useVirtualizer` compiler-skip in BookmarkList.tsx:478)
  - `npm run typecheck` — clean (wxt prepare + tsc --noEmit)
  - `npm run test -- --run` — 1564 passed / 59 files
  - `npm run build` — OK
  - `npm run check:manifest` — permissions match store/permissions.md (no new permissions added)
  - `npm run check:bundle` — no eval/new Function/remote script tags
  - `xvfb-run -a npm run test:e2e` — 7/7 passed (27.5s), including the zero-egress sweep
- **Phase 2 commits:** adb06e5 (useSearchIndex), b0a1406 (search view+bar), 63690b2 (QueryInput), f1d61f9 (palette), 3502b03 (commands+actions)
- **Learnings:**
  - Side-panel search UX chain is complete: `/` → SearchBar (autocomplete + warnings + live count) → runQuery → live BookmarkItems with row actions intact; Ctrl/Cmd+K → palette (jump targets + commands + per-result actions over the same index).
  - Deferred to Phase 3: popup lazy index + Enter/Ctrl-Enter dispositions; `bm` omnibox (manifest key, fresh-per-session index, XML-escaped descriptions, ≤8 suggestions, disposition routing, no unopenable opens).
---

## [2026-09-26 17:05] - Phase 3 Task 1: Popup search
- **Implemented:** `Search.tsx` — combobox input + listbox ("Popup results"), top-10 `runQuery` hits, arrow/Enter nav, hover sets active, "Indexing…" while `search===null`, "No matches." when empty. `App.tsx` lazy-loads `listMeta`/`listTags` only after `ready` (first real paint), feeds `useSearchIndex`, and swaps the form for results while `searchQuery!==""` — form state lives in App so clearing restores it untouched. Opens route through `onOpen` → `openBookmarkUrl` (foreground / `current` on Ctrl/Cmd+Enter).
- **Files changed:** src/entrypoints/popup/Search.tsx (new), src/entrypoints/popup/App.tsx, tests/components/popup-search.test.tsx (new, 7 tests)
- **Commit:** 76a1f5b
- **Learnings:**
  - Pattern: popup search reuses `useSearchIndex` directly — the popup loads metas lazily post-paint (spec: "after first paint") instead of `useLiveQuery`, so the save form is never blocked.
  - Gotcha: "Indexing…" is untestable through `App` (build lands in a microtask); test it by rendering `PopupSearch` with `search={null}` prop directly.
  - Pattern: controlled `query` lifted to `App` is what makes "form returns unchanged on clear" work — the form unmounts during search but its state never left the parent.
---

## [2026-09-26 17:15] - Phase 3 Task 2: `bm` omnibox keyword
- **Implemented:** `src/search/omnibox.ts` — `escapeXml` (& < > " '), `toSuggestions` (≤8, openable-only, `title — <url>url</url>` escaped descriptions, `content`=URL), `loadSessionIndex` (getTree+listMeta+listTags → `buildSearchHandle`, total), `registerOmnibox` wiring the four listeners with session lifecycle + lazy build + emitted-content set. `wxt.config.ts` adds `omnibox.keyword="bm"`; `background.ts` calls `registerOmnibox()` (no-op when the surface is absent).
- **Files changed:** src/search/omnibox.ts (new), src/search/index.ts (ancestorsOf/toSourceBookmark extracted), src/search/run.ts (buildSearchHandle), src/ui/hooks/useSearchIndex.ts (uses shared mapping), src/entrypoints/background.ts, wxt.config.ts, tests/unit/omnibox.test.ts (18), tests/unit/manifest-commands.test.ts (+2)
- **Commit:** 7979a88
- **Learnings:**
  - Gotcha: `isOpenableUrl` is a DENYLIST — bare words ("fish") pass it, so entered-text vs suggestion-content can't be decided by the URL guard alone; keep a per-session set of emitted `content` strings instead.
  - Pattern: inject the omnibox surface + deps (`load`, `open`) into `registerOmnibox` — tests drive a fake listener bus with zero chrome globals, and the MV3 lazy-global stays optional for Firefox/tests.
  - Gotcha: `FolderNode` uses `childIds` (not `children`) plus `isRoot`/`isManaged`; `BookmarkItem` needs `isRoot`/`isManaged` too — hand-built FlattenedTree fixtures must carry all of them.
  - Gotcha: `chrome.omnibox.setDefaultSuggestion` takes `{description}` — `content` isn't required there even though SuggestResult has it.
---
