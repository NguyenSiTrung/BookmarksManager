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
