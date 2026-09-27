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

## [2026-09-27 14:12] - Phase 3 Task 2: Rerank service
- **Implemented:** `src/decisions/rerank.ts` — `rerankSearch({query,hits,preset,model,client?,transport?})`
  → `{sent:false;reason:"empty"|"blocklisted"} | {sent:true;model;results:{id,probability}[];noMatch;usage}`.
  Projects hits via `rerankCandidates` (cap 30), minimizes each to a `SentBookmark`, builds the `rerank`
  set, sends ONE `jev_decisions` request, positionally cross-checks `candidate_<i>`, sorts by probability
  desc, applies `isNoMatch`, records one `usage` row. Own `RerankError` (codes ⊂ `DecisionPipelineErrorCode`).
- **Files changed:** `src/decisions/rerank.ts`, `tests/unit/decisions-rerank.test.ts`
- **Commit:** `9d6d176` (worker `82bd48fc`, wt/p4-p3t2 `d114ea2`) + fix `ad0a81e` (wt/p4-p3t2-fix1 `5d77ea8`);
  review APPROVED_WITH_CONCERNS → 1 fix round → re-review ALL FINDINGS ADDRESSED.
- **Learnings:**
  - **Ruling — per-service error classes are the convention; consumers must key on `.code`.** `RerankError`
    (not `DecisionPipelineError`) matches `DecisionStoreError`/`DecisionApplyError`/`JevClientError`. Its
    code set is a strict subset of the pipeline's, so the Task 4 message mapper must switch on `.code`,
    never `instanceof DecisionPipelineError`, or rerank errors are mishandled.
  - **Ruling — blocklisted-hit skipping + post-skip indexing is correct.** The `sent` (post-skip) array is
    the single source of truth for `candidateBookmarks`, question keys, cross-check bounds, and the
    probability lookup; raw shortlist indices are never used, so Chrome node ids stay local. Skipping is
    right (matches the pipeline dropping blocklisted bookmarks) rather than aborting.
  - **Test-quality gotcha — index-shift tests must place the blocklisted hit BEFORE the sendables.** With the
    blocklisted hit last, a raw-index implementation produces identical keys and passes. Pin the boundary
    with the blocklisted hit first and assert the exact key list (`["candidate_0","candidate_1"]`).
  - **Test-quality gotcha — an equal-probability tie-break test does NOT guard an explicit tie-break clause**
    because V8's `Array.prototype.sort` is stable. It characterizes the contract but would still pass if the
    `|| a.index - b.index` clause were deleted. Recorded as a deferred minor (not blocking).
  - **Deferred (filed `BookmarksManager-eov`):** neither `pipeline.ts` nor `rerank.ts` records `usage` when
    the response egressed but failed the answer cross-check — running cost totals undercount by that
    response. Cross-cutting (may need `client.ts` to expose accumulated usage on throw).

---

## [2026-09-27 14:00] - Phase 3 Task 1: Analyze pipeline
- **Implemented:** `src/decisions/pipeline.ts` — `analyzeBookmark(options)` orchestrates one bookmark:
  minimize → candidates → question sets → `jev_decisions` client → answer-ID cross-check → §10.2 policy →
  persist `Decision` rows + one `usage` row. All requested checks merge into ONE request/`DecisionState`
  (§9.1 "one request, many questions"); one usage row per call.
- **Files changed:** `src/decisions/pipeline.ts`, `tests/unit/decisions-pipeline.test.ts`
- **Commit:** `f198780` (worker `079605c6`, wt/p4-p3t1 `201476a`) + fix `64b6df3` (wt/p4-p3t1-fix1 `035430c`);
  review APPROVED_WITH_CONCERNS → 1 fix round → re-review ALL FINDINGS ADDRESSED.
