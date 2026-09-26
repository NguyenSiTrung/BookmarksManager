# Track Learnings: phase1_core_manager_20260926

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list: `conductor/patterns.md` (35 entries, elevated from `phase0_foundation_20260925`). The ones most relevant to this track:

- Import `z` only from `src/schemas/z.ts` (jitless, MV3 CSP); never from `zod` directly.
- `fetch` is ESLint-banned outside `src/net/**`; Phase 1 features must not need it at all.
- `runtime.onMessage` handlers are total: return `{ok:true,…} | {ok:false,code,message}` Zod unions, never throw or leak `cause` objects.
- Testing `chrome.*` in Vitest: a `declare const chrome` slice keeps `vi.stubGlobal` workable without fighting the DOM lib.
- Dexie `add`/`put` writes a generated inbound key back onto the caller's object; always write fresh object copies.
- Zod 4 `.refine`/`.check` still run after a failed base check; wrap throwing ops like `new URL()` in try/catch inside refines.
- Type shared fixtures with `satisfies z.input<typeof Schema>`; keeps `.default()` fields absent.
- `chrome.permissions.request` needs a user gesture: call it synchronously in the click handler.
- Keep `store/permissions.md` justifications aligned with actual call sites (grep before trusting docs); `check:manifest` compares it to the generated manifest.
- RTL with `globals: false`: set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually; prefer `findByRole`/`aria-label` queries.
- Playwright: `channel: "chromium"` (branded Chrome ignores `--load-extension`), persistent context + `waitForEvent("serviceworker")`, zero-egress assertions after `context.close()`.
- Bundle scanners scan normalized whole-file content, not lines.

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-26 04:36] - Phase 1 Task 1: Typed `chrome.bookmarks` slice and in-memory fake
- **Implemented:** `src/sync/chrome-bookmarks.ts` + `tests/fakes/chrome-bookmarks.ts` (62 tests).
- **Commit:** `6dc73ce` (landed from worktree `wt/p1t1`)
- **Learnings:**
  - Exported surface consumed by later tasks: `ChromeBookmarksApi` type, `ROOT_NODE_ID`/`BOOKMARKS_BAR_ID`/`OTHER_BOOKMARKS_ID`/`MOBILE_BOOKMARKS_ID`/`FIXED_ROOT_IDS`, `isFixedRoot`/`isFolder`, async wrappers `getTree/getSubTree/get/getChildren/create/update/move/remove/removeTree`, subscribe helpers `onCreated/onChanged/onMoved/onChildrenReordered/onRemoved` returning unsubscribe fns. Fake: `createFakeBookmarks`/`installBookmarksFake`, `simulateChildrenReordered`, `install()`.
  - Locked semantics: events emit synchronously before promise resolution; `onRemoved` fires once with recursive `node`; `get`/`getChildren` return shallow nodes; managed/root writes reject plain `Error`s; `create` defaults `parentId` to `"2"`.
  - Gotcha: managed/root error message strings are our contract, not byte-verified vs real Chrome — callers must guard via `isFixedRoot`/`unmodifiable`, not message matching.
---

## [2026-09-26 04:44] - Phase 1 Task 3: Dexie v2 tables and migration
- **Implemented:** `version(2).stores()` — `bookmarkMeta` (`id,*tags,category,updatedAt`), `tags` (`nameKey`), `undo` (`++id,createdAt`); v1 untouched.
- **Commit:** `015711f` (landed from worktree `wt/p1t3`)
- **Learnings:**
  - Migration test pattern: seed a genuine v1 DB via standalone `Dexie` with only `version(1).stores`, close, reopen with the real class; assert `verno` 2 and rows preserved.
  - Declaring `version(2)` mechanically bumps `Dexie.verno` — existing schema-shape tests asserting verno/table-list must be updated in the same commit.
  - `undo.add()` writes back `++id` onto the caller's object — pass fresh copies (same gotcha as Phase 0).
---

## [2026-09-26 05:12] - Phase 1 Task 5: Metadata repository
- **Implemented:** `src/db/meta.ts` (56 tests).
- **Commit:** `a0e4d17` (landed from worktree `wt/p1t5`)
- **Learnings:**
  - Exported API consumed by Phase 2+: `getMeta`, `getMetaByIds`, `listMeta`, `getMetaByTag`, `getMetaByCategory`, `putMeta`, `patchMeta`, `deleteMetaByIds`, `getTag`, `listTags`, `createTag`, `updateTag`, `recolorTag`, `renameTag`, `deleteTag`; errors `MetaRepoError`/`MetaRepoErrorCode` (`"tag_exists"|"invalid_tag"|"invalid_meta"`); types `MetaPatch`, `TagPatch`, `TagCreateOptions`, `RenameTagResult`.
  - Locked semantics: `patchMeta` on missing id creates (lazy-create); patch `null` clears a field vs absent leaves untouched; Zod `safeParse` on every read AND write (invalid read ⇒ absent, silent); tag rename/delete propagates through `*tags` inside a transaction with rollback on collision.
  - Gotcha: no referential integrity — metas may hold orphan nameKeys; tag-ops must check `listTags` if "known tags only" is required.
