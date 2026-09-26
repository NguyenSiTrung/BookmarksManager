# Phase 2 Search — Implementation Plan

**Goal:** Ship local search from `PROJECT_PLAN.md` §15 Phase 2: MiniSearch index, query syntax with autocomplete, side-panel search bar, Ctrl/Cmd+K command palette, popup search, and the `bm` omnibox keyword.

**Spec:** `conductor/tracks/phase2_search_20260926/spec.md`; product constraints also live in `PROJECT_PLAN.md` §§5.1, 6, 12, 13, 14, and 15.

**Tech Stack:** WXT, React 19, Tailwind 4, strict TypeScript, Zod 4 (jitless), Dexie 4 + `dexie-react-hooks`, `radix-ui` primitives, `@tanstack/react-virtual`, **MiniSearch 7.2** (new), Vitest, Testing Library, Playwright.

## Global Constraints

- Zero network requests. `CONSENT_VERSION` does not change. No new permissions — only the `omnibox` manifest key (P3.T2).
- `src/search/` stays pure (no `chrome`, DOM, or React). Chrome access goes through typed `declare const chrome` slices.
- Import `z` only from `src/schemas/z.ts`. Parsers and message handlers are total.
- Per task: observe a failing test → implement → run narrow checks → update this plan and `learnings.md` → commit only intended files locally → `git notes add -m "…"` → close the mapped Beads task. Never push, pull, fetch, or `bd dolt push`.
- Phase-end tasks are **automated checkpoints**: run the full gate (`lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle` → `xvfb-run -a npm run test:e2e`), record evidence in `learnings.md`, and mark complete on green. The only user-verification gate is the last task of the track.
- Parallel execution: each worker owns only its annotated files in an isolated worktree. The coordinator serializes edits to shared files (`package.json`, `package-lock.json`, `wxt.config.ts`, `src/entrypoints/background.ts`, `src/entrypoints/sidepanel/App.tsx`, `store/*`), `plan.md`, `learnings.md`, Beads status, and commits/notes.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Query language | `src/search/query.ts`, `src/search/suggest.ts` | Total parser → typed AST + warnings; autocomplete |
| Index / executor | `src/search/index.ts`, `src/search/run.ts` | MiniSearch documents, boosts, diff updates; filters and ordering |
| Open actions | `src/search/openable.ts`, `src/sync/tabs.ts` | `javascript:`/`data:` guard; typed tabs slice |
| Side panel | `src/ui/hooks/useSearchIndex.ts`, `src/ui/components/query-input.tsx`, `src/entrypoints/sidepanel/{views.ts,SearchBar.tsx,palette.ts,CommandPalette.tsx,App.tsx}` | Search view, bar, autocomplete, palette |
| Popup | `src/entrypoints/popup/{Search.tsx,App.tsx}` | Popup search |
| Omnibox | `src/search/omnibox.ts`, `src/entrypoints/background.ts`, `wxt.config.ts` | Session index, XML-escaped suggestions, dispositions |
| Store docs | `store/{listing,reviewer-notes,privacy-policy,privacy-practices}.md` | Local-only search and `bm` keyword disclosures |

---

## Phase 1: Search core (pure)
<!-- execution: parallel -->
<!-- depends: -->

- [x] Task 1: Query parser — tokens, quotes, negation, typed AST, warnings (7bb3752)
  <!-- files: src/search/query.ts, tests/unit/search-query.test.ts -->
  - [x] Table-driven failing tests: every filter key, quoted values and phrases, `-` negation, unknown `key:` → free text (URLs), malformed dates/categories/empty values → warnings, `is:dead` → "not available" warning, never throws on arbitrary input
  - [x] Implement

- [x] Task 2: Index documents, build, incremental diff; add `minisearch` (be93aab)
  <!-- files: src/search/index.ts, tests/unit/search-index.test.ts, tests/fixtures/search.ts, package.json, package-lock.json -->
  - [x] Failing tests: document mapping (domain without `www.`, tag display names, notes, folder ancestors, dateAdded, category), field boosts, prefix + fuzzy matching, diff update (add/discard/replace) equals a full rebuild
  - [x] `npm install minisearch@^7.2.0`; implement

- [x] Task 3: Query executor — filters, AND/OR/negation, ordering (0e6ec6c)
  <!-- files: src/search/run.ts, tests/unit/search-run.test.ts -->
  <!-- depends: task1, task2 -->
  - [x] Failing tests: tag AND, single-valued-key OR, cross-key AND, negation, `folder:` subtree and `a/b` path, `domain:` subdomains, `before:`/`after:` boundaries in local time, `is:duplicate`/`is:untagged`, relevance vs tree order for filter-only queries, empty query
  - [x] Implement

- [x] Task 4: Autocomplete suggestions (de59303)
  <!-- files: src/search/suggest.ts, tests/unit/search-suggest.test.ts -->
  <!-- depends: task1 -->
  - [x] Failing tests: partial key → keys, values after `tag:`/`folder:`/`category:`/`is:`, quoting values with spaces, cursor-position replacement
  - [x] Implement

- [x] Task 5: Openable-URL guard and typed tabs slice (44a76cf)
  <!-- files: src/search/openable.ts, src/sync/tabs.ts, tests/unit/search-openable.test.ts, tests/unit/tabs.test.ts -->
  - [x] Failing tests: `javascript:`/`data:` rejected; open in current / new foreground / new background tab via `chrome.tabs.create`/`update`; absent and partial surfaces handled
  - [x] Implement

