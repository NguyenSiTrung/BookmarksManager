# Track Learnings: phase4_jev_decisions_20260927

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Read `conductor/patterns.md` before each task. It already consolidates Phases 0–3, including the
elevated `phase3_jev_client_20260927` patterns. The ones most relevant to this track:

- **Scoped consent gates validate cheap-before-sensitive.** Scope registration and the scope's request
  guard run before consent rows, permissions, or key material are read. Extend the frozen registry, never
  the caller. Prove short-circuits with dependency-spy call counts.
- **Fail-closed gates re-verify per call:** preset → model → https → origin → consent → host permission →
  key on every send.
- **Mutation ordering for irreversible pairs:** enable writes settings → key → consent (consent last);
  revoke removes consent first.
- **Keep domain layers pure:** `src/<domain>/` modules import no chrome/DOM/fetch and expose a typed
  contract; surfaces consume them.
- **Definition-time validation throws `TypeError`;** only run-time answer problems use the domain error
  taxonomy. Choice 2–255 options and score 2–10 levels are enforced at declaration.
- **`noul` confidence is a margin, not a probability** (`noulMargin(p, t)`).
- **Playwright can route MV3 worker `fetch`** with `context.route(...)`, but `chrome.permissions.request`
  never resolves under Playwright; use the manifest-copy workaround in `tests/e2e/helpers/provider.ts`.
- **Snapshot-then-mutate:** undo replay must be idempotent and resumable; discard by row id, never
  "latest"; serialize stack operations.
- **Read-modify-write belongs inside the row's transaction.**
- **Dexie migration test pattern:** seed a genuine vN-1 database, reopen with the real class, assert
  `verno` plus preserved rows; update verno/table-list assertions in the same commit.
- **IndexedDB read-assertions must not create the db** (`indexedDB.databases()` first).
- **Doc-drift discipline:** store disclosures must match `src/consent/disclosure.ts` constants nearly
  verbatim; grep actual call sites before trusting permission justifications.
- **Egress assertions filter OUT internal schemes** rather than matching only `http(s)`; assert after
  `context.close()`.
- **Module-level shared state needs an exported reset hook** (e.g. `resetJevClientPools()`).
- **`exactOptionalPropertyTypes`:** conditionally spread optional fields, never assign `undefined`.
- **Parallel-worktree recipe:** one `.worktrees/` worktree per task with hardlinked `node_modules`/`.wxt`,
  disjoint file sets, and one coordinator serializing commits, notes, plan markers, and `bd` updates.

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-27 12:40] - Phase 1 Task 5: Automated checkpoint — FULL GATE GREEN
- **Gate evidence (main @ `696c5e3`):** `npm run lint` 0 errors (1 known `react-hooks/incompatible-library`
  warning on the TanStack virtualizer call) · `npm run typecheck` clean · `npx vitest run` **73 files /
  2133 tests, all pass** (+344 vs Phase 3 baseline 1789) · `npm run build` 1.09 MB · `check:manifest` OK ·
  `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**.
- **Parallel execution notes:** 4 workers in `.worktrees/p4-p1t{1..4}` on `wt/p4-p1tN` branches with
  `cp -al` hardlinked `node_modules`/`.wxt`; disjoint file sets → clean cherry-picks; coordinator (this
  session) serialized commits, notes, plan markers, and all `bd` updates.
- **Checkpoint-fix learnings:**
  - Workers were told NOT to run lint in their worktrees (hardlinked-deps caution) — which let a
    `no-control-regex` error reach the checkpoint. **Ruling:** focused `npx eslint <owned files>` in the
    worktree is safe and must be part of the worker loop from Phase 2 on.
  - `no-control-regex` bans `/[\x00-\x20\x7f]/`; a code-point loop is the lint-safe equivalent (no
    eslint-disable). Any "reject literal control/whitespace bytes" check should use the loop form.
  - Cross-task integration contradiction (caught in p1t4 review, not the pre-flight scan): `misfiled`
    can emit 51 folder candidates while `DecisionState` capped at 50 → gate would refuse. Ruling: cap is
    `.max(51)` = 50 ranked + FR3's guaranteed current folder.
---

## [2026-09-27 12:30] - Phase 1 Task 1: DecisionState schema and data minimization
- **Implemented:** `src/schemas/decision-state.ts` (closed strict `DecisionState`: `SentBookmark`,
  `CandidateTag`, `CandidateFolder`, `candidateBookmarks` for rerank; `CleanedUrl` = semantic cleanliness,
  no query/fragment/userinfo, rejects `[\x00-\x20\x7f]`, max 2048) and `src/decisions/minimize.ts`
  (`cleanUrl` via WHATWG setters, frozen `BUILTIN_SENSITIVE_SITES` + `userBlocklist` param, fails closed on
  unparseable/hostless URLs). 249 tests after the fix round.
- **Files changed:** `src/schemas/decision-state.ts`, `src/decisions/minimize.ts`, both unit test files
- **Commit:** `4f2c5d4` + fix `7716a29` (worker `wt/p4-p1t1` `4c0541d`, `c0cd218`; review: 1 fix round, then all findings addressed)
- **Learnings:**
  - Gotchas: **WHATWG lowercases hostnames only for "special" schemes** — opaque-scheme hosts keep case, so
    `isSensitiveUrl("foo://CHASE.COM/")` was a silent fail-open until `canonicalHost` case-folded and
    `canonicalUrlHost` re-canonicalized opaque hosts through a guarded `https://` reparse (also closes
    `foo://0x7f.1/` and percent-encoded IDN). Any host-suffix/allowlist matching must canonicalize per
    scheme. URL parser silently strips tab/newline → reject literal ASCII whitespace/control bytes up front.
  - Patterns: `SentBookmark` superRefines `domain === new URL(url).hostname` so url/domain disagreement is
    unrepresentable. `minimizeBookmark` guards the 2048 cap so "output always parses" stays honest.
  - Context: the deviation adding `candidateBookmarks?: SentBookmark[]` is sound — the gate strict-parses
    `state`, so rerank candidate URLs are `CleanedUrl`-validated there instead of in question instructions.
    `SentBookmark` drops node ids; answers bind positionally.