---

## [2026-09-26 04:52] - Phase 1 Task 7: Tree read model and live hook
- **Implemented:** `src/sync/tree.ts` `flattenTree` + `src/ui/hooks/useBookmarkTree.ts` (18 tests).
- **Commit:** `130b790` (landed from worktree `wt/p1t7`)
- **Learnings:**
  - `flattenTree(tree)` → `FlattenedTree { folders: Map, bookmarks: Map }`; entries carry `path` (ancestor titles, root "0" excluded), `childIds` in Chrome `index` order, `isRoot` (= `isFixedRoot`), `isManaged` (self-or-ancestor `unmodifiable`), `depth`; deterministic DFS pre-order iteration.
  - `useBookmarkTree()` refetches `getTree()` on any of the five events (O(tree) per event — documented future optimization point); generation counter for last-write-wins; unsubscribes all on unmount.
  - RTL: prove unsubscribe with `hasListener`/`addListener` spies on the fake, not just "no updates after unmount".
---

## [2026-09-26 04:23] - Phase 1 Task 2: Schemas — BookmarkMeta, TagDef, UndoSnapshot, ExportEnvelope v1
- **Implemented:** `src/schemas/{meta,undo,export}.ts` + fixtures + `schemas-phase1.test.ts` (65 tests).
- **Commit:** `ae4c4ff` (landed from worktree `wt/p1t2`)
- **Learnings:**
  - Exported API consumed by later tasks: `tagNameKey`/`TagNameKey` (nameKey = `name.trim().toLowerCase()`; TagDef superRefine pins `nameKey === tagNameKey(name)`), `TagDef`, `BookmarkMeta` (tags are nameKeys, not display names), `UndoKind` (`"delete"|"bulk_move"|"merge"|"tag_delete"`), `UndoNode` (recursive children via Zod-4 getters — works under jitless), `UndoMeta` (aliases BookmarkMeta), `UndoSnapshot` (`tagDef` required only for `tag_delete`), `ExportTreeNode` (`id` is a join key for meta remap — never reuse as real Chrome ids on import), `ExportEnvelope` (`version: z.literal(1)`).
  - `z.strictObject()` on all six schemas — secret-bearing keys (`keys`, `apiKey`, `providerSettings`, `consents`, `sentLog`, `keyMaterials`, `decisions`) fail at every nesting level.
  - Context: strict objects mean Dexie writers can't attach extra fields — inbound `++id`/`id`/`nameKey` write-backs are all schema fields, safe.
---

## [2026-09-26 04:23] - Phase 1 Task 4: URL normalization and duplicate grouping
- **Implemented:** `src/duplicates/{normalize,group}.ts` (86 tests across two files).
- **Commit:** `726e1b6` (landed from worktree `wt/p1t4`)
- **Learnings:**
  - `normalizeUrl(raw): string | null` — normalized key is scheme-free `[userinfo@]host[:port][/path][?query]` so http≡https holds; `null` for invalid AND non-http(s) URLs (exact-only participation).
  - Tracking drop list: `utm_*` prefix + `dclid, fbclid, gbraid, gclid, mc_eid, msclkid, ref, wbraid` (case-insensitive). `ref` is aggressive by design.
  - `groupDuplicates<T extends DuplicateCandidate>(items): DuplicateGroup<T>[]` — exact groups before normalized; normalized bucket suppressed only when member-id set is identical to an emitted exact group; ordering by key first-seen.
  - Gotcha: `http://x:443` ≠ `https://x` (per-scheme default-port reading); suppression assumes unique ids.
---

## [2026-09-26 05:35] - Phase 1 Task 6: Worker sync — cascade delete, reconcile, broadcast, `bookmarks` permission
- **Implemented:** `src/sync/{listeners,reconcile}.ts`, wired into `background.ts`; `bookmarks` permission in wxt.config + permissions.md.
- **Commit:** `a47b2d7` (landed from worktree `wt/p1t6`)
- **Learnings:**
  - `registerBookmarkListeners()` idempotent per `chrome.bookmarks` instance via WeakMap; `BookmarksChangedMessage`/`BookmarksChangedEvent` Zod schemas; `BOOKMARKS_CHANGED_TYPE` constant.
  - `reconcileMetadata(): Promise<number>` diffs `getTree()` ids vs raw `bookmarkMeta` keys (reaps schema-invalid dead rows too).
  - Broadcast for `"removed"` fires AFTER cascade delete resolves; other events broadcast synchronously, fire-and-forget.
  - Deviation accepted: `tests/unit/scaffold.test.ts` permission assertion updated — same precedent as T3's verno assertion.