- **Learnings:**
  - **Ruling — auto-apply status is `auto_applied`, not `applied`.** The schema, `store.ts`'s
    `LEGAL_TRANSITIONS` (`pending → auto_applied`), the store test, and the `policyAuditEvent` fixture all
    define policy-driven auto-apply as `pending → auto_applied` with `actor:"policy"`. `approveDecision`
    hard-coded `applied`, so the dedicated transition was dead and status-based auto-applied queries were
    impossible. Fix: `approveDecision(id, actor = "user", target: "applied"|"auto_applied" = "applied")`
    (default preserves `bulkApprove`/user callers); the pipeline passes `"auto_applied"`. Downstream UI/
    audit must key on this status, not on `actor`.
  - **Record the `usage` row before persisting decisions.** The request has already left the device (cost
    incurred) by the time persistence runs; a persist/apply failure must not drop per-request cost
    accounting (FR8). But the FR2 answer-ID cross-check still runs FIRST, so an `answer_mismatch` writes
    zero usage rows.
  - **Wrap the orchestration entry point in `toPipelineError`.** Task builders throw raw `TypeError`s and
    `mergeStates`/`DecisionState.parse` throw raw `ZodError` (whose `issues` can embed state values).
    A single outer try/catch keeps the "typed, redacted" contract and never attaches `cause`/state.
  - **Pattern — answer-ID validation is an independent value-level guard.** The client only type-checks
    answers; `crossCheckAnswers` re-validates raw answers against the candidates actually sent (category ∈
    sent `Category` values, folder choice ∈ sent ids ∪ `none`, every sent tag field answered `noul`).
  - **Deferred minor:** the pipeline's hardcoded `TAG_THRESHOLD = 0.5` duplicates the `tags` task's noul
    threshold; source it from the field if the task threshold ever changes.
  - **Unit-level gap (expected):** the pipeline tests inject a transport that bypasses the gate, so
    one-sentLog-row-per-egress is NOT exercised here — it belongs to the Phase 5 e2e.

---