---

## [2026-09-27 11:05] - Phase 1 Task 2: Candidate pre-filters
- **Implemented:** `src/decisions/candidates.ts` — `tagCandidates` (cap 30, keyword+domain-overlap with
  tag⇄domain co-occurrence), `folderCandidates` (cap 50 + `none`, root `"0"`/managed excluded as targets),
  `misfiledCandidates` (current folder guaranteed, can reach 51+none), `nearDuplicatePairs` (same domain +
  title Jaccard ≥0.5, exclusion via real `groupDuplicates` call), `rerankCandidates` (top-30 `runQuery`).
  35 tests.
- **Files changed:** `src/decisions/candidates.ts`, `tests/unit/decisions-candidates.test.ts`
- **Commit:** `fcd902d` (landed from worktree `wt/p4-p1t2`, worker commit `c5f4be8`; review: Approved)
- **Learnings:**
  - Patterns: near-dupe exclusion calls the real `groupDuplicates` rather than re-implementing — exclusion
    can never drift from the local detector. Sorts end in nameKey/id code-unit tie-breaks → total order,
    permutation-invariant (stronger than stable sort; serves snapshot/option-key reproducibility).
  - Gotchas: `nearDuplicatePairs` is O(k²) per domain bucket → filed `BookmarksManager-w6y` (token
    inverted-index prefilter or job-level chunking). Empty/whitespace titles normalize to identical `""` →
    similarity 1.0 pairs; harmless (Jev judges by URL) but noted. Pipeline consumers must NOT send the
    `score`/`titleSimilarity` ranking fields — they're code-side only.
  - Context: candidates define their own types; p1t4's question sets and p3t1's pipeline adapt them into
    `DecisionState`.
---


## [2026-09-27 10:55] - Phase 1 Task 3: Confidence policy
- **Implemented:** `src/decisions/policy.ts` — §10.2 bands via a `PolicyInput` discriminated union
  (`occasion` required only for `kind:"move"` — distinguishes on-save pre-select from misfiled scan),
  `AutoApplyToggles` strict-limited to `add_tags`/`set_category`, `RERANK_NO_MATCH_BAR = 0.5` + `isNoMatch`,
  `escalateToLlm` stub resolving `"unsure"`. 30 boundary tests.
- **Files changed:** `src/decisions/policy.ts`, `tests/unit/decisions-policy.test.ts`
- **Commit:** `da4f2f9` (landed from worktree `wt/p4-p1t3`, worker commit `25c1825`; review: Approved)
- **Learnings:**
  - Patterns: model per-kind policy as an exhaustive switch over `Decision["kind"]` — adding a kind to the
    schema later produces a compile error, not a silent fallthrough. Restricting toggle KEYS to the two
    toggleable kinds makes `{autoApply:{move:true}}` fail validation structurally.
  - Ruling: `rename` (omitted from §10.2) grouped with the never-auto-apply review≥0.5 band — "actions that
    alter data always require the user"; pin or revisit if Phase 5's LLM rename needs different handling.
  - Gotchas: `isNoMatch` treats `NaN` probabilities as matches (`NaN < bar` is false) — documented
    conservative direction; pipeline must not feed NaN. Repo tsconfig lacks `exactOptionalPropertyTypes`
    (only `.wxt` has verbatimModuleSyntax+noUncheckedIndexedAccess) — conditional-spread discipline is
    still the convention.
---