---

## [2026-09-26 05:38] - Phase 1 Task 8: Checkpoint — automated gate
- **Gate evidence (main @ a47b2d7 + docs):**
  - `npm run lint` — clean (after adding `.worktrees/**` to eslint ignores: eslint does not honor .gitignore; nested `.wxt`/`.output`/`.agents` copies inside worktrees were linted until excluded)
  - `npm run typecheck` — clean
  - `npx vitest run` — **614/614 tests, 24 files**
  - `npm run build` — clean (chrome-mv3, 662 kB)
  - `npm run check:manifest` — manifest permissions match store/permissions.md
  - `npm run check:bundle` — no eval/new Function/remote script
  - `E2E_HEADLESS=1 npm run test:e2e` — 1/1 pass (extension loads, renders surfaces, zero requests)
- **Phase-1 scope review:** dispatched code reviewer over diff aba1987..HEAD (5668 insertions) — see ledger.
---

### Checkpoint addendum — phase review fix round
- Phase-scoped review found 2 Important findings (partial `chrome.bookmarks` surface sync-throwing in `registerBookmarkListeners` and `useBookmarkTree` — both violating their own no-throw contracts) + 1 Minor fixture inconsistency.
- Fix round 1 landed `0c8ce07` + `4e84961`: sequential-push subscriptions under try/catch with cleanup (a single `push(f(), g())` evaluates all args before pushing — leaks earlier listeners on throw), async `refresh` so sync throws become caught rejections, consistent undo fixture. 98/98 scoped tests green; lint + typecheck clean.
- **Pattern worth elevating:** lazy `declare const chrome` slices throw SYNCHRONOUSLY on absent surfaces — every caller boundary (event subscriptions, effect bodies, startup registration) needs try/catch or an async wrapper, and tests should cover absent AND partial surfaces.
---
---

## [2026-09-26 07:10] - Phase 3 Tasks 1–4: Import/export formats + planner
- `src/io/export-json.ts` (5c2751c): version-1 strict `ExportEnvelope`; Chrome ids are join keys only; whole-library export unwraps synthetic root `"0"`; folder-scope omits orphan meta; two-space JSON + trailing newline.
- `src/io/netscape.ts` (cccb3fc): DOMParser-only parsing (no innerHTML); 20 MiB `MAX_FILE_BYTES`; blocks `javascript:`/`data:`/`vbscript:` incl. whitespace/entity obfuscation; exports valid Netscape.
- `src/io/csv.ts` (09b4a4d): exact 7 columns; formula-injection escaping (`= + - @ TAB CR`) BEFORE quoting, no pre-trim; per-row validity; http(s)-only; blank rows skipped.
- `src/io/import-plan.ts` + `import-write.ts` (99d3d07): pure `planImport` (preview counts, zero writes); normalized-URL dup skip with `importDuplicates` override + in-file dedupe; dated root under Other bookmarks; meta via separate `putMeta` for failure attribution; tag defs nameKey-restored; undo = `removeTree(importRoot)`.
---

## [2026-09-26 07:58] - Phase 3 Task 5: Checkpoint — gate + phase review
- **Gate evidence (main @ 57bf2f8):** lint clean · typecheck clean · **862/862 tests, 30 files** · build clean · check:manifest OK · check:bundle OK · e2e skipped (no entrypoint/UI changes this phase).
- **Phase-3 review: CHANGES REQUESTED → fixed in `57bf2f8`** (9 files): 20 MiB cap on `parseCsv`/`parseExport`; `writeImport` re-checks blocked/empty URLs so raw `ImportItem[]` cannot bypass the planner; `buildExport`/`serializeExport` now return result unions (`ExportError` class deleted); Netscape orphan `<DT>`/`<A>` rows parsed via `walkedDl` dedupe set; `MAX_TREE_DEPTH=64` guards Zod recursion + `safeParse` wrapped; CSV `/`-in-folder-name limitation documented; single shared `isBlockedScheme` exported from netscape.ts.
- **Pattern worth elevating:** every fallible IO entry point returns `{ok}|{ok:false,code,message}` — no thrown error classes; defense-in-depth belongs at BOTH planner and writer (never trust the caller to have planned).