- [x] Task 6: 10k performance test (b3b6bd6)
  <!-- files: tests/unit/search-perf.test.ts -->
  <!-- depends: task3 -->
  - [x] Synthetic 10k fixture; assert median query < 50 ms and build < 500 ms

- [x] Task 7: Checkpoint — automated gate for Phase 1 (evidence in `learnings.md`) — green at b3b6bd6
  <!-- depends: task1, task2, task3, task4, task5, task6 -->

---

## Phase 2: Side-panel search and command palette
<!-- execution: sequential -->
<!-- depends: phase1 -->

- [x] Task 1: `useSearchIndex` hook with live incremental updates (adb06e5)
  <!-- files: src/ui/hooks/useSearchIndex.ts, tests/components/useSearchIndex.test.tsx -->
  - [x] Failing tests: builds from tree + metas + tagDefs; tree and meta changes update results without a full rebuild; unmount cleanup
  - [x] Implement

- [x] Task 2: Search view and search bar (b0a1406)
  <!-- files: src/entrypoints/sidepanel/views.ts, src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/App.tsx, tests/components/sidepanel-search.test.tsx -->
  - [x] Failing tests: `search` view kind; typing switches the view and clearing restores the previous one; `/` focuses and Esc clears; `aria-live` count; inline warnings; bulk actions on results; no drop slots
  - [x] Implement

- [x] Task 3: Shared query input with autocomplete (63690b2)
  <!-- files: src/ui/components/query-input.tsx, src/entrypoints/sidepanel/SearchBar.tsx, src/entrypoints/sidepanel/App.tsx, tests/components/query-input.test.tsx -->
  - [x] Failing tests: suggestion listbox, arrow/Enter selection, quote insertion, Esc closes suggestions before clearing the query
  - [x] Implement

- [x] Task 4: Command palette — dialog, results, jump-to (f1d61f9)
  <!-- files: src/entrypoints/sidepanel/palette.ts, src/entrypoints/sidepanel/CommandPalette.tsx, src/entrypoints/sidepanel/App.tsx, tests/unit/palette-items.test.ts, tests/components/command-palette.test.tsx -->
  - [x] Failing tests: Ctrl/Cmd+K opens; ARIA combobox; sections for bookmarks, views, folders, tags, categories; keyboard navigation; Esc restores focus
  - [x] Implement

- [x] Task 5: Palette commands and per-result actions (3502b03)
  <!-- files: src/entrypoints/sidepanel/palette.ts, src/entrypoints/sidepanel/CommandPalette.tsx, src/entrypoints/sidepanel/App.tsx, tests/components/command-palette-actions.test.tsx -->
  - [x] Failing tests: Import, Export, Tag manager, New folder, Undo, Options; Open, Ctrl/Cmd+Enter new tab, Reveal in folder, Edit, Copy URL (success + failure toast); open disabled for unopenable URLs
  - [x] Implement

- [x] Task 6: Checkpoint — automated gate for Phase 2 (evidence in `learnings.md`)

---

## Phase 3: Popup search and omnibox
<!-- execution: parallel -->
<!-- depends: phase1 -->

- [x] Task 1: Popup search (76a1f5b)
  <!-- files: src/entrypoints/popup/Search.tsx, src/entrypoints/popup/App.tsx, tests/components/popup-search.test.tsx -->
  - [x] Failing tests: lazy index after first paint ("Indexing…"), top-10 results replace the form and clearing restores it unchanged, Enter opens a new tab, Ctrl/Cmd+Enter the current tab, unopenable URLs disabled; existing `popup-save` tests stay green
  - [x] Implement

- [x] Task 2: `bm` omnibox keyword (7979a88)
  <!-- files: src/search/omnibox.ts, src/entrypoints/background.ts, wxt.config.ts, tests/unit/omnibox.test.ts, tests/unit/manifest-commands.test.ts -->
  - [x] Failing tests: session index built on `onInputStarted` and dropped on cancel/enter; ≤ 8 suggestions; XML escaping of `& < > " '`; disposition handling; free text opens the top result; never opens `javascript:`/`data:`; handlers total and log no query data; manifest declares `omnibox.keyword = "bm"`
  - [x] Implement

- [ ] Task 3: Checkpoint — automated gate for Phase 3 (evidence in `learnings.md`)
  <!-- depends: task1, task2 -->

---

## Phase 4: End-to-end, disclosures, and acceptance
<!-- execution: sequential -->
<!-- depends: phase2, phase3 -->

- [ ] Task 1: E2E search specs and zero-egress extension
  <!-- files: tests/e2e/search.spec.ts, tests/e2e/core-manager.spec.ts, tests/e2e/helpers/* -->
  - [ ] Side-panel search with a live update, palette keyboard flow, popup search opening a tab, zero egress with every search surface exercised (omnibox covered by unit tests; Playwright cannot drive the address bar)

- [ ] Task 2: Store documents for search and the omnibox
  <!-- files: store/listing.md, store/reviewer-notes.md, store/privacy-policy.md, store/privacy-practices.md -->
  - [ ] Describe local-only search, the `bm` keyword, and "queries are not stored or sent"; `check:manifest` green

- [ ] Task 3: Checkpoint — automated full gate for the track (evidence in `learnings.md`)

- [ ] Task 4: Conductor - User Manual Verification 'Phase 2 Search' (Protocol in workflow.md)
