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

## [2026-09-27 18:40] - Phase 4 Task 6: automated checkpoint

- **Gate (main @ `31eb12b`)**: lint 0 errors (1 pre-existing TanStack warning) · typecheck clean ·
  `npx vitest run` **92 files / 2466 tests pass** · build 1.20 MB · `check:manifest` OK ·
  `check:bundle` OK · `xvfb-run -a npm run test:e2e` **13/13 pass**.
- The checkpoint (first e2e run since Phase 3) caught a **pre-existing** strict-mode ambiguity from
  P4.T1: `getByLabel("Provider")` substring-matches BOTH the "AI provider connection" region and the
  new "Data sent to providers" section. Lesson: when a page gains a second section whose accessible
  name contains an existing section's label word, substring-based `getByLabel` locators break in
  strict mode — prefer `getByRole("region", { name })` with the full name (fixed in `31eb12b`).
- `tests/unit/search-perf.test.ts` remains a wall-clock flake under full parallel load (613 ms vs the
  500 ms budget observed once this session; passes isolated). Pre-documented; not a regression.

## [2026-09-27 18:15] - Phase 4 Tasks 4-5 fix rounds: job-intent wiring at the worker boundary

- **A panel that renders the row must never race the row's first read.** `useLiveQuery`'s initial
  `undefined` means "read pending", NOT "no row" — collapsing the two let Start fire while a live row
  was still unread. Fix: the querier itself returns `JobDocument | null` (a null sentinel; a failed
  read degrades to `null` too), so `undefined` survives ONLY as useLiveQuery's pending signal and
  Start can key `disabled` off it. The three pre-existing tests that clicked Start synchronously after
  render had to learn `await waitFor(disabled === false)` first — that update was the point, not
  test-weakening (the re-reviewer empirically confirmed jsdom swallows clicks on the disabled button).
- **Job intents are egress-gated like every other decisions handler.** `JOB_START` and `JOB_RESUME`
  call `requireActiveProvider()` BEFORE any row mutation: `runPersistedJob` deliberately returns
  silently when no provider is active (right for restart resume), so an un-gated user intent would
  flip a row to Queued/Running that nothing ever drives. The refusal is the same typed
  `invalid_input` message the panel renders verbatim. The four copies of that message collapsed into
  one `requireActiveProvider()` helper.
- **Resume must relaunch, and the relaunch must re-check the row.** A paused job's runner loop
  already returned at its batch boundary, so `JOB_RESUME` = flip + fire-and-forget
  `relaunchJob(id)` (an injectable `ProductionHandlersDeps` seam, defaulting to `runPersistedJob`,
  mirroring `ResumeJobsDeps`). And `runPersistedJob` only drives `running`/`pending` rows: a pause
  landing between the caller's flip and the relaunch's read wins — otherwise the runner's own
  `setJobStatus("running")` (legal from `paused`) would un-pause it and drive egress the user halted.
- **Surface caller-error strands as `failed` rows.** A `JobRunnerError` from `runner.run` (work-set
  mismatch — e.g. a bookmark deleted while paused; validation throws before any egress) used to be
  swallowed by the fire-and-forget `.catch`, stranding a live-looking row. Now it is marked `failed`
  with the (static, redacted) message under the runner's own discipline — only a still-`running` row
  may fail, and `pending` passes through `running` first because `pending → failed` has no legal
  edge; a concurrent pause/cancel still wins. Non-`JobRunnerError` (transport/context) stays
  retry-on-next-start.
- **Rerank verdicts are untrusted input to the list.** `applyRerankOrder` must rank a repeated id
  ONCE — per-occurrence pushes duplicated the row and (via the unranked filter) silently DROPPED an
  unranked result, breaking the pure-permutation contract. One `rankedIds.has(id)` skip guard, tested
  end-to-end through App with a `[b2, b2, b1]` verdict.
- **Dispatch the settled form of a query.** The Ask debounce now sends `query.trim()` and tags the
  reply with the same settled value the render-time note compares against — the provider never sees
  trailing whitespace, and the note keeps answering the raw input.
- Re-review of a fix round found the SAME defect class the original review caught, one path over:
  JOB_START was gated but JOB_RESUME wasn't. When a fix introduces a "flip then drive" sequence,
  audit every pre-existing silent-return between the flip and the drive.
