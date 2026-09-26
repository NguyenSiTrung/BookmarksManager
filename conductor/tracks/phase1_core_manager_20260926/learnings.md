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