## [2026-09-27 13:40] - Phase 2 Task 5: Automated checkpoint — FULL GATE GREEN
- **Gate evidence (main @ `7026979`):** `npm run lint` 0 errors (1 known warning) · `npm run typecheck`
  clean · `npx vitest run` **77 files / 2260 tests, all pass** (+127 vs Phase 1's 2133) · `npm run build`
  1.10 MB · `check:manifest` OK · `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**.
- **Note:** the `search-perf.test.ts` wall-clock gate flaked under parallel worker load (workers reported
  1–2 failures) but passes in the serialized full run — treat its failures as load artifacts, not
  regressions, unless they reproduce in isolation.
---

## [2026-09-27 13:35] - Phase 2 Task 4: Decision store, apply, and audit
- **Implemented:** `src/decisions/store.ts` (`persistDecision`/`listDecisions`/`listPending`/
  `transitionStatus` — the single audit writer, in one tx with the status write; `DecisionRow` = §7
  `Decision` + additive `guard`/`undoSnapshotId` sidecars) and `src/decisions/apply.ts` (approve/reject/
  revert/bulk approve through `bulkAddTag`/`bulkSetCategory`/`moveNode`/`mergeGroup`, each with an undo
  snapshot; stale + illegal-transition refusals; id-targeted compensating undo on status-write failure).
- **Files changed:** `src/decisions/store.ts`, `src/decisions/apply.ts`, both unit test files
- **Commit:** `f776738` + fix `7026979` (worker `wt/p4-p2t4`; review: Approved, 1 fix round)
- **Learnings:**
  - Patterns: the §7 `Decision` schema records no placement, so a `guard` sidecar (bookmark id →
    decision-time `parentId`) is the only way to detect "moved since" — and because `db.decisions` stores
    raw objects with no read-side parse, sidecars survive (a plain `z.object` would strip them on parse).
    One transactional `transitionStatus` primitive is the only audit writer, so "exactly one content-free
    audit row per change" is structural.
  - Gotchas: **mutation and status/audit write are separate transactions** (services open their own) — a
    failed status write could orphan an applied change; fix is an id-targeted compensating undo + typed
    `state_unrecorded`. A true single IDB transaction is unsafe here (awaiting non-Dexie async auto-commits
    it). `rollback()` must `discardById` the pushed snapshot, never `undoLatest`.
  - Ruling: `mark_dead`/`create_folder`/`rename` are intentionally `unsupported` (spec Out-of-Scope:
    1.1 / Phase 5) — documented in the module header, not an oversight.
---

## [2026-09-27 13:20] - Phase 2 Task 3: Dexie v3 — jobs, audit, usage

- **Implemented:** `version(3)` adds `jobs` (`id,status,createdAt`), `audit` (`++id,decisionId,changedAt`),
  `usage` (`++id,jobId,recordedAt`) + Zod schemas (`src/schemas/{job,audit,usage}.ts`) + `tests/fixtures/phase4.ts`
  + a genuine v2→v3 migration test; delete-all coverage asserted via `indexedDB.databases()` absence.
- **Files changed:** `src/db/database.ts`, `src/schemas/{job,audit,usage}.ts`, `tests/unit/database-v3.test.ts`,
  `tests/fixtures/phase4.ts` (+ verno assertions in `database.test.ts` / `database-v2.test.ts`)
- **Commit:** `2552cb0` (worker `wt/p4-p2t3`; review: Approved)
- **Learnings:**
  - Ruling: canonical `JobKind` literals are **snake_case** (`analyze_selection`, `library_scan`) — matches
    the `Decision` kind convention (`set_category`, `add_tags`). Downstream job/UI tasks must use these.
    Audit timestamp is `changedAt`; usage timestamp is `recordedAt` (downstream must use these names).
  - Patterns: derive `DecisionStatus` from `Decision.options[0].shape.status` rather than duplicating the
    union (the `Decision` union's options are a tuple type, so `options[0]` typechecks under
    `noUncheckedIndexedAccess`). `audit` is `strictObject` and a negative fixture proves bookmark content
    is rejected.
  - Gotchas: a "delete-all wipes the new tables" test must assert each new table's rows existed before the
    wipe (this task only asserted `jobs`). `cursor: undefined` in a fixture violates the conditional-spread
    convention even though the repo tsconfig does not enable `exactOptionalPropertyTypes`.
---

## [2026-09-27 13:10] - Phase 2 Task 2: Gate registration and strict state guard

- **Implemented:** replaced the fail-closed `jev_decisions` placeholder in `src/net/send.ts` with
  `admitsDecisionState(request, model)` — pins `request.model === model` first, then strict-parses
  `request.state` against `DecisionState`, then `isSensitiveUrl` over every URL field
  (`decisionStateUrls` covers bookmark/pairPartner/candidateBookmarks). `request_not_allowed` before any
  consent/permission/key read. 44 network-gate tests.
- **Files changed:** `src/net/send.ts`, `tests/unit/network-gate.test.ts`
- **Commit:** `045391a` + fix `0abeebb` (worker `wt/p4-p2t2`; review: 1 fix round)
- **Learnings:**
  - Gotchas: **the gate validated the `model` ARGUMENT against the preset allowlist but serialized
    `request.model`** — for `jev_test` the deep-equal guard pinned them, so the gap was invisible until a
    new scope reused the gate. Any scope guard must pin the body's model to the vetted argument, or the
    documented allowlist stage is decorative. `SystemOneRequest.model` is a bare `z.string()` (no `.min(1)`).
  - Patterns: guards are total and fail closed (non-object request, missing `state`, empty `{}` → refused).
    Prove guard-before-sensitive-reads by asserting the *error code* (`request_not_allowed`, not
    `no_consent`) plus `containsSpy`/`readKey`/`fetchSpy` call counts.
  - Ruling: top-level unknown request keys are stripped (wire parse stays non-strict), not rejected — FR1's
    "refuses unknown fields" is state-scoped and stripped keys never leave the device.
---

## [2026-09-27 13:00] - Phase 2 Task 1: jev_decisions consent scope, CONSENT_VERSION 2, store disclosures

- **Implemented:** `src/schemas/provider.ts` (`CONSENT_SCOPES` union + `ConsentScope`), `records.ts`
  (`revokeProviderConsents` deleting every scope via `allSettled` + typed `ConsentRevokeError`),
  `disclosure.ts` (typed decisions sent/never-sent/purpose/trigger constants), the five `store/*.md` docs,
  and `tests/unit/consent-snapshot.test.ts` (§13.12 tripwire binding sent fields to `CONSENT_VERSION`).
- **Files changed:** provider schema, consent records/disclosure, 5 store docs, consent tests (+ sanctioned
  edits to `src/net/send.ts` placeholder, `src/messages/provider.ts` revoke routing, e2e/unit version literals)
- **Commit:** `2f1456c` + `e9f4a6a` + fix `3c17af0` (worker `wt/p4-p2t1`; review: 1 fix round)
- **Learnings:**
  - Gotchas: **bumping `CONSENT_VERSION` breaks every test that hard-codes the old literal** — including
    e2e specs outside the task's owned files. Grep for `consentVersion` across `tests/` in the same task.
    Widening `ConsentScope` breaks `src/net/send.ts`'s `satisfies Record<ConsentScope, …>` — a fail-closed
    placeholder keeps the tree compiling until the real guard lands.
  - Patterns: derive revoke/iterate from `CONSENT_SCOPES` so future scopes are auto-covered; the consent
    snapshot test derives the field list from `DecisionState.shape` + disclosure constants so it can't
    silently miss a field.
  - Doc-drift discipline: §13.4 classifies bookmark title/URL/domain as **Web history** — the
    privacy-practices "Not collected" list must not still name web history once jev_decisions ships.
    Reviewer notes must not describe the strict guard as shipped while it is still a placeholder.
---


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