- Deferred to Phase 5 Task 1 e2e (re-review Minor 7): the default relaunch (`runPersistedJob` with a
  live provider) is seam-tested only; the resume relaunch must be exercised end to end.

## [2026-09-27 17:05] - Phase 4 Tasks 4-5: ScanPanel + Ask toggle (worker landings)

- `ScanPanel.tsx` takes MINIMIZED rows (`{id, title, url}`) — `id` is exactly what `JOB_START` sends
  and `{title, url}` exactly what `estimateJobCost` folds; notes never enter the work set. The
  estimate says "at least ~N tokens across M batches" because it excludes the fixed question
  scaffolding the pipeline adds per request.
- The panel keeps NO shadow job state: one `useLiveQuery` over the latest `library_scan` row by
  `createdAt` drives progress/usage/status, so a reopened panel (or worker restart mid-run) renders
  the persisted state with zero local bookkeeping. Mutations are protocol intents only; the echoed
  `job` in a reply is never rendered — only the live row is.
- "New scan" on a terminal card dismisses THAT row id locally (rows are never deleted); a NEW later
  row always re-opens the card — pinned by a test that seeds a second row with a later `createdAt`
  after dismissing the first.
- `ask.tsx` is a state/logic hook (`useAskSearch`) + pure note mapper (`askNoteText`); SearchBar
  renders both. The toggle is consent-gated by a live `db.consents` read at the CURRENT
  `CONSENT_VERSION` (a stale-version row must not show it), visibility-only — the worker re-verifies
  before any send. One `RERANK` per settled query (350 ms debounce), stale replies dropped by a
  request-counter ref, `{sent:false}` is NOT an error (quiet skipped note), and Ask-off never sends
  or reports an order.
- App tags each reported order with the query it answered; the `items` memo applies the permutation
  only when `rerankOrder.query === activeView.query`, so a pending or stale verdict can never
  permute a different query's results. MiniSearch default semantics: AND across terms with prefix
  matching (a test query "not" prefix-matches "notes").

## [2026-09-27 16:50] - Phase 4 Task 3: Side-panel Review view + Analyze actions

- `ReviewView.tsx` (new) renders the pending-decision queue; `views.ts` gains a `review` kind whose
  `resolveView` returns `[]` (its rows are `Decision`s, not `BookmarkItem`s); `App.tsx` branches
  review→`ReviewView`, duplicates→`DuplicatesView`, else `BookmarkList` — the `DuplicatesView` precedent.
  Returning `[]` also empties the shared selection so the bookmark `BulkBar` stays out of the pane.
- Confidence bands are **pinned to the policy constants** (`AUTO_APPLY_THRESHOLD` 0.85 /
  `REVIEW_FLOOR` 0.5), and rendered as a stripe + tint + a `High · 92%` chip — never color-only.
- Actions gate on `isLegalTransition(status, …)` so the UI never offers an illegal move; bulk approve is
  ONE `BULK_APPROVE` reporting `applied`/`failed`.
- **Undo wiring (arm/disarm)**: `reportToast` disarms a stale revert target on EVERY toast;
  `armDecisionRevert` re-arms after the approve toast is shown; the toast's Undo sends `REVERT_DECISION`
  for the armed id else falls through to `toastCtl.undo()` (snapshot stack), so delete/merge/tag toasts
  still work.
- **Synthetic-id exclusion (cross-task fix)**: save-suggest persists `pending` rows keyed by a
  `popup:<uuid>` id that never becomes a real bookmark. `reviewQueue()` drops any decision whose
  `bookmarkIds` contain a `popup:`-prefixed placeholder (and the badge uses the same helper), with a
  visible "· N waiting on an unsaved bookmark" count so nothing is hidden silently. Scoped to the
  `popup:` namespace ONLY — a genuinely-gone REAL id still renders with a "Stale" affordance and stays
  approvable (the worker's `assertFresh` guard refuses it).
- Shared decision helpers (`sendDecisionMessage`/`analyzeOutcome`/`analyzeResultMessage`/`reviewQueue`/
  `confidenceBand`) live in `ReviewView.tsx` and are imported by `BulkBar`/`App` (same precedent as
  `BulkBar`'s delete helpers). Deferred: extract to a pure `decisions/panel.ts` if T4/T5 add more.

## [2026-09-27 16:40] - Phase 4 Task 2: Popup save suggestions

- `Suggestions.tsx` (new) + `App.tsx` wiring. The trigger is `SAVE_SUGGEST`; **the reply carries only
  counts** (`AnalyzeSummary`), so the actual suggestions are read back from `db.decisions` filtered by the
  synthetic `"popup:<uuid>"` `bookmarkIds` (status `pending` only — `listPending()`), and the popup
  pre-selects the folder only at `≥ MOVE_PRESELECT_THRESHOLD` (0.7).
- **Never override a user edit**: touched-flag refs (`folderTouchedRef` set synchronously in the picker's
  onChange, even when re-picking the default) — stronger than default-value comparison, which can't detect
  a re-pick of the same value.
- **One-shot effect hygiene**: the SAVE_SUGGEST effect must depend on `[ready, suggestId]` (stable per
  mount) and read `title`/`url`/`folderId` at send time from a ref — NOT close over them, or a keystroke
  re-runs the effect, its cleanup sets `cancelled = true`, and the in-flight request/reply is torn down.
  (A render-time ref assignment is rejected by `react-hooks/refs`; keep the ref in sync with a preceding
  effect.)
- **Worker-side fix (Important)**: `saveSuggest` ran the pipeline under the user's real `settings`, so a
  toggled-on `add_tags`/`set_category` at ≥0.85 auto-applied to the nonexistent `popup:` id → the guarded
  apply failed `bookmark_gone` → `apply_failed` → the whole suggestion was lost AND the row landed
  `auto_applied` (not `pending`) so no chip showed. Fix: `saveSuggest` runs under
  `SAVE_SUGGEST_SETTINGS` (a complete `DecisionSettings` with every toggle off) → policy can only return
  `preselect`/`review`/`unsure`. The real `analyzeById`/library paths keep the user's settings (§10.2).
- Consent gate is a local `hasConsent(DECISIONS_CONSENT_SCOPE, preset)` across presets — no `sendMessage`
  at all without a `jev_decisions` grant. Blocklisted → a quiet `suggestions-not-sent` note, no chips.
- Deferred: orphaned synthetic `popup:` rows accumulate (no `db.decisions` retention) —
  `BookmarksManager-f7c`.

## [2026-09-27 16:30] - Phase 4 Task 1: Options decisions UI (consent, toggles, blocklist, sent log, cost)

- `DecisionSettings.tsx` (consent screen + auto-apply toggles + blocklist) + `SentLog.tsx` (Data sent +
  clear + cost totals), mounted from `options/main.tsx`. Landed `ea647ae`, fix `9e6bed8`.
- **Consent grants go through direct Dexie, not a message.** There is no consent intent in
  `messages/decisions.ts`; the Options page writes `db.consents` with
  `grantConsent`/`revokeConsent`/`hasConsent` (scope `jev_decisions`), and the worker's gate re-verifies
  on every send. Read it via `useLiveQuery(() => hasConsent(...))` so grant/revoke re-render live; a
  stale `consentVersion` row reads as `false` → the re-disclosure is just the un-consented screen again.
- **Toggles/blocklist are worker-owned**: read via `GET_SETTINGS`, write via `SET_SETTINGS` (whole
  `DecisionSettings`) / `SET_BLOCKLIST` (full normalized array); the UI re-renders from the echoed
  `settings_ok` snapshot. Only `add_tags`/`set_category` have toggles (§10.2).
- **Sent log + cost are pure Dexie reads** (`db.sentLog` metadata-only, `db.usage` tokens/cost where
  reported) — no message needed; `clearSentLog()` + `SENT_LOG_RETENTION_CAP` are the FR10 bindings.
- **Pattern — dexie-react-hooks retains the prior result across dep changes.** A `useLiveQuery` keyed on
  a changing arg (the provider radio) briefly renders the OLD arg's result. Fix: have the query emit a
  `{arg, value}` tuple and treat a mismatched `arg` as pending. Also: a failed settings read must render
  a retryable failure state, not a perpetual "Loading…" (distinguish in-flight from settled-empty).
- Radio-group `name` collisions across two components mounted on the same page merge their inputs — the
  decisions provider group is `name="decisions-provider"` (vs ProviderSetup's `name="provider"`).

## [2026-09-27 15:40] - Phase 3 Task 6: Automated checkpoint — FULL GATE GREEN

- Gate on main @ `bafdd3f` (all Phase 3 tasks landed): **lint** 0 errors (1 pre-existing TanStack
  `useVirtualizer` warning) · **typecheck** clean · **unit** `npx vitest run` 84 files / **2373 tests
  pass** · **build** 1.16 MB · **`check:manifest`** OK · **`check:bundle`** OK · **e2e**
  `xvfb-run -a npm run test:e2e` **13/13 pass**.
- Phase 3 delivered the worker-side Jev decision stack: analyze pipeline (`decisions/pipeline.ts`),
  rerank (`decisions/rerank.ts`), near-duplicate scan (`decisions/duplicates.ts`), resumable job
  queue + runner (`src/jobs/`), total worker message protocol (`messages/decisions.ts` +
  `background.ts` wiring + startup resume), user-blocklist enforcement (`decisions/blocklist.ts`),
  and sentLog retention (`net/sent-log.ts`). 2373 tests = +113 over the 2260 Phase-2 baseline.
- Phase 4 must consume these worker APIs: `clearSentLog` + `SENT_LOG_RETENTION_CAP` in the Options
  "Data sent" view; job start/pause/resume/cancel + review-queue approve/reject/revert messages;
  analyze/rerank entry points; blocklist + settings writes.

## [2026-09-27 15:35] - Phase 3 Task 5: sentLog retention cap and clear (BookmarksManager-sd1)

- `src/net/sent-log.ts` now owns sent-log writes: `SENT_LOG_RETENTION_CAP = 500`,
  `appendSentLog` (add + index-bounded prune in one `rw` transaction), `clearSentLog` (returns
  the removed count). `send.ts` routes through it at the same point with the same `fieldNames`.
- Prune pattern: `count()` (IndexedDB aggregate, no materialization) + `orderBy(":id").limit(excess)
  .primaryKeys()` → O(excess) work, ordered by insertion (`:id`), not unstable `sentAt` ties. The
  single `rw` transaction makes concurrent appends safe (IndexedDB serializes overlapping rw txns).
- `appendSentLog` rebuilds the row from only `sentAt`/`destination`/`feature`/`fieldNames`, so a
  stray runtime prop can't persist — the metadata-only contract is enforced structurally, not by
  test assertion alone.
- Deferred minors: a rejected `appendSentLog` aborts the already-sent request's caller (pre-existing
  `db.sentLog.add` behavior — consider a best-effort audit write later); the cap isn't configurable.
- Phase 4 constraint: the Options "Data sent" view (FR10) must consume `clearSentLog` for Clear and
  should display `SENT_LOG_RETENTION_CAP` so the messaging stays in sync with the enforced cap.

## [2026-09-27 15:13] - Phase 3 Task 4: Worker messages and background wiring
- **Implemented:** `src/messages/decisions.ts` (14-intent Zod discriminated union, total
  `handleDecisionsMessage`, trusted-extension-sender check, `{ok:true,...}|{ok:false,code,message}`),
  `src/entrypoints/background.ts` (combined listener: decisions first, provider fallback — no double
  `sendResponse`; `productionHandlers`; `buildRunner` wired with BOTH `createPipelineAnalyzer` and
  `createDuplicateScanner`; `resumeJobs` startup hook), `tests/unit/decisions-messages.test.ts`.
- **Files changed:** `src/messages/decisions.ts`, `src/entrypoints/background.ts`,
  `tests/unit/decisions-messages.test.ts`; fix also `src/decisions/{blocklist.ts,pipeline,rerank,duplicates}.ts`,
  `src/jobs/runner.ts`, `src/net/send.ts` + tests.
- **Commit:** `2f2ffe1` (worker `3706e6d9`, wt/p4-p3t4 `6be3248`) + fix `11ccd5f` (wt/p4-p3t4-fix1 `a33eddd`);
  review APPROVED_WITH_CONCERNS → 1 fix round → re-review ALL FINDINGS ADDRESSED.
- **Learnings:**
  - **Ruling (privacy) — a user-configured control must actually be enforced on egress.** The user
    blocklist was persisted and editable but never passed to `minimizeBookmark`/`isSensitiveUrl` anywhere,
    so a user-blocklisted URL could still be sent. Fixed end-to-end: a shared reader
    `src/decisions/blocklist.ts` (owns `DECISION_BLOCKLIST_KEY` + `readBlocklist`) avoids the
    `background → pipeline → net/send` import cycle; the list is threaded through
    `AnalyzeBookmarkOptions`/`RerankSearchOptions`/`ScanCommonOptions` and the runner adapters, AND enforced
    at the gate (`admitsDecisionState`) as defense-in-depth before consent/permission/key reads.
  - **Ruling (behavior) — resume only jobs interrupted by worker eviction.** `paused` is reachable ONLY via
    an explicit user action (an MV3 eviction leaves a job `running`), so resuming `paused` silently
    restarted egress/cost the user halted. `resumeJobs` now resumes `running`/`pending` only.
  - **Pattern — the worker protocol is broader than the Options protocol.** `provider.ts` trusts only
    `options.html`; `decisions.ts` trusts any same-origin extension page (popup, side panel, Options) via
    `sender.url.startsWith(chrome.runtime.getURL(""))`. Same-origin is trusted; per-surface least privilege
    is a possible future hardening (deferred).
  - **Constraint carried into Task 4 (from Task 3b):** a `library_scan` fails closed without a
    `scanDuplicates` dependency, so production `buildRunner` passes both analyzers.
  - **Deferred minors:** `activeProvider` picks the first consented preset (no preference); "no provider"
    relays `invalid_input` (no dedicated `not_enabled` code); `resolveWorkSet`/settings are read twice per
    resumed job; trusted-sender breadth.

---

## [2026-09-27 14:47] - Phase 3 Task 3b: Near-duplicate scan for library_scan (FR7 gap)
- **Implemented:** `src/decisions/duplicates.ts` — `scanNearDuplicates` / `scanNearDuplicatePairs`:
  compute `nearDuplicatePairs`, minimize both sides, ONE `nearDuplicate` request per pair on
  `jev_decisions` (state `{bookmark,pairPartner}`), cross-check the `same_content` 1–4 level, map
  level→confidence (`1→0`, `2→0.4`, `3→0.75`, `4→1.0`), apply the §10.2 `merge_duplicates` policy
  (review ≥ 0.5, never auto-apply), persist one `merge_duplicates` decision per pair (`keepId = a`),
  one `usage` row per egress. `jobChecks("library_scan")` now signals `near_duplicate`; the runner gained
  a batched pair phase with the same snapshot-then-mutate/pause/redaction discipline.
- **Files changed:** `src/decisions/duplicates.ts`, `src/jobs/{queue,runner}.ts`,
  `tests/unit/decisions-duplicates.test.ts`, `tests/unit/jobs-{queue,runner}.test.ts`.
- **Commit:** `0d2a609` (worker `04ffc9ad`, wt/p4-p3t3b `0d60ce0`) + fix `142e17f` (wt/p4-p3t3b-fix1 `6d108ee`);
  review APPROVED_WITH_CONCERNS → 1 fix round → re-review ALL FINDINGS ADDRESSED.
- **Learnings:**
  - **Ruling — an optional capability dependency is fail-open; make it fail closed.** `scanDuplicates` was
    optional, so a `library_scan` with no scanner computed zero pair batches and reported `completed` while
    silently omitting near-duplicate — the exact FR7 gap the task closed. Fix: `JobRunner.run` throws
    `JobRunnerError("invalid_input")` BEFORE any status change when a `library_scan` has no scanner.
    General rule: a dependency the job KIND requires must be enforced, not defaulted away.
  - **Design — near-duplicate is inherently pairwise.** The per-bookmark batch loop cannot express it, so
    it became a second phase. The pair list is recomputed from bookmark content each run and sliced by
    `pairIndex`; resume is deterministic only while the work set's titles/urls are unchanged (documented).
  - **Convention — one request per pair (no batching).** `nearDuplicate` state is `{bookmark,pairPartner}`,
    so a pair cannot share a request; this makes request volume the pair count (see `BookmarksManager-2qk`).
  - **Ruling — fixed level→confidence is deliberate.** §10.1 says to use a score answer's returned
    `confidence`; here the fixed map is used and the returned confidence is intentionally not blended
    (documented in code). Revisit if a level's confidence spread matters.
  - **Worker cross-file edit:** the worker updated `tests/unit/jobs-queue.test.ts` (outside its stated
    owned set) because its `jobChecks("library_scan")` assertion directly contradicted the new
    requirement. Minimal and correct (strictly more coverage); a justified exception.
  - **Deferred:** cap `nearDuplicatePairs` output + fold the pair count into `estimateJobCost`/enqueue
    `totalBatches` (`BookmarksManager-2qk`); below-floor levels still persist an `unsure` merge proposal;
    a mid-batch failure re-sends already-persisted pairs on resume (runner-wide, pre-existing).

---

## [2026-09-27 14:28] - Phase 3 Task 3: Job queue
- **Implemented:** `src/jobs/queue.ts` (enqueue, lifecycle transition table, per-job usage roll-up,
  `jobChecks`, `computeTotalBatches`), `src/jobs/runner.ts` (`JobRunner` batch loop + `createPipelineAnalyzer`),
  `src/jobs/estimate.ts` (pure `estimateJobCost` folding `estimateTokens`). The `jobs` row is the single
  source of truth; progress/usage commit only after the batch's results are durable; pause/cancel observed
  at batch boundaries; failures redacted to a code.
- **Files changed:** `src/jobs/{queue,runner,estimate}.ts`, `tests/unit/jobs-{queue,runner}.test.ts`;
  fix also `src/schemas/job.ts`.
- **Commit:** `9b943ad` (worker `79045ae1`, wt/p4-p3t3 `57f405c`) + fix `60868e0` (wt/p4-p3t3-fix1 `449e416`);
  review APPROVED_WITH_CONCERNS → 1 fix round → re-review ALL FINDINGS ADDRESSED.
- **Learnings:**
  - **Ruling — the resumption row must carry every parameter that affects slicing.** `batchSize` was not
    persisted, so a resume with a different `batchSize` recomputed `totalBatches` and could mark a job
    `completed` while skipping unprocessed bookmarks, or re-send a committed batch. Fix: persist
    `batchSize` on the `Job` row (`src/schemas/job.ts`, `.default(DEFAULT_BATCH_SIZE)` so untouched
    `satisfies z.input<typeof Job>` fixtures stay valid — a required field would have forced a 6th-file
    fixture edit); the runner reads `job.batchSize` as authoritative and rejects a differing override
    (`invalid_input`) fail-closed. General rule: anything that changes batch boundaries belongs in the row.
  - **Ruling — a mid-batch failure must not race a pause/cancel into an `illegal_transition` throw.**
    The `catch` re-reads the status and only marks `failed` when still `running`; otherwise it returns the
    current row (`paused`/`canceled` wins). Keeps `run()`'s "throws only caller errors" contract.
  - **Ruling — library_scan omitting near-duplicate is a real FR7 gap, not a Task 3 defect.** FR7 defines a
    library scan as categorize + tags, misfiled, near-duplicate, but `jobChecks("library_scan")` returned
    three checks and nothing in `src/` drives the `nearDuplicate` question set end-to-end. Near-duplicate is
    inherently pairwise, which the per-bookmark batch loop cannot express, so it needs a second phase.
    Filed `BookmarksManager-vl7` and added plan Task 3b.
  - **Schema-add-without-migration:** adding a non-indexed field to a Dexie row type needs no `version()`
    bump (only indexed fields appear in `stores()`); `.default()` materialises on the next write. A legacy
    row predating the field would read as `undefined` — irrelevant here (no shipped DB) but backfill if ever.
  - **Deferred minors:** `cursor` is accepted but never read/advanced (resumption is driven by
    `committedBatches`); usage is written without `jobId` then `update`d by the runner (non-atomic orphan
    risk on a crash); a mid-batch failure leaves partial decisions/usage (job is terminal, so harmless);
    `estimateJobCost` is a token lower bound with no USD.

---

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

