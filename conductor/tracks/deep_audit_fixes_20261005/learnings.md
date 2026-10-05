# Track Learnings: deep_audit_fixes_20261005

Implementation discoveries belong here and in the mapped Beads task's notes.
This file starts with approved context and inherited patterns; it does not
claim that any audit finding has been fixed or reproduced.

## Approved Decisions (2026-10-05)

- All findings of the 2026-10-04 audit are in scope except four deferred items
  (active Jev provider pointer, storage.persist/backup, Applied/History view,
  add_tags per-tag policy) filed as P3 Beads: BookmarksManager-od9, BookmarksManager-xxo, BookmarksManager-tax, BookmarksManager-rwy.
- High/P1 track priority. No track dependencies. Hours unset.
- **Automated gates only**; no manual checks at any phase or at completion.
- Task-level parallelism only for file-disjoint tasks; phases sequential.
- **Consent/privacy claims are enforced in code**, not softened in docs:
  explain/restructure get real disclosures, gates get per-scope guards, the
  popup suggests only on explicit action, jobs do not resume egress at cold
  start.
- Bulk Approve all: confirm dialog plus aggregate undo. Bulk Analyze routes
  through the job queue with estimate and cancel.
- Reused Beads: eov (Phase 2 task 3), 2v9 (Phase 3 task 5), 7k4 (Phase 7 task
  1), bih (Phase 7 task 2).

## Audit Provenance

- Baseline observed 2026-10-04: typecheck, lint, 159 files / 2395 unit and
  component tests, build, check:manifest, check:bundle, npm audit (prod) all
  green. Playwright e2e was not run in the audit.
- Findings come from four read-only slice audits (security/privacy, data
  integrity, decisions/jobs, UI). Four were confirmed by direct code reads:
  readBlocklist fails open (P01), startRestructure omits userBlocklist (P02),
  AbortSignal.timeout is misclassified (A01), applyMerge uses peekLatest (D04).
  **All others are unreproduced; apply the verify-first rule.**
- audit_hardening_20261001 (archived) already changed undo serialization,
  explain/summary blocklist checks, job ownership and reservation settlement.
  Re-read current code before trusting any line reference in spec.md.

<!-- Learnings from implementation will be appended below -->

## 2026-10-04 — Preflight baseline blocker

- **Evidence before edits:** `npm run test -- --run` timed out at 180 s.
  `npm run test -- --run --maxWorkers=2` completed with 156 files passed,
  3 failed; 2392 tests passed, 3 failed. Near-duplicate planning took 849 ms
  against its 500 ms limit, search-index build took 659 ms against 500 ms,
  and the EditDialog test timed out at 5 s.
- **Isolation:** `npm run test -- --run --maxWorkers=1
  tests/unit/decisions-perf.test.ts tests/unit/search-perf.test.ts
  tests/components/sidepanel-actions.test.tsx` passed all 18 component tests
  but still failed both performance gates (593 ms planning, 705 ms search
  build). Analyze-on-save passed at 340 ms worst-of-three, below 1500 ms.
- **User direction:** Investigate and fix the baseline first. Do not weaken
  thresholds or skip performance tests. Track tasks remain pending until
  the baseline repair passes.
- **Tracking:** `BookmarksManager-3op.8` owns the baseline repair and blocks
  Phase 1 task 1. The host has four ARM Neoverse-N1 vCPUs with observed load
  averages around 11–12; timing evidence must distinguish contention from
  production inefficiency.
- **Workspace:** Existing epic notes explicitly direct execution on the
  current `main` checkout. No remote synchronization is authorized.

## 2026-10-04 — Baseline repair and contention control

- **Implemented:** Precompute title normalization and token sets once per
  bookmark in the near-duplicate planner. Replace JSON pair-key allocation
  with canonical ID tuples held in a plan-local map of sets.
- **Preserved:** 50,000 comparison attempts, 500 output pairs, stable ordering,
  truncation accounting, duplicate exclusions, Unicode/punctuation and
  tokenless-title behavior. Four permanent parity/edit regressions added.
  Complete-plan comparisons against the original implementation passed 9/9.
- **Root cause:** Repeated per-pair title work and key allocation. Planner
  measurements improved from 740 ms to 318 ms in the worker's run, and
  276 ms in the coordinator's controlled full run.
- **Search finding:** No safe search change was needed or retained. Its
  profile showed 769 ms elapsed but 328 ms process CPU. CPU pressure was
  about 89% on this shared host. Pinning the test process to CPU 3 with one
  worker passed the unchanged cold-build gate, both standalone and in the
  full run. Do not introduce caches or relax thresholds to hide contention.
- **Validation:** `taskset -c 3 npm run lint` and
  `taskset -c 3 npm run typecheck` passed.
  `taskset -c 3 npm run test -- --run --maxWorkers=1` ran all 159 files:
  2398 tests passed, one failed (popup render 156 ms against 150 ms).
  Both originally failing performance gates passed; analyze-on-save max was
  257 ms. The unchanged failed file passed all 24 tests on an isolated rerun:
  `taskset -c 3 npm run test -- --run --maxWorkers=1
  tests/components/popup-save.test.tsx`. This is a passed rerun, not a
  claim that the full-suite invocation exited successfully.
- **Remaining checks:** `taskset -c 3 npm run build`,
  `npm run check:manifest`, `npm run check:bundle`,
  `npm run check:store`, `npm run check:site`, and `git diff --check` passed.
  Existing React `act` warnings remain. E2E was not required for this
  planner-only repair; live/eval and native permission prompts were not run.
- **Local commit:** `c229c43` (with a task summary in Git notes).

## 2026-10-04 — Task 1 preflight

- The runtime has no `xd://lsp` tool. Local symbol searches identified all
  `readBlocklist` consumers; maintain its array-returning signature and throw
  a typed, content-free refusal on unreadable/malformed persisted data.
- The decisions message layer already relays typed service codes. Summary
  admission already returns typed `unsendable` on a failed blocklist read.
  Explain needs an explicit mapping for the new reader refusal in
  `src/messages/llm-features.ts`; its ownership is added to task 1 before
  implementation. Task 4 already depends on task 1, so no concurrent writer
  is introduced. Scope-specific payload validation remains task 2.

## 2026-10-04 — Phase 1 task 1: P01/P02

- **Implemented:** Typed, redacted blocklist-read refusal for DB errors and
  malformed persisted rows. Both gates independently refuse before credentials,
  reservations or dispatch. Explain/restructure map the safe refusal through
  total message results. Restructure passes the persisted blocklist and omits
  blocked-only folder paths, leaf fields and aggregate counts.
- **Files:** `src/decisions/blocklist.ts`, `src/net/{send,llm-send}.ts`,
  `src/messages/{llm-features,restructure}.ts`,
  `src/restructure/synopsis.ts`; `tests/unit/{blocklist,blocklist-egress,
  restructure-synopsis}.test.ts`.
- **RED:** Final regression fixtures run against archived `c4ed0d8` failed
  107 tests and passed 69 controls. Initial RED preceded production edits;
  the archived run also verified corrected fixture plumbing without
  reverting the working tree.
- **GREEN:** Targeted 14 files / 428 tests passed. Coordinator reviewed the
  implementation and ran the full gate over task 1 plus independent task 5:
  `taskset -c 3 npm run lint`; `taskset -c 3 npm run typecheck`;
  `taskset -c 3 npm run test -- --run --maxWorkers=1` (161 files,
  2564 tests passed); `taskset -c 3 npm run build`;
  `npm run check:manifest`; `npm run check:bundle`;
  `npm run check:store`; `npm run check:site`;
  `taskset -c 3 xvfb-run -a npm run test:e2e` (43 passed, one intentional
  store-screenshot skip). All commands exited 0. Existing React `act`
  warnings remain; live/eval and native permission prompts were not covered.
- **Learnings:** Missing policy differs from unreadable policy. Keep the reader
  independent of network classes, and translate at each trust boundary.
  Classify descendant admission before applying synopsis path caps. Preserve
  unrelated empty folders and walk structural roots even in an all-blocked
  library, so privacy filtering does not incidentally erase harmless paths.
- **Local commit:** `03a655a` (with Git note); `BookmarksManager-3op.1.1` closed.

## 2026-10-04 — Phase 1 task 5: P05

- **Implemented:** Popup suggestions require Tags input focus or the Suggest
  button. Opening with current consent sends no request. The request stays
  one-shot, reads the latest form values, and does not tear down on edits.
  The popup explains the trigger; existing consent/refusal/blocklist behavior,
  independent popup correlation and user-controlled save remain intact.
- **Files:** `src/entrypoints/popup/{App,Suggestions}.tsx`,
  `tests/components/popup-suggestions.test.tsx`,
  `tests/e2e/decisions.spec.ts`.
- **RED:** Three regressions failed before runtime edits: consented open sent
  automatically, pre-trigger edits could not remain unsent, and Suggest did
  not exist. Focus/refocus and repeated button activation are bounded to one
  request; a no-consent test now explicitly focuses Tags to exercise refusal.
- **GREEN:** `taskset -c 2 npm run test -- --run --maxWorkers=1
  tests/components/popup-suggestions.test.tsx
  tests/components/popup-save.test.tsx` passed 43 tests across two files.
  The full gate recorded under task 1 passed over the same unchanged runtime
  diff: 2564 unit/component tests and 43 browser tests, one intentional
  screenshot skip. The real-wire popup test observed zero requests and log
  rows after opening, then exactly one minimized send after Tags focus.
- **Learnings:** Keep user intent in the effect dependencies, but keep editable
  payload values in the latest-input ref. Changing form fields must not
  cancel an in-flight one-shot request or silently request another.
- **Local commit:** `3a00d58` (with Git note); `BookmarksManager-3op.1.5` closed.

## 2026-10-04 — Task 2 preflight

- `fetchImpl` is also exposed by `LlmClientConfig` in `src/llm/client.ts`,
  which forwards it to the gate. Add that file to task 2 ownership so
  production caller configuration cannot retain the bypass after the gate
  removes it. Test transport installation belongs in test-only utilities.
- Valid structured-output fallback and bounded repair transcripts must remain
  compatible with scope admission. Tests must cover the real feature payloads,
  not just generic chat bodies that will now be intentionally refused.

## 2026-10-04 — Phase 1 task 7: P08, targeted verification

- **RED:** Ten failures before extraction edits: navigation accepted under
  the old tab URL, missing document identity accepted, seven oversize
  injected shapes accepted, and a 2,624,006-character article crossed the
  in-page boundary. A second RED run reproduced two same-URL replacement
  exposures, before the first send and between LLM and Jev.
- **Implemented, not yet closed:** The injected result carries its own URL
  and `performance.timeOrigin`; the worker checks the current main document.
  Chrome's document id stays local and pins content-free identity probes.
  Summary admission rechecks the captured document before each provider
  attempt, in addition to the existing live bookmark/blocklist/consent checks.
  New pure extraction limits are shared with in-page caps and `.max()` worker
  validation. Readability receives `maxElemsToParse` and `charThreshold`.
- **GREEN:** Latest targeted run passed 74 tests across
  `page-extraction`, `llm-summarize`, and `summary-messages`. Scoped ESLint and
  scoped diff checks passed. Full gate/e2e remains pending the two concurrent
  workers. A prior typecheck exposed one coordinator mock-type error, now
  fixed, plus temporary task 2 `fetchImpl` fixture errors owned by that worker.
- **Nonreproduction:** A blocklist added during injection was already refused
  by existing summary admission with zero LLM/Jev sends. Preserve the
  permanent regression rather than adding a redundant policy reader.
- **Integration:** P03 now rejects newly blocked retry payloads before another
  reservation, using `request_not_allowed`; the summary fixture asserts that
  early refusal and one settled reservation. Live-bookmark changes still
  reach feature admission and release the second reservation.
- **Testing:** Distinguish the one `extract.js` injection from subsequent
  content-free probes. Count actual provider requests and persisted state,
  not an obsolete total `executeScript` call count. The new multi-megabyte
  fixture has its own 20-second limit; existing performance thresholds and
  fixtures remain unchanged.

## 2026-10-04 — Combined gate and independent review

- Full lint and typecheck passed. Initial full unit/component run:
  2703 passed / 3 failed across 163 files. Failures were unchanged
  search-index timing (509.8 ms > 500 ms), an unchanged Options shell timeout,
  and unchanged dismissed-delete error visibility. Focused rerun passed all
  46 tests across those three files; no thresholds/source/fixtures changed.
- Build, manifest, bundle, store and site checks passed. Playwright passed
  43 tests with one intentional store-screenshot skip. These are pre-review
  evidence, not completion of tasks or Phase 1.
- Independent read-only review found three actionable gaps: retain accepted
  Explain/Restructure recipient binding through each dispatch; forward summary
  admission into the Jev gate's final callback; re-admit all synopsis sources,
  including hosts omitted from its capped domain list. Source inspection
  confirmed each gap. Revision 6 assigns fixes; regression/verification pending.

- **Summary review gap reproduced and fixed:** Three final-gate tests held
  Jev permission preflight after the LLM response, then replaced the document,
  revoked verification consent, or changed the Jev model. The first fixture
  run stopped at a missing synthetic Jev key, so it was not valid RED evidence.
  With the key seeded, all three incorrectly succeeded and persisted.
  Forwarding the existing `beforeSend` option through `createJevClient`
  closes that gap without a new gate API or duplicated wrapper. Fresh targeted
  extraction/summary/Jev-client run passed 118 tests across four files; scoped
  lint and typecheck passed. Other two review gaps remain with the resumed
  task 4 worker.

## 2026-10-04 — P03/P04/P08 post-review combined validation

- Independent follow-up review confirmed all three findings closed, with no
  new high-confidence actionable finding in remediation. P04 added 101 real
  dispatch regressions for held native/preflight reads, active/model/origin/
  consent changes, affirmative/cost retries and all subsequent-attempt paths,
  including the omitted 51st source host. Complete source URLs stay local.
- Fresh complete gate passed: lint, typecheck, **164 files / 2810 unit and
  component tests**, build, manifest, bundle, store, site, and **43 browser
  tests / one intentional store screenshot skip**. Existing React `act`
  warnings remain. No live/eval/paid requests or remote synchronization.
  Full output: `/tmp/droid-terminal-9pdhsn/1ed17915-67c7-4c20-9f98-891e9ed09b2f.log`.
- Original performance budgets passed unchanged: search build 447 ms,
  near-duplicate planning 311.4 ms, analyze-on-save maximum 294.4 ms.
- Commit ordering: P08's pure shared limits and injected-result fixture land
  first, then P03's canonical guards/transport changes, then P04's disclosure
  and per-attempt authority. Partial-index staging preserves separate task
  boundaries without modifying the combined verified working tree.
- **P08 completed:** Actual document URL/time origin/Chrome document id are
  rechecked before egress; in-page output is capped and oversize worker shapes
  refuse. Summary admission now reaches both real gates after asynchronous
  preflight. Three late-Jev refusal regressions complement initial navigation
  and same-URL document-replacement regressions.
- **P08 staged snapshot:** Exported the exact index into a fresh temporary
  tree, leaving working files untouched. Its five relevant test files passed
  **263/263**, including original pre-P03 blocklist controls. This validates
  the standalone commit, not just the combined working-tree gate.
- **P08 local commit:** `eea1971`, with Git note; mapped Bead closed.

## 2026-10-04 — Phase 1 task 2: P03

- Closed per-scope user payloads, exact canonical system/output schemas,
  current URL/domain policy and closed Jev question variants now enforce
  admission independently of feature callers. Jev verification consent is
  not an LLM entitlement. Synthetic connection probes remain synthetic.
- Canonical pure prompt contracts avoid producer/gate drift and dependency
  cycles. Real clients get ephemeral original-input-bound sessions; only a
  reader bound to the fetched response may authorize the next provider echo.
  Forged/borrowed/mutated/free-form repairs refuse; actual bounded fallback/
  repairs remain compatible. Concurrent sends cannot rebind one session.
- Production `fetchImpl` interfaces/runtime forwarding were removed. Test-only
  global transport installers retain meaningful concurrent budget/send tests.
  Otherwise-sendable blocklist controls use actual scope requests, not
  malformed chat fixtures.
- Baseline replay of final payload suite against original gates/client:
  **77 failed / 16 controls passed**. Final worker slice **526 tests / 14
  files passed**, plus scoped lint/typecheck. Fresh combined full gate and
  independent review evidence above applies to the unchanged implementation.
- Shared producer callback additions remain unstaged for the separate P04
  commit. P03 includes only their canonical contract imports, with limits
  already committed under P08. No source working files were reverted.
- Exact staged P03 snapshot passed typecheck and **529 tests / 14 files**,
  including the three newly added late-Jev regressions. This independently
  validates the contract-only producer stage without P04 callback additions.
- **Local commit:** `c19acb5`, with Git note; mapped Bead closed.

## 2026-10-04 — Phase 1 task 4: P04

- Worker handlers never grant or refresh Explain/Restructure consent. Missing,
  stale or foreign exact-origin grants yield `consent_required` and rendered
  closed recipient/model/endpoint/version disclosure. The unchecked UI action
  writes only the accepted scope/origin and retries with that binding.
- Only the two changed scopes use version 5; base and unchanged scopes remain
  version 4. Opening, dismissing or canceling a disclosure does not grant/send.
  Cost approval remains separate and bound to the same accepted recipient.
- Initial RED reproduced silent grants and missing UI disclosure. Independent
  review then reproduced per-attempt authority gaps; 101 real dispatch
  regressions cover held native/preflight IO and subsequent fallback, repair,
  transport/HTTP/cost retries. Complete synopsis source provenance stays local
  and prevents capped/omitted domains from retaining newly blocked contributions.
- Internal service callbacks compose with existing bookmark admission and
  reach the real gate after its asynchronous preflight. Readonly
  metadata/consent transactions keep recipient and grant checks consistent.
  Early retry gate refusals recheck authority rather than hiding redisclosure
  behind obsolete model/consent codes.
- Final worker slice passed **431 tests / 12 files**. Fresh full gate passed
  **2810 tests / 164 files** plus **43 e2e / one intentional skip** and every
  applicable lint/type/build/store/site check. Follow-up independent review
  closed all findings. Separate task commit contains callback additions only,
  not the already committed P03 canonical producer imports.
- **Local commit:** `a89239b`, with Git note; mapped Bead closed.

## 2026-10-04 — P06 targeted implementation

- RED reproduced startup egress and unpaused running/pending rows (four
  failures, 35 controls). An additional RED proved an old owner's queued
  authority remained admitted. Atomic local cold-start pause preserves
  progress and increments owner/control fences; explicit messages wait for
  that recovery before acting.
- Narrow runner/queue/messages/scan slice passed 109 tests across five files;
  disclosure/Options/restructure slice passed 78 across three. Scoped lint,
  typecheck, build, manifest, bundle, store and diff checks passed.
- Two wire-level browser restart tests passed startup pause/zero requests/
  stable log rows and explicit Resume from committed progress. P07 changed
  aggregate totals: old interrupted attempts and native transport failures
  must remain visible. Require exactly the successful Resume sends, preserve
  only safe transport failures besides them, and assert no idle log growth.
- Review and combined full gate pending; task remains in progress.

## 2026-10-04 — P07/P06 integration verification

- P07 RED: 20 failures / 101 controls, then two audit-only native deadline
  failures. Final owned slice: 129 tests / four files; broader privacy slice:
  524 / nine. Both gates initiate metadata-only logging at dispatch with no
  awaited IO after final privacy admission; outcome finishing is fail-soft.
  Legacy/pending outcomes remain optional. Clear/trim updates cannot recreate
  removed rows. Public native timeout/retry policy remains Phase 2 work.
- Two Jev sibling-drain tests now wait for the first row's `http_401` outcome,
  not one total row after two fetches have already started. Final two-row
  accounting and original ownership/Resume checks remain unchanged.
- Independent P07 review passed spec and quality with no findings. P06 review
  confirmed runtime recovery and found obsolete second-opinion Save wording.
  A rendered Options regression reproduced that mismatch before correction;
  scoped re-review confirmed it addressed, with both verdicts passing.
- `taskset -c 3 npm run lint` and typecheck passed. Full unit/component run:
  **2831 passed / one failed**, 165 files. Only failure was unchanged search
  build at 626.9 ms versus 500 ms; subsequent CPU-3 slice still failed
  search, while analyze-on-save (max 345 ms) and planner (351.3 ms) passed.
  Host load was about 11 across four vCPUs, CPU pressure about 92%.
- `git diff c229c43 -- src/search tests/unit/search-perf.test.ts` was empty.
  `taskset -c 2 npm run test -- --run --maxWorkers=1
  tests/unit/search-perf.test.ts` passed both tests with original thresholds.
  This is a successful focused rerun, not a successful full-suite invocation.
- Remaining fresh CPU-2 build, manifest, bundle, store, site, browser and diff
  checks passed: **43 browser tests / one intentional screenshot skip**.
  No paid/live/eval requests, native permission prompt coverage or remote sync.
- Task implementations are reviewed and validated. Phase 1 checkpoint still
  awaits P09 and a fresh complete gate.
- Exact staged P07 snapshot passed typecheck and 170 tests across five files,
  including aligned real Jev sibling draining. Initial snapshot execution had
  no generated `.wxt/tsconfig.json` and collected zero tests; preparing types
  resolved that harness issue without modifying repository working files.
- **P07 local commit:** `f0406bd`, with Git note; mapped Bead closed.
- **P06 completion:** Atomic cold-start pause, invalidated interrupted
  authority, explicit recovery barrier and committed-progress Resume verified.
  Main Jev and second-opinion disclosures plus duplicate policy summaries now
  identify Tags focus/Suggest and Resume. Rendered disclosure regression is
  meaningful RED/GREEN; independent fix review passed. No recipient/field
  expansion or relaxation, so unchanged version-4 scopes stay version 4.

## 2026-10-04 — Baseline reset failure visibility

- The fresh Phase 1 gate and isolated unchanged test reproduced a disappearing
  reset failure. Closing the dialog unconditionally cleared an error that had
  already arrived, so the original timing-sensitive regression sometimes
  failed. This is a real baseline defect, not a performance threshold miss.
- `BookmarksManager-3op.9` owns the separate repair. A deterministic settled
  failure test failed before source edits (one failure / nine controls).
  The existing mid-operation test now defers failure until after dismissal.
  Removing only close-time error clearing preserves both orderings; explicit
  confirmation still clears stale error before a retry.
- Scoped lint and 33 tests across two collected reset files passed. Independent
  review approved spec and quality, no findings. Deletion, native bookmarks,
  permissions, storage and network behavior are unchanged.
- Fresh combined full gate with P09 passed: `taskset -c 2 npm run lint`;
  `taskset -c 2 npm run typecheck`;
  `taskset -c 2 npm run test -- --run --maxWorkers=1`
  (**167 files / 2919 tests**); `taskset -c 2 npm run build`;
  `npm run check:manifest`; `npm run check:bundle`;
  `npm run check:store`; `npm run check:site`;
  `taskset -c 2 xvfb-run -a npm run test:e2e`
  (**43 passed / one intentional screenshot skip**); `git diff --check`.
  Every command exited 0. Full log:
  `/tmp/audit-phase1-fix-gate-oowbCG.log`.
- Existing React `act` warnings remain in the full gate. No live/eval/paid
  requests, native permission-prompt coverage or remote synchronization.
- **Local commit:** `7709846`, with Git note; mapped Bead closed. Exact
  standalone index snapshot passed types and all 33 reset tests.

## 2026-10-04 — Phase 1 task 8: P09

- Outbound URL copies strip literal/encoded matrix suffixes and replace
  segments matching `^[A-Za-z0-9_-]{32,}$` with `_redacted_`. A pure shared
  path contract keeps the cleaner and independent `CleanedUrl` admission in
  agreement. Retained short paths keep their original escape spelling.
- Independent admission checks raw as well as parsed paths: WHATWG dot
  normalization can hide a secret-bearing segment even though the gate sends
  the original string. Original 2,048-character bookmark bounds remain
  enforced before redaction can shrink an overlong URL.
- Native URLs and local summary resource identity are unchanged. Real-wire
  tests verify minimized decision/explain/summary/verification requests and
  raw-gate refusals without requests, log rows or reservations. Distinct raw
  resources may share an outbound copy but never become locally equivalent.
- Meaningful initial RED: 51 failures / 44 controls, with additional raw
  normalization and independent gate regressions. Initial wider slice passed
  934 tests; search timing failures were recorded, not silently excluded from
  full-gate claims. Offline evaluation inspection found exactly three long
  descriptive slugs now redacted among 315 URL records / 294 cases; the
  committed corpus, expected decisions and release thresholds stay unchanged.
  Their quality impact was not measured with paid evaluation.
- Independent review found quadratic nested percent decoding, including
  over-limit Zod inputs whose refinement still ran. Fix round 1 reproduced
  that defect, adds an explicit early 2,048-character refusal and at most
  eight shrinking decoding passes. Unresolved segments redact entirely;
  no partially decoded potential secret is retained. The same adversarial
  three-inspection probe improved from 14,123 ms to 34.4 ms. Boundary,
  spelling, idempotence, and large encoded suffix controls remain green.
- Final owned slice: 114 tests; real-gate/privacy/identity slice: 513 tests;
  scoped lint/types pass. Scoped re-review closed the finding with no new
  blocking breakage. Additional unchanged 10k-corpus worst-of-ten analyze:
  maximum 280.9 ms versus 1,500 ms. Original performance fixtures/thresholds
  were not edited.
- Both store documents and hosted privacy source describe the remaining
  path after minimization. This narrows/clarifies an existing field, adding no
  recipient, field or automatic trigger; scoped versions remain unchanged.
- Fresh full combined gate passed **2919 tests / 167 files**, all checks
  and **43 browser tests / one intentional screenshot skip**, with exact
  commands/log under the baseline-reset entry above. Live/eval/paid requests
  and native permission prompts remain excluded.
- **Local commit:** `82ae885`, with Git note; mapped Bead closed.

## 2026-10-04 — Phase 1 automated checkpoint

- All eight implementation tasks and the discovered baseline-reset blocker
  are committed locally and closed. Independent review findings are resolved.
  The fresh full gate in `/tmp/audit-phase1-fix-gate-oowbCG.log` exited 0:
  **2919 unit/component tests / 167 files**, every static/build/compliance
  check, and **43 browser tests / one intentional screenshot skip**.
- Wire acceptance inventory: missing/dismissed Explain/Restructure approval
  sends nothing and writes no grant; consented popup open sends nothing until
  Tags focus/Suggest; cold restart pauses with stable logs/zero new provider
  requests until explicit committed-progress Resume.
- P07 permanent gate tests account for each 503/200, timeout and redirect
  attempt. Public native timeout/retry classification stays deferred to A01,
  not incorrectly claimed fixed by logging. P08/P09 preserve local raw
  identity and cap extraction/decoding. Consent versions remain scope-specific.
- Original search, planner and analyze budgets passed in the final full
  invocation; earlier failed runs remain documented. Worst-of-ten additional
  P09 analyze evidence: 280.9 ms. No thresholds or original fixtures changed.
- Reusable privacy, dispatch, policy, identity, recovery and verification
  patterns elevated to `conductor/patterns.md`; superseded feature-consent,
  response-time logging and implicit cold-resume patterns corrected.
- Continue to Phase 2 after this automated checkpoint; no manual wait,
  live/eval/paid requests, native permission prompt claim, or remote sync.

## 2026-10-04 — A01/A02 partial implementation handoff

- Worker `83b3f4ce-0e9c-4fb1-baac-7fe3c76ef25f` finished NEEDS_CONTEXT.
  Shared abort classification, no LLM timeout retry, distinct caller abort,
  Jev deadline reason and shared jitter/date parsing are uncommitted.
- Owned slice: 229 tests / six files pass and scoped lint passes. Wider
  slice: 500 pass / one old caller-abort expectation fails. Types report
  five errors because four closed message-code unions omit `aborted`.
  This is not a passing task/full gate and has not been independently reviewed.
- Expand ownership explicitly for `messages/{llm-features,llm-provider,
  provider,restructure}.ts` and caller/protocol tests before resuming.
  Carry the public taxonomy through Zod message boundaries, not only gate/
  client types. Worker correctly left unowned files untouched.
- Full report and recovery instructions:
  `handoff_20261004_230731.md`. No live workers remain. User requested
  handoff after interruption; no further behavior edits or implementation
  commits were made. Preserve the unfinished source/test files.

## 2026-10-04 — A01/A02 completed (`72ff895`)

- Caller aborts are now honest end-to-end: `classifyAbort` reads only
  `.name` (under try/catch so a hostile `signal.reason` getter cannot
  skip settlement/logging), signal.reason stays the sole
  TimeoutError-vs-abort discriminator, and `finishLog(abortCode)` writes
  `outcome: "aborted"` — the closed `SentLogOutcome` vocabulary gained the
  one content-free member additively (Revision 13).
- `"aborted"` had to be added to ALL five message-layer error unions
  (llm-features, llm-provider, provider, restructure, summaries). A missing
  member silently flattens the relay (`isSummarizeErrorCode` safeParse would
  have mapped aborted→internal_error). Relay-site check for future code
  additions: `toConnectionCode`, `RerankErrorCode`,
  `DecisionPipelineErrorCode`, `DuplicateScanErrorCode` all union
  `JevClientError["code"]` and flow verbatim already.
- Jev keeps its intended retryable-timeout policy (Revision 12): the
  internal deadline aborts with a TimeoutError DOMException reason, so
  shared classification doesn't change Jev retry. LLM gate composes
  `AbortSignal.any` so caller abort wins over deadline.
- `src/jev/retry.ts` was already adequate (HTTP-date + jittered exp) —
  A02's contribution was the LLM gate reusing it, not editing it.
- Independent review (child session `7ac8d994`): PASS/PASS, one warning
  (throwing `.name` getter could skip reservation settlement + sent-log
  row) fixed and re-reviewed PASS.
- Full gate green at commit: lint, typecheck, 2949 unit/168 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

## 2026-10-05 — A03 completed (`c4aba4d`)

- `STALE_RESERVATION_TTL_MS` (15 min) is the binding staleness bound — the
  spec's "maximum request timeout" phrase resolves to the existing
  conservative constant, not the 30 s per-attempt deadline. At worker start
  ANY `active` row is definitionally orphaned (its fetch died with the old
  worker); the TTL is belt-and-suspenders for overlap edge cases.
- Swept rows must SETTLE under the conservative missing-usage rule
  (`reconcileBudget` with `{}`), never RELEASE — release means "never
  dispatched" and frees exposure, wrong direction for an orphaned sent
  request. Fail-closed accounting beats precision for lost state.
- `BudgetReservation.feature` (additive, non-indexed) stamps the consent
  scope at creation so a sweep settles under the true feature; persisted
  fields are untrusted — validate through `isRegisteredScope`, else fall
  back to the `llm_orphan_sweep` provenance marker.
- Guard pattern for post-dispatch bookkeeping: retry once in-process, then
  defer to the startup sweep — bookkeeping failure must never mask the
  transport outcome or strand the row; a dead DB can only heal at restart.
- `settleLlmUsage` is idempotent per row inside its own transaction, so a
  non-atomic sweep can't double-settle.
- Independent review (child `7ac8d994`): clean PASS/PASS, zero warnings.
- Full gate green at commit: lint, typecheck, 2957 unit/168 files, build,
  manifest, bundle, 43 e2e (1 intentional skip).

## 2026-10-05 — A04/A05 + eov completed (`acaa911`)

- The reservation bound must cover the REAL serialized prompt, not the
  caller's declared bound: `max(declared, ceil(body.length/4 * 1.25))`
  computed AFTER `admitPayload` (a stringify before admission turns the
  gate's typed `request_not_allowed` into a native TypeError — admission
  ordering is load-bearing for the failure taxonomy).
- Retry passes `input.maxInputTokens` through unchanged: the session
  binding canonicalized the caller's declared bound at first admit, so
  forwarding the inflated reservation bound would trip `rejectPayload`.
- "Not billed" is a fourth cost provenance, not the absence of one: the
  row records egressed traffic (tokens reported-or-0, requestCount) but
  carries NO cost fields — substituting the bound would fabricate spend
  for a request the provider rejected pre-response. The snapshot skip
  must cover BOTH committedUsd and unknownCostRequests.
- `capabilityRejected` stays the only not-billed settle path — 5xx,
  timeout, transport and non-JSON-200 keep conservative billing. The
  classification lives in `errorDetails`; the settle flag is the only
  thing the client adds.
- eov: `recordUsage` must run BEFORE the answer/level cross-check —
  a mismatched response still egressed, so its cost must be committed
  before the throw. All three cross-check sites had the identical defect.
- Declared test bounds below real bodies silently encode wrong
  accounting: ~30 stale `inputTokens: 100`/`0.000045` sites across 6
  unit files + 2 e2e specs retuned to computed per-request bounds via
  the `reservedInputBound` test helper (and wire `postData` length e2e).
- Independent review (child `7ac8d994`): PASS/PASS clean, zero warnings.
- Full gate green at commit: lint, typecheck, 2962 unit/168 files, build,
  manifest, bundle, 44 e2e (1 intentional screenshot skip).

## 2026-10-05 — A06 completed (`d96aa4d`)

- A fixed `Uint8Array(MAX)` read buffer makes the byte-cap check trivial:
  `chunk.length > MAX - filled` throws before a single byte is written —
  no partial state, no reallocation. Mirror `readLlmErrorBody` exactly.
- Depth-check the COMPLETE text BEFORE `JSON.parse`: `JSON.parse`
  recurses, so deep nesting must be refused ahead of it. The scanner is
  string/escape-aware (braces inside strings don't count); on parseable
  JSON its count equals parse depth.
- `finally`-block cancellation is the only reliable place: throwing paths
  (cap, depth, decode) all exit through it. But cancel on a CLOSED
  stream is a spec no-op — cancellation tests must keep the stream open
  after the over-cap chunk or the spy never fires.
- `reader.cancel()` on a never-read non-2xx body is itself awaitable and
  may be left-open by design — run it best-effort at the TOP of the
  error branch so it can't mask `retry_later` classification.
- Wire schemas and stored-usage schemas are DIFFERENT trust layers:
  `UsageRecord.parse` enforced `.min(0)` at persist, but the wire had no
  upper bound — review caught unbounded tokens/cost persisting as
  absurd usage. Bound both layers; the wire bound wins by also
  classifying as `invalid_response` instead of `persist_failed`.
- Records can't take `.max()` — use a `refine` on `Object.keys().length`
  (the codebase's `criteria` 2-255-entry bound is the pattern).
- Independent review (child `7ac8d994`): PASS/PASS after one fix round
  (Jev usage bounds mirrored to LLM).
- Full gate green at commit: lint, typecheck, 2982 unit/169 files, build,
  manifest, bundle, 43 e2e (1 intentional screenshot skip).

## 2026-10-05 — A07 completed (`50bde6b`)

- Invariant guards belong at the SOLE write path, inside the write's own
  transaction: `enqueueJob` checks+inserts in one `db.transaction("rw")`,
  so racing starts can't both pass and no caller can bypass the rule.
  Export the same query (`findLiveJobByKind`) for non-authoritative
  preflights that skip expensive work (a proposal send) — document that
  the transaction still owns the check.
- Raw `db.jobs` rows lack the `PersistedJob` overlay fields
  (`ownerGeneration`, `controlRevision`): any new read path must
  normalize via `parseJob(row)` exactly like `getJob`, or the table's
  wider row type fails assignment.
- `JobQueueError` relays differ per protocol: decisions' `mapError`
  passes any code-shaped `.code` verbatim; restructure's only admits
  codes its reply enum declares — a new wire code needs the enum member
  AND a safeParse fallback to `internal_error` for undeclared codes.
- Pre-run estimates must mirror the row's own accounting or the panel
  shows two different `totalBatches` meanings: bookmark batches + pair
  batches chunked at the same size. Keep the token fold bookmark-only
  but name/derive the batch counter like `progress.totalBatches`.
- Passing the persisted plan into the estimate (`options.plan`) kills
  double-planning AND the asymmetric throw surface: a planner failure
  then degrades to "no plan, no estimate" — exactly the pre-guard
  fallback semantics — instead of refusing a previously-allowed start.
- A07 guard fallout in fixtures: any test that models multiple live
  same-kind rows (recovery, superseded-owner loops) must seed the
  extras via `db.jobs.put` or terminate between iterations — the
  enqueue path will (correctly) refuse.
- Independent review (child `7ac8d994`): PASS/PASS after one fix round
  (plan reuse, RESTRUCTURE preflight, totalBatches drift).
- Full gate green at commit: lint, typecheck, 2995 unit/169 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).
- Retention discipline: write + prune share ONE rw transaction and every
  sweep hits an index, never materializes the table (`where("status")`,
  `recordedAt`-range, `[providerId+month]`) — the pattern already proven
  by `appendSentLog`'s count+orderBy-limit trim.
- Rollups must reproduce the raw-read aggregates exactly, INCLUDING
  quirks: `monthlyBudgetSnapshot` counts a cost-less row (which a
  `notBilled` row is) as `unknown` — so the llmUsage rollup keeps
  `notBilledRequests` as its own field; the snapshot-mirror read is
  `unknownCostRequests + notBilledRequests` and A05's provably-unsent
  distinction survives the fold.
- Dexie compound `[providerId+month]` silently drops rows lacking
  `month`: writers must materialize it at write time, and the version
  upgrade's `.upgrade()` backfill is what re-indexes pre-v5 rows.
- Caps that must hold continuously hook EVERY transition to terminal
  (both `enqueueJob` and `setJobStatus`), not just creation — rows that
  reach terminal state by mutation would otherwise bypass the bound.
- Component reads that must stay lazy: gate the liveQuery itself on the
  collapsed flag (`Promise.resolve([])`), page with `orderBy().limit()`,
  and read `count()` separately — don't fetch all rows to derive either.
- Independent review (child `7ac8d994`): PASS/PASS after one fix round
  (notBilledRequests preserves the A05 semantic in rollups).
- Full gate green at commit: lint, typecheck, 3009 unit/171 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

## Phase 3 Task 1: J01 + J02 + J09 (95e03fb)

- `failed` becoming a resumable status changes the lane rules: the A07
  one-live-job invariant only covers pending/running/paused, so BOTH
  `claimJobOwner` (failed->running) and `resumeJob` must re-check for a
  live same-kind job explicitly, or a dead-in-duplicate-lane resume can
  race two same-kind jobs.
- Resume dedupes against committed PROGRESS but a committed batch
  window is POSITIONAL in the original persisted lists (bookmarks AND
  plan pairs): filter live ids only inside the uncommitted tail, or one
  mid-window deletion silently re-runs committed sends and shifts the
  uncommitted tail left by one — the reviewer caught this.
- `budget_exceeded` is an `LlmGateError` code, not a
  `DecisionPipelineErrorCode` — it joins JOB_FATAL_ERROR_CODES because
  a budget refusal is permanently fatal, never an item-skip.
- drivePersistedJob error paths are ordered: mark `failed` with the
  redacted code, THEN re-throw — degrading the row and propagating the
  caller's typed refusal (`request_not_allowed` for BlocklistReadError)
  are both required; swallowing the throw dropped a typed contract.
- Per-item pause honored BEFORE each send (not just at batch drain)
  changes e2e semantics: the worker-restart test's resume now genuinely
  re-sends the uncommitted tail, which exposed a real Playwright gap —
  a persistent-profile service worker that spawns before context.route
  registration is NOT bound by routing, and --host-resolver-rules don't
  reach it either (verified: sends escaped to real api.typesafe.ai 401s).
  Deterministic fix: patch self.fetch inside that worker realm via
  worker.evaluate, scoped to the provider origin, plus a send-count
  assertion so a send-free completed can't pass vacuously.
- Worker waits for breaker.openUntil must chunk <=15s under MV3's ~30s
  idle limit; the wait loop re-reads the row each chunk so a
  pause/cancel/supersede landing mid-wait exits immediately.
- Independent review (child 7ac8d994): PASS/PASS across 4 rounds —
  lane-guard asymmetry, committed-window positional rule, the
  re-throw propagation, and the e2e fetch-patch scope all verified.
- Full gate green at commit: lint, typecheck, 3021 unit/171 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

## Phase 3 Task 2: J03 (9a64736)

- `chrome.storage.session` is the same-session discriminator: it survives
  service-worker eviction but clears on browser restart — a marker found
  at startup means "resume me", an empty store means "P06 pause rule".
  Putting markers anywhere durable (Dexie, storage.local) would break
  that distinction.
- Keepalive drains must be fire-and-forget: `relaunch` resolves only
  when the whole drive completes, and `resumeJobs` is behind the
  `startupRecovery` message barrier — an awaited drain holds EVERY
  message (Pause included) hostage for the job's remaining duration
  and serializes marked jobs on each alarm tick. `void relaunch().catch()`
  inside a try covers async rejections and sync throws both.
- Mark after winning the owner claim — every same-session drive point
  (startJob, resumeJob relaunch, watchdog re-drive) funnels through
  `drivePersistedJob`, so one mark/unmark site covers all of them;
  unmark on `finally` once the row leaves pending/running.
- New permissions need four fixtures in sync: `wxt.config.ts`,
  `store/permissions.md` (check-manifest parses the "required" table),
  `tests/unit/{scaffold,manifest}.test.ts` lists, and the
  `audit-release.test.ts` MANIFEST fixture — the full unit suite is the
  only thing that catches all four.
- `sleepCapped` preserves the full honored `retry-after` across ≤15s
  slices — cap the single wait, not the total delay, or the server's
  slow-down hint is silently weakened.
- Independent review (child 7ac8d994): PASS/PASS after one fix round
  (awaited drain → fire-and-forget launches).
- Full gate green at commit: lint, typecheck, 3029 unit/172 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

## Phase 3 Task 3: J04 + J05 (18fd66d)

- Deterministic ids: `decisionIdFor` hashes `(jobId, sorted bookmarkIds,
  kind)` with SHA-256 → v5-style UUID; both producers (analyze,
  merge_duplicates) share it, so a replayed batch upserts instead of
  duplicating. `persistDecision` runs the decided-lock + supersession
  inside ONE Dexie rw transaction — same-id decided rows return
  unchanged (status/undoSnapshotId are final); other undecided
  same-slot rows are bulk-deleted only when the incoming row is itself
  undecided (a decided document stored directly never deletes pending
  rows — the rejected-fixture test that predated supersession caught
  the ungated version).
- "Undecided" = pending+unsure only. "Decided" = approved, applied,
  auto_applied, rejected, reverted — decided rows are never superseded.
- **Resurrection fence (reviewer-caught):** supersession deletes by
  supersession, but a replay of the OLDER job re-derives the deleted
  row's deterministic id and re-puts it pending — then auto-apply
  would write the stale analysis over an already-applied row. Fence:
  `hasDecidedSlotRow` before `approveDecision` parks the resurrected
  proposal pending. Fence the apply, not the write — suppressing the
  write would block legitimate re-analysis after a rejection.
- Residual (accepted): the fence is sticky — any decided row in the
  slot disables auto-apply for that bookmark+kind until pruned;
  conservative and arguably desirable. Narrow TOCTOU between the
  fence read and approveDecision's own tx is bounded.
- **False-stale trap:** `minimizeBookmark`/`cleanUrlWithinBound` strip
  query/hash/credentials, so `DecisionGuard.snapshots` must hold the
  RAW send-time `{url,title}` from `options.bookmark` / the pair
  sides — never the minimized wire form — or every query-string URL
  trips `bookmark_edited` at apply.
- `assertFresh` covers url/title for add_tags, set_category and
  merge_duplicates (`staleReason: "bookmark_edited"`); `stale`
  propagates as its own `DecisionPipelineErrorCode` so the runner
  records a per-item skip (not in JOB_FATAL_ERROR_CODES) instead of
  `apply_failed` — honest codes in the itemFailures ring.
- Pipeline tests that pass `options.job` must seed a REAL job row via
  `enqueueJob` — `assertJobAuthority` in beforeSend rejects unknown
  job ids (pending+ownerGeneration 0 is permitted).
- `Table<Decision, string>` rows don't expose `guard` — cast
  `as DecisionRow[]` for guard assertions.
- Independent review (child 7ac8d994): PASS/PASS after one fix round
  (the resurrection fence above).
- Full gate green at commit: lint, typecheck, 3045 unit/173 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

## Phase 3 Task 4 — J06 + J07 + J08 (8a66fa9)

- **Mutual exclusion is two layers, not one.** In-worker `Map<string,
  Promise>` serializes same-context calls (`prior.then(run, run)`, the
  loser re-reads status fresh); the persisted `claim` sidecar covers
  cross-context races — `claimDecision` writes `{token, at}` inside one
  rw tx, `transitionStatus` verifies `claimToken` and refuses a live
  claim for tokenless/foreign-token calls, `releaseDecisionClaim`
  deletes only the holder's token. A 120s TTL rescues crashed claims;
  every success path deletes the claim, every failure path releases it.
- **`void p.finally(...)` leaks rejections** — the derived promise is
  unobserved (16 unhandled-rejection warnings in vitest). Cleanup hooks
  on a settling promise use `p.then(f, f)`, which swallows into a
  resolved derived promise.
- **`captureGuard` (the live-read fallback) captures placements only,**
  never url/title snapshots — those exist only on send-time guards. A
  test needing `bookmark_edited` staleness must seed `guard.snapshots`
  explicitly via `persistDecision(doc, {guard})`.
- **`db.decisions` is typed `Table<DecisionDocument>`** — sidecars
  (`guard`, `undoSnapshotId`, `claim`, `escalationSkipped`) are
  invisible to `get`/`update`; tests read rows via
  `as Promise<DecisionRow|undefined>` and write sidecars with a full
  `put` + `as DecisionRow` cast.
- **J07 strength choice:** "not persisted as approvable" was
  implemented as NO row at all for level-1/2 pairs (an `unsure` merge
  row is still approvable — `unsure → applied` is legal). Gated on
  `outcome === "unsure"` so any future sub-floor path also stays
  un-persisted; `DuplicatePairResult.decision` becomes optional.
- **Skip-markers can't ride the `escalation` schema object** (it
  requires verdict+model) — a `budget_exceeded` refusal surfaces as
  `{skipped:"budget"}` from `maybeEscalateDecision` → a NEW
  `escalationSkipped` sidecar via `persistDecision` options (same
  additive-field channel as `guard`), rendered by ReviewView.
- **Two `illegal_transition` surfaces never collide:** `JobQueueError`
  (lost job authority) maps to `DecisionPipelineError` by CLASS, while
  `DecisionApplyError` claim-loss stays inside `approveDecision`'s
  benign-skip branch — same code token, different classes, different
  semantics (runner-fatal vs per-item benign).
- **Mid-flow authority loss needs a seam,** not pre-seeding: spy on
  `db.jobs.get` — call 1 (Jev send's `beforeSend`) returns the real
  row, call 2 (escalation's `beforeSend`) returns a superseded row —
  the only two job reads in the flow.
- Independent review (child 7ac8d994): PASS/PASS, zero findings —
  verified claim-gate matrix, compensation coverage, serialize-map
  ordering, and the benign-loss scoping.
- Full gate green at commit: lint, typecheck, 3062 unit/173 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).


## Phase 3 Task 5 — J10 + J11 + J12 (2ba816f)

- **`withUndoLock` does NOT serialize same-context callers.** Its
  nested-call contract (`holdDepth > 0` → run inline) exists so undo
  internals never self-deadlock — but it means a second same-context
  `withUndoLock` executes inside the first's critical section. For
  mutual exclusion of independent same-context calls, wrap it in an
  in-worker promise chain (`Map<key, Promise>`; same shape as
  `serializeDecision`): chain orders same-context, Web Lock orders
  cross-context + undo replays.
- **Terminal-state records belong on the resource row**, written inside
  the lock at commit time: `job.restructure.applied` (schema-optional —
  `Job.parse` runs on every read, so the field must be in the strict
  schema or reads break). Replay returns the record verbatim; a stale
  record (snapshot popped by undo/discard) re-arms the real apply —
  liveness checked via `db.undo.get(applied.snapshotId)`.
- **`moved === 0` must be decided before `pushSnapshot`** — compute the
  pending-move list from live `get()` reads first; only then push the
  snapshot (capturing exactly the pending ids, not all resolved rows),
  else the stack accrues empty-effect entries that replay pointless
  moves. Folders created for a no-move batch are removed by the same
  confirmed-empty cleanup as failure compensation.
- **`undoExpected(snapshotId)` refuses BOTH empty stack and non-head id
  as `conflict`** — the `empty` branch is unreachable through it; map
  `conflict` → `stale` at the message layer (a stale undo handle, not a
  diff-stale). Wire schemas must require `snapshotId` or the refusal
  reaches `malformed_message` instead.
- **Managed detection needs ancestor propagation** — Chrome only marks
  the managed root; a child may carry no `unmodifiable` flag. Propagate
  the flag while flattening (same rule as the fake's
  `isInManagedSubtree`), and pre-filter at the DIFF so the mutation
  layer never sees a managed row: marking it `unresolved` skips it at
  apply instead of failing the batch mid-way.
- **`db.jobs.update(jobId, {restructure: {...freshPlan, applied}})`**
  replaces the nested object whole — merge from the fresh in-lock read,
  not the pre-lock validated copy.
- Independent review (child 7ac8d994): PASS/PASS, zero findings — verified
  the two-layer serialization ordering, the moved===0 no-snapshot path,
  record-write-in-try compensation invariant, and managed propagation.
- Full gate green at commit: lint, typecheck, 3069 unit/173 files,
  build, manifest, bundle, 43 e2e (1 intentional screenshot skip).

### Phase 3 Task 6 (J13 — `479aae2`)
- **Dedicated `restructureAssignments` table `[jobId+bookmarkId],jobId`** beats
  the per-batch merge alternative: the old merge re-parsed and re-put the
  whole job row per item (O(N²) serialized JSON writes for a 5k library,
  each write revalidating through `Job.parse`); the table makes the merge a
  single `bulkPut`, and last-write-wins rides on the compound PK for free.
- **Dexie nested-transaction scope rule: every outer `db.jobs` tx that
  transitively calls `setJobStatus`/`mergeRestructureAssignments`/
  `pruneTerminalJobsLocked` must list `db.restructureAssignments`** — a miss
  is a loud `TableNotIncludedInTransaction` throw (the RESUME handler
  broke until `resumeJob`'s inner tx was widened).
- **`restructurePlanFor` must preserve `applied`/`proposal`** via spread —
  only `assignments` is overridden by the table merge.
- **`latestRestructureJob` index idiom**: `.where("[kind+createdAt]")
  .between(["restructure", Dexie.minKey], ["restructure", Dexie.maxKey])
  .last()` — canonical Dexie prefix-scan; `.last()` in index order gives
  max createdAt with PK tiebreak.
- Independent review (child 7ac8d994): PASS/PASS, 11 info notes — flagged
  that `jobStateReply` still serializes the raw job with empty inline
  `assignments` (no src consumer reads it; diff carries the data) and that
  table rows skip `Job.parse` (producer-validated upstream).
- Full gate green at commit: lint, typecheck, 3073 unit, build, manifest,
  bundle, 43 e2e (1 intentional screenshot skip).

### Phase 3 Task 7 (J14 — `406de89`)
- **Re-admit at the persist call site, not inside `setBookmarkSummary`** —
  the db/meta layer stays free of Chrome-liveness checks; the admission
  codes surface verbatim as the `persist` stage code.
- **Bookmark-death sweeps must live behind a shared predicate**: the
  `onRemoved` cascade (removed-subtree ids) and the startup reconcile
  (ids absent from the live tree) are the same reviewable-row sweep —
  `pending`/`unsure`/`approved` die on ANY dead member; decided rows are
  history.
- **A decision sweep must skip rows under a live J06 claim** — a merge
  apply removes loser ids as its own action; deleting the row mid-apply
  races `transitionStatus` into `not_found` and compensates a completed
  merge (caught by independent review).
- **Reconcile's early-return can't gate on meta orphans alone** — a
  deleted bookmark may have NO meta row yet still leave decisions.
- **`popup:` synthetic ids are never tree ids** — exempt them from
  liveness tests in both paths.
- `.example` is an INTRANET_SUFFIXES host — admission returns
  `unsendable`, not `mismatch`; retarget tests need a normal public host.
- Independent review (child 7ac8d994): r1 caught the merge-apply race
  (Critical) + reconcile gap (Warning); r2 PASS/PASS.
- Full gate green at commit: lint, typecheck, 3077 unit, build, manifest,
  bundle, 43 e2e (1 intentional screenshot skip).

### Phase 3 checkpoint
- Full local gate + e2e verified on the committed tree `406de89`
  (post-J14, which is the last Phase 3 code change): lint, typecheck,
  3077 unit / 173 files, build, manifest, bundle, 43 e2e + 1 intentional
  screenshot skip — including the job pause/resume/cold-restart
  restructure resume specs. No manual checks (per plan).

### Task 1 (D01 — safe URL normalization) `07bb4ee`
- Scheme belongs in the dedup key: folding http→https could merge a
  redirect hop or differently-served page into its twin. New key shape:
  `scheme://[userinfo@]host[:port][/path][?query][#route]`.
- Route-like fragments (`#/`, `#!`) carry page identity — keep them
  verbatim; plain anchors still drop. Percent-encoded `#%2F` does NOT
  match the keep rule (rare residual fold, noted by review).
- `ref` stripping host-scoped to REF_TRACKING_HOSTS (amazon.com, dev.to,
  imdb.com, medium.com, reddit.com, dot-bounded suffix incl. subdomains);
  everywhere else kept — fail closed to distinctness. Repo `?ref=` now
  keeps identity.
- Normalized keys are ephemeral (group/import-plan/near-dup/popup all
  compute per call) — no migration needed.
- groupDuplicates' suppression is member-SET based, not key equality —
  scheme-prefixed keys can't confuse it.
- Suggestion-only merge is already structural: evaluatePolicy never
  auto-applies merge_duplicates; DuplicatesView needs keep-pick+confirm.
- Stale fixtures: tests that relied on http↔https folding retuned to
  same-scheme variants (www./utm_*) — duplicates-group, search-run
  collectDuplicateIds, decisions-candidates near-dup exclusion.
- Independent review (child 7ac8d994): PASS/PASS first round, 8 info notes.
- Full gate green at commit: lint, typecheck, 3084 unit, build, manifest,
  bundle, 43 e2e + 1 intentional screenshot skip.

### Task 2 (D02+D03+D04 — safe merge) `82f8eb9`
- Drift anchor is the kept node's LIVE url — not the group key: comparing
  members to the recorded key could merge them onto a kept node that
  itself drifted to a different page.
- Dropped members must be excluded from BOTH snapshot meta and the union:
  snapshotting their rows would let undo clobber a still-live bookmark's
  newer edits.
- patchMeta survivor write LAST (after removals + loser-meta cleanup) is
  what makes retry idempotent: if it ran, no loser rows remain to
  re-append; if the merge failed earlier, the kept row is original.
- `discardById` (never "latest") when removedIds==[] — a nothing-changed
  merge leaves no phantom snapshot for undo to replay/duplicate.
- All-vanished/drifted → no-op success, `snapshotId: undefined` — pushing
  an empty snapshot would only let undo clobber kept meta.
- Fixture trap: managed-loser test needed a REAL duplicate URL — under
  D02 a non-matching URL is legitimately dropped before removeTree ever
  runs.
- db.undo.add spy pattern for interleave tests: wrap the table's add, fire
  the foreign pushSnapshot inside it (kind check prevents recursion).
- Independent review (child 7ac8d994): PASS/PASS first round; double-append
  reasoning stress-tested and held under all retry shapes.
- Full gate green at commit: lint, typecheck, 3089 unit, build, manifest,
  bundle, 43 e2e + 1 intentional screenshot skip.

### Task 3 (D05+D06+D10+D11 — undo retention, peek, tag-delete, lock token) `f578409`
- Per-origin retention: optional `origin` on UndoSnapshot (absent=user
  back-compat); pushSnapshot tx now covers undo+decisions so the
  protected-id read shares the write snapshot. Protection = undoSnapshotId
  sidecars on decisions with status ∉ {rejected, reverted}; a protected
  row survives INSIDE the cap, not exempt from the count.
- Decision-origin callers: apply.ts pushMetaUndo/applyMove, applyMerge
  (mergeGroup origin param, default user), restructure/apply. UI merge +
  tag-ops stay user.
- peekLatest reverse cursor: toCollection().reverse().first(), then
  where(":id").below(id).reverse().first() on corrupt rows — same
  invalid⇒absent rule as listSnapshots.
- D10: single tx {tags, bookmarkMeta, undo, decisions} — nested txs join
  when inner tables ⊆ outer (the J13 rule, again).
- D11: UndoLockHold branded token; activeHolds membership = liveness;
  joiners tracked in hold.pending, drained in a `while(size)` allSettled
  loop BEFORE the platform release — a joiner's tail can never escape
  the section. Token-less/stale calls always request the platform lock
  (honest queue/deadlock instead of silent bypass).
- Declare-only brands don't exist at runtime — `declare const X: unique
  symbol` used as a computed key is a ReferenceError; real `Symbol()`
  const infers `unique symbol` AND works at runtime.
- TEST TRAP: gating `db.undo.toArray` now hits pushSnapshot's own tx read
  → awaiting a foreign promise inside a Dexie tx = PrematureCommit
  (raw DexieError escapes where tests expect typed failures). Gate
  peekLatest's read path instead: wrap `toCollection()`'s reverse().first
  chain on the returned collection instance.
- Residual (review-noted): a decision's own snapshot is unprotected in
  the push→transitionStatus record gap — needs ~20 concurrent decision
  pushes inside a sub-ms window; accepted.
- Residual: node bound counts nodes not meta bytes — the "byte/node"
  bound is honored as the node half.
- Independent review (child 7ac8d994): PASS/PASS first round, 9 info notes.
- Full gate green at commit: lint, typecheck, 3100 unit, build, manifest,
  bundle, 43 e2e + 1 intentional screenshot skip.

## Phase 4 Task 4 — D07+D09 (a7c3f85)

- **Targeted undo (`restoreById`)** replaces head-check (`undoExpected`) for
  toast, palette, and decision revert/compensate paths. `db.undo.get(id)` +
  `safeParse` inside `withUndoLock`; missing/corrupt → `{ok:false,code:"empty"}`.
  `empty`/`conflict` map onto `undo_conflict` in decisions.
- **False-negative shared everywhere it lived:** a decision toast's Undo via
  REVERT_DECISION `undo_conflict`ed on non-head exactly like the panel toast —
  reviewer flagged; switched compensate+revert too.
- **No-op-merge hazard found via review:** `snapshotId: undefined` + `undoable`
  fell back to `undoLatest` → pops an UNRELATED head. Now `undoable` requires a
  real id and the in-view fallback reports "Nothing to undo".
- **Merge undo (D09a):** union can't express "user deleted a merged field" —
  `recorded ∪ (current − merged)` where `merged` is recomputed from recorded
  member rows exactly as `mergeMemberMeta` builds it. A field the merge wrote
  that matches `merged` reverts; anything else is a post-merge edit and survives.
  `MERGE_NOTES_SEPARATOR` moved to `schemas/meta.ts` — importing from merge.ts
  in restore.ts creates a `restore→merge→restore` cycle.
- **Move undo (D09b):** `movedToParentId` (destination at capture) vs `parentId`
  (original). Absent = pre-D09 unconditional restore.
- **Test gates:** `db.undo.get` is `restoreById`'s read — gate it via
  `spyOn(db.undo,"get")` chaining `PromiseExtended`, NOT `toCollection`
  (that's peekLatest's path).
- **Fixture trap:** the fake's `get(id)` returns `Promise<FakeNode[]>` (array) —
  assert `[0]`/`toMatchObject([...])`. Merge fixtures must model the REAL
  `mergeMemberMeta` output (verbatim kept-first tag union, `\n\n---\n\n` notes
  join) or the union semantics legitimately read them as post-merge edits.

## Phase 4 Task 5 — D08 (a2777bd)

- **Verify cache in mutations:** `MutationVerifyCache` (nodes/parents/
  childCounts) — positive hits only; failures never cached; staleness
  defers to the API (`api`-typed), never fabricates success. Fresh per
  replay, never shared.
- **Child-count locality:** `childCount(parentId)` seeds once per distinct
  folder; a JUST-created folder seeds `0` by construction — internal
  folders of a restored subtree never hit the API. mutations keeps seeded
  counts exact on its own create/move writes (create +1, cross-parent
  move src−1/dst+1).
- **Batched idMap:** `persistProgress` batches 50 mappings per `modify`
  (per-node was O(n²) bytes). The WHOLE dispatch + the pop sit in a try —
  catch flushes the tail so a retried typed failure resumes with zero
  duplicates; a hard kill loses ≤49.
- **`flushProgress` guard:** no-op when `unpersisted === 0` — a failed
  restore that created nothing must not write an empty `idMap` (pinned by
  undo.test.ts restructure tests).
- **Cache invalidation on removeNode:** it is deliberately not
  cache-aware (empty-folder guard needs live children), so a remove must
  `childCounts.delete(parent)` — a stale high-water count would
  over-allow later indexes.
- **Test spy trick:** `db.undo.where` is reached ONLY by persistProgress
  in the replay path — a `vi.spyOn(db.undo, "where")` counts flushes
  without touching Dexie internals. `fake.getChildren` counts all reads
  through mutations too (the module wraps the same fake).

## Task 6 — D12 + D13 (metadata tombstones + row schema versions)

- **Tombstone model:** `metaTombstones` pk `url` — the witnessed-remove path
  keys by the node's snapshot URL (freshest); the reconcile path falls back
  to the row's own `meta.url` (only URL available for unwitnessed orphans).
  `BookmarkMeta` therefore carries an optional `url` field — populated
  opportunistically at write paths that know the node (merge survivor,
  import sidecar, EditDialog post-edit url, popup save, restore).
- **Re-attach:** `reattachTombstone` consumes unconditionally — expired
  tombstone, valid live incumbent, or successful attach all end with the
  row gone, so a second same-URL create can't inherit stale data. An
  UNPARSEABLE incumbent counts as absent (reviewer note applied): the
  attach proceeds and `commitMeta`'s corrupt-retention keeps its copy.
- **D13:** `schemaVersion: z.literal(1).optional()` — new writes stamp 1,
  absent = pre-D13 (still read), any other failure is counted +
  surfaced under the `metaIntegrity` metadata key and retained to
  `corruptMeta` (cap 50) before any overwrite/delete. `url` is not a
  lazy-row field — a url-only write still produces no row.
- **Dexie nested-tx rule bit again:** every ambient `rw` transaction
  covering `bookmarkMeta` now also covers `corruptMeta` (patchMeta's
  retain fires inside the ambient scope) — tag-ops bulk paths,
  deleteTagWithUndo, the cascade tx all widened.
- **Undo:** `nodeExists(id, ctx?, expectedUrl?)` — a live id whose node
  url differs counts as dead: snapshot nodes pass `node.url`, meta rows
  pass `meta.url`, folders stay id-only. Repointed ids take the recreate
  path and meta follows via idMap.
- **Slept-create gap:** reconcile offers every live URL to
  `reattachTombstone` on the CONFIRMING tree read — an MV3 worker that
  slept through a create still re-attaches within retention.
- Decisions are not re-attached — tombstones carry meta only; a removed
  bookmark's pending suggestions stay deleted (J14) — semantic seam
  noted for the track file.

## Task 7 — D14 (search/omnibox cost)

- **Shared index:** `sharedSearchIndex()` = worker-lifetime `{generation,
  promise}` cache in `src/search/omnibox.ts`; `invalidateSearchIndex()`
  only bumps the generation — rebuild is lazy on next access and a
  pre-bump handle is never re-served. A failed build resolves `null` and
  self-evicts so the next call retries (reviewer Info fix).
- **Cross-context invalidation:** `META_CHANGED_CHANNEL`
  BroadcastChannel — `emitMetaChanged()` fires in `commitMeta`,
  `rewriteTagRows`, `deleteMetaByIds`, `tombstoneMetaByIds`, and
  `delete-all.ts`'s `db.delete()` reset (reviewer Warning: the drop
  bypasses every repo write — emit directly). Bookmark events bump via
  listeners in the same worker.
- **`bookmarks-changed` broadcast deleted whole** — schemas, types,
  `declare const chrome`, the `z` import. Zero receivers existed; tests
  now pin `sendMessage` NEVER called.
- **group.ts dedupe:** member-set fingerprint (sorted ids, NUL-joined)
  indexed in a Set — O(1) per normalized bucket; 5k-group bound test at
  2s (indexed path ~tens of ms).
- Fake reorder helper wants the FULL child-id permutation of the target
  parent; `fake.create` needs explicit `parentId: BOOKMARKS_BAR_ID` to
  land in the bar.

## Task 8 — D15 (one scheme policy)

- **One normalizer, two policies:** `urlScheme()` in
  `src/search/openable.ts` is THE shared scheme read — strip
  `\x00-\x20` (all C0 + space) → anchored `scheme:` extract →
  lowercase. `isOpenableUrl` (allowlist http/https/mailto/ftp) and
  netscape's `isBlockedScheme` (blocklist javascript/data/vbscript)
  both consume it, so no obfuscated spelling can split the guards.
- **Space-strip closed a real hole:** old openable stripped only
  `\t\n\r`, so `java script:` was openable while browsers
  normalize+execute it; `\x01javascript:` survived the anchored regex
  too. Both pinned shut in the shared fixture table now.
- **Denylist → allowlist widens the closed set:** vbscript/blob/
  view-source/file/tel/about/chrome(-extension)/relative/unknown are
  all not openable; e2e open-paths had used `chrome-extension://`
  bookmarks (offline-resolving) and moved to `context.route`-faked
  https targets.
- **NBSP is NOT stripped** (outside \x00-\x20): `\u00a0javascript:`
  reads as no-scheme → not openable, not import-blocked — matches
  pre-change isBlockedScheme semantics and WHATWG trimming; harmless.
- **netscape.ts imports from search/** — new edge in the other
  direction (io → search leaf); openable.ts stays a pure leaf.
- Omnibox suggestion flow filters non-openable hits entirely (existing
  behavior, review Info) — sidepanel/palette show rows with disabled
  opens instead.

## Phase 5 Task 1 — I05+I06 (CSV round trip / deep export)

- **`'`-strip is the inverse escape**, applied in the row `cell()` accessor:
  one leading `'` only when followed by a formula trigger. Same regex on
  both sides keeps the two directions exactly paired.
- **Unterminated-`"` recovery**: split the EOF-quoted cell at its first
  physical newline; head record reports `unterminated quoted field; N
  following record(s) recovered`; tail re-parses once with recovery OFF —
  a second bad quote forfeits only its own tail, no recursion.
- **Delimiter escapes**: `\`-escape ONLY `\` and the delimiter (`/` in
  folder_path, `;` in tag cells). Unknown `\x` stays literal — foreign
  files lose nothing. `joinFolderPath`/`splitFolderPath`/`joinTags`/
  `splitTags` are THE wire helpers; the import writer splits via them.
- **pathKey must not be a joined string** (reviewer Warning): decoded
  segments joined on `/` collides a literal `A/B` title with nested A → B.
  Key on `JSON.stringify(segments)` instead.
- **Depth flatten boundary**: `depth + 1 >= MAX_TREE_DEPTH` — the children
  array at the cap must be ALL-childless; childless children (bookmarks
  AND empty folders) keep their nodes, deeper subtrees hoist bookmarks
  depth-first. Inbound `exceedsMaxDepth` unchanged.
- **e2e open-paths**: allowlist-era targets must be `context.route`-faked
  https, not `chrome-extension://` (D15 precedent reused here).

## Phase 5 Task 2 — I03+I04 (tags / duplicate merge)

- **`existingUrls` Set→Map (normKey→nodeId)** is what lets a skipped dup
  merge into its live twin — collect first-occurrence wins, the plan
  records `skipped[]` entries carrying file meta + `existingId`.
- **Two merge paths, different field coverage by design**: plan-time
  `mergeImportMeta` (file-side siblings) keeps `summary`; write-time
  `existingId` merge stays spec-precise (tags/category/notes only) — a
  file's summary is often machine-generated and shouldn't stick to a
  curated library bookmark.
- **`patchMeta` lazily creates rows** → a dead `existingId` must be
  liveness-checked via `getBookmarkNodes` first or the merge writes a
  dangling meta row.
- **`sanitizeImportTags` returns {name,key}**: `name` feeds `createTag`
  (first-seen display wins), `key` is what meta rows store — defs must be
  created from item AND skipped-dup metas or imported tags exist but are
  invisible/unrenamable.
- **Commit-splitting a shared file**: `git stash -- <file>` +
  `git apply --cached` of a hunk-subset patch stages part of one file;
  when a LATER task already rewrote the file, restore the earlier content
  verbatim from context, verify tests, commit, then reapply the new work.

## Phase 5 Task 3 — I01 resumable import (7e77e1e)

- **Two-table persistence**: the flattened queue row is written ONCE; the
  cursor/counters row is rewritten per item — keeps per-item persistence
  at O(1) instead of O(N) (the J13 lesson applied to imports).
- **Rows-deleted-on-exit = resumable-by-existence**: completion AND clean
  cancel both delete both rows, so `listInterruptedImports` is a bare
  table read — no "resumable" flag to keep honest.
- **Cancel needs two channels**: in-page `AbortSignal` + persisted
  `cancelled` status read per item (cross-context Cancel button flips
  the row; the driver polls it at item boundaries).
- **Single-flight on resume**: `claimedBy` + 60s TTL on `updatedAt`
  claimed inside ONE Dexie transaction; the driver re-checks the token
  per boundary read and stands down WITHOUT deleting on takeover — the
  new owner finishes the rows. (J06 claim pattern, reviewer-suggested.)
- **One failure writer**: helpers (`writeMeta`, `restoreTagDefs`,
  `ensureImportTagDefs`, `mergeSkippedDuplicates`) take `state`/a
  `record` callback into `recordFailure` (capped 200; `failureCount`
  keeps the true total). An uncapped `summary.failures` alias would make
  `ImportState.parse` reject past 200 → persist throws → import can
  never finish while perpetually offering Resume (reviewer Warning 2).
- **Resume failure reconstruction**: folders left of cursor absent from
  `folderIds` ⇒ their subtree fails with the same cascade; a missing
  parentId ⇒ subtree failure, never a guessed parent.
- **`ImportStateMeta` bounds are STORAGE bounds** (looser than
  `BookmarkMeta`) — clamping to BookmarkMeta bounds at flatten would
  launder violations `putMeta` should record as `meta` failures.

## Phase 5 Task 4 — I02 + I07 dialogs (commit per git log)

- **Synchronous re-entrancy guard needs try/finally**: a plain post-await
  `importingRef = false` bricks the dialog when the awaited call throws
  OUTSIDE its typed-result contract (Dexie put before driveImport's
  try/catch). Refs go in `finally`; the `catch` surfaces an honest
  `interrupted` error back on preview/resume. (reviewer Warning.)
- **Resume-offer latch**: `setStage((c) => (c === "pick" ? "resume" : c))`
  — a late `listInterruptedImports` resolution can only enter "resume"
  from "pick", never hijack an in-flight or finished flow.
- **Radix close funnel**: Esc, overlay pointer-down, and the X button all
  reach `onOpenChange` — one `if (!next && importingRef.current) return`
  makes every close path inert while a run is live.
- **Reset kills stale runs**: `runRef.current += 1` in `reset()`; after
  each await, `if (runRef.current !== run) return` before touching state.
- **Radix test trick**: fireEvent/act flushes between synthetic events —
  to exercise a same-tick ref guard, capture the element and fire two
  raw `dispatchEvent(new MouseEvent("click",{bubbles:true}))`.

## Phase 5 checkpoint — verification only (gate run at task-4 head)

Lint, tsc, 3165 unit, build, manifest, bundle, 43+1 e2e all green on the
task-4 commit (bc54631) — including the import/export e2e specs
(core-manager JSON import round-trip, audit-data-safety export/import).
Phase 5 closed: I05/I06, I03/I04, I01, I02/I07 all landed and reviewed.

## Phase 6 Task 1 — U01 confirmed, undoable Approve-all

- **Batch revert beats aggregate snapshot**: every applied decision row
  already carries its own `undoSnapshotId`, so a `REVERT_BATCH` intent that
  replays each row's snapshot in REVERSE order gives the spec's "Undo
  reverts the whole batch" without inventing an aggregate `UndoKind`.
  Reverse order is REQUIRED, not cosmetic: sequential changes on one
  bookmark (A→B then A→C) only unwind to the original newest-first.
- **`state_unrecorded` folds into `reverted`**, never `failed` — the
  replay already ran; counting it failed would re-arm an Undo the store
  must refuse on a consumed snapshot. Result carries ids (`string[]`), not
  rows — a row that vanishes mid-batch can't break the fold.
- **Ref-vs-state busy guard**: `bulkBusyRef` (synchronous, checked in the
  confirm handler before any await) guards double-dispatch; `bulkBusy`
  state only drives the disabled UI. Both clear in `finally` — the I02
  brick lesson applied to dialogs.
- **Toast arm order**: `reportToast` disarms stale revert targets on every
  new toast — `showToast` must run BEFORE `onApplied(ids)` at every site,
  so the arm lands after the disarm.
- **Single vs batch degrade**: the shell's revert target is an id list —
  length 1 sends `REVERT_DECISION` (unchanged semantics incl. its
  `state_unrecorded` path), >1 sends `REVERT_BATCH`. A batch undo that
  fails down to one remaining id retries through `REVERT_DECISION`.

## Phase 6 Task 2 — U02 Analyze through the job queue

- **`analyze_selection` ≠ `library_scan`**: the kind for a user selection —
  categorize+tags only, matching the old per-id `analyzeBookmark` loop.
  `library_scan` would plan near-duplicate pairs over a subset — a
  different, misleading feature.
- **Track the LATEST kind-row, not the started id** (ScanPanel's model):
  `useLiveQuery(latestKindJob)` re-attaches controls after a remount;
  id-keyed tracking orphans them. `dismissedJobId` hides exactly one
  terminal row — a newer job resurfaces regardless.
- **Fail-closed on read failure**: `null` = "no row" (launcher free),
  a sentinel = "read failed" (launcher disabled, 'status unavailable'
  card) — folding a Dexie read error into `null` re-opens the double-
  enqueue window. `.catch` must return the sentinel, not `undefined`.
- **Pending-read gate**: `analyzeJobRead === undefined` (first read, and
  the gap right after JOB_START) disables the launcher — without it a
  fast second confirm enqueues a second job.
- **eslint `react-hooks/set-state-in-effect`**: derive resets during
  render instead — keep `prev` state, compare, adjust. The effect form of
  "reset flag when X recovers" is banned by the lint config.
- **Test flake pattern**: a live-query card's FIRST emission can be an
  intermediate state (`pending` before the worker flips `running`) —
  assert terminal/expected text with `waitFor`, never on first render.

## Phase 6 Task 3 — U03 RestructureView re-entrancy/polling

- **setPhase-as-read is an anti-pattern**: calling the updater purely to
  observe current state runs a side-effect inside what React treats as a
  pure function (StrictMode double-invokes → double refresh). Mirror
  state into a ref via a passive effect for interval/timer readers.
- **Serialize + coalesce are different needs, and you need both.**
  `tail.then(fn)` alone still banks every tick — each queued link fires
  its own send later (self-amplifying on a slow worker, and stale by the
  time it runs). Caller-driven reads always queue (each intent deserves
  its own answer); poll ticks get a pending-flag so at most one poll
  link is outstanding. Reviewer caught this as the only Warning.
- **A poll that reads "nothing" must not tear down in-flight phases**:
  not_found → idle only from settled phases (idle/active). A poll
  landing between send and reply otherwise clobbers consent/confirm/arm.
- **Test timeouts**: vitest's default 5s test timeout silently kills
  polling tests that legitimately wait ~9s — pass the per-test timeout
  argument, don't lower waitFor timeouts below the poll cadence.
- **Backticks in `git -m` strings get eaten by bash** — use single
  quotes for commit/notes bodies containing code tokens.

## Phase 6 Task 4 — U04+U05 keyboard safety + dnd indices

- **React portals leak keys through the React tree**: a Radix
  ContextMenu.Portal's children bubble keydowns up to listbox onKeyDown
  while their DOM sits in document.body. `currentTarget.contains(target)`
  is the discriminator — portal children fail it, every legit in-list
  target passes (the listbox itself counts as contained).
- **Async keyboard actions need a promise-lived re-entrancy ref**: set it
  before dispatching, clear when the handler's promise settles — and
  wrap the call in `Promise.resolve().then(() => fn())` so a
  synchronously-throwing handler becomes a rejection that still clears
  (reviewer Info). `void fn()` prop wiring silently drops the promise and
  defeats the guard — pass the promise through.
- **event.repeat on held keys**: `keydown` autorepeat fires with
  repeat=true; guard with it before the in-flight ref check.
- **Chrome move() is post-removal indexed**: for same-parent forward
  moves, count dragged siblings before the slot
  (removedBefore), rebase base = index - removedBefore, and place the
  block DESCENDING move(node_i, base+i) — each insert lands at its final
  position undisturbed. Backward/cross-parent keep forward index+moved.
- **Spy the method the path actually calls**: deleteNodesWithUndo uses
  removeTree uniformly (leaf or folder) — spying fake.remove saw 0 calls.

## Phase 6 Task 5 — U06 worker-side quick save + popup errors

- **One worker message per destructive sequence**: the popup is a
  destroyable context — any multi-step write run from it can die
  mid-chain. Moving the whole quick save behind one SAVE message makes
  "popup closed" unobservable to the write path; the test proves it with
  a slow fake.create + cleanup() while the send is in flight.
- **Message bounds must match store bounds**: a field valid at the
  protocol but invalid at the store unwinds a created bookmark into a
  bare internal_error (reviewer Warning). Cap message fields at the
  store's constants (NOTES_MAX_LENGTH, TagDef name 64) and bound the
  inputs at the source (maxLength) so malformed input never leaves the
  form.
- **Derived data must be re-derived or re-checked, never trusted**:
  tag chips carry {key,label}; validating key === tagNameKey(label)
  at the schema stops a mismatched pair from writing a meta reference
  to a def that was never created.
- **Dexie multiEntry for "rows that mention X"**: *bookmarkIds on
  decisions lets the popup ask "rows for THIS bookmark" via where()
  instead of scanning pending+unsure — same row set/order as
  listReviewable (rows without bookmarkIds are simply unindexed).
- **Promise<boolean>, not throw, across UI chrome helpers**:
  openSidePanel/sendSaveMessage return results so failures surface via
  setError uniformly; the sidePanel open call still dispatches
  synchronously inside the gesture tick (async fn runs sync to first
  await).
- **Table-level mocks leak**: spying db.tags.get swallows EVERY caller
  (createTag's own existence check, patchMeta validation). Scope to
  mockResolvedValueOnce so only the call under test misses.

## Phase 6 Task 6 — U07 (408ec52)

- **Delta-over-snapshot for edit dialogs**: diff the staged state against
  the OPENING snapshot, then apply deltas through live-row read-modify-write
  helpers (bulkAddTag/bulkRemoveTag are each one Dexie RMW tx). A whole-list
  rewrite from a stale snapshot clobbers tags applied externally while the
  dialog was open; per-op deltas compose with concurrent writers.
- **patchMeta is a merge**: sending only changed fields means untouched
  fields keep whatever value is live at write time — the missing-key IS
  the "leave it alone" signal, `null` is the explicit clear.
- **Consume-on-resolve handoff**: stash keys (session storage handoffs)
  should be cleared only after the referenced entity resolves. Keep the
  key on failure and retry on the next trigger (a tree-change effect
  re-runs naturally); compare-then-clear guards against a newer stash
  landing between the read and the remove.
- **Invisible-tree test observability**: a created node under a collapsed
  parent never renders a treeitem, and title-only changes may not re-derive
  the model. Spy on the data layer (fake.getTree) and waitFor the call
  count to advance past the load-time read to prove the refresh landed.
- **Verify before writing**: the duplicates banner clause needed zero code —
  the correct implementation landed under D07+D09 and is pinned by an
  existing test. Check spec items against current code before implementing.

## Phase 6 Task 7 — U08 (5473200)

- **Radix focus restore needs a trigger**: DialogContentModal's default
  onCloseAutoFocus focuses context.triggerRef and preventDefaults the
  FocusScope restore — with no Radix trigger (context-menu open) it
  no-ops and strands focus on <body>. Capture document.activeElement in
  onOpenAutoFocus (it fires BEFORE the scope moves focus) and restore it
  in onCloseAutoFocus with an isConnected guard.
- **Radix owns Title ids**: passing your own id to DialogTitle renders
  the id but leaves aria-labelledby pointing at the generated context id
  — a dangling reference. Let Radix wire it; tests should resolve the
  referenced element, not hardcode an id.
- **Radix v2 has no aria-modal**: modality is enforced via inert siblings.
  Assert the labelledby linkage and focus behavior instead of the attr.
- **react-hooks/refs bans ref writes during render**: capture pre-open
  DOM state inside the autofocus event hook instead — it runs before the
  focus scope moves focus.
- **Single named dismiss**: when a labeled footer button is the close
  control, hide the icon-only X (its sr-only "Close" name creates a
  duplicate accessible name and an unlabeled affordance).
- **Fire-and-forget sends get "Continue in background"**: no cancel
  message exists, so honesty is the label, not a pretend-cancel.
- **git wrapper requires -m**: `-F` is rejected; avoid apostrophes in
  `-m` bodies (they terminate the single-quoted arg early and silently
  truncate the message — verify %B after committing).

### U09 — Options correctness (c9c2520)

- **`.partial()` on a defaulted strictObject re-injects defaults**: for a
  patch message, `AutoApplyToggles.partial()` still applies each field's
  `.default(false)` during parse, so `{add_tags: true}` comes back with
  `set_category: false` — the "patch" clobbers a concurrent toggle with a
  default it never sent. Write explicit `.optional()` fields in the patch
  schema.
- **Patch merges need a serialized write chain, not just RMW**: two
  options contexts can each read-then-write through the worker; a
  module-level `chain.then(op, op)` in background.ts makes every patch
  atomic. Cross-context IndexedDB transactions do not give you that.
- **Permissions granted after a preset switch leak**: `permissions.request`
  resolves regardless of which preset panel is live — a grant that lands
  stale must be explicitly `permissions.remove`d before dropping the
  reply. But a grant whose ENABLE already persisted must stay: the
  enabled provider needs it.
- **`useLiveQuery` count() watches whole tables**: `count()` marks the
  table range, so any put/add/delete re-fires it — same-key replaces DO
  propagate. Refresh budget/status panels through the worker protocol on
  the revision bump rather than reading tables directly.
- **Live status reloads must not clobber in-progress edits**: a refresh
  that repopulates a form field while the user types loses their edit —
  guard with a dirty ref cleared on save.
- **`Number()` accepts `0x10`, `1e3`, `Infinity`, and padded whitespace**:
  validate money fields with `/^\d+(?:\.\d+)?$/` before parsing.
- **Two mounted pages share element ids**: `htmlFor`/`id` label
  associations are document-global, so per-container by-label queries
  fail when the same component mounts twice — scope by a unique
  attribute (e.g. placeholder) instead.

### U10 — error boundaries
- **`unhandledrejection` is only half the uncaught surface**: synchronous
  throws in event handlers fire a window `error` event instead — install
  both listeners or that class stays console-only. (Reviewer info note;
  closed it in-place.)
- **React 19 reports boundary-caught errors too**: `componentDidCatch` is
  the report hook; the fallback is only the display — do not rely on the
  default `onCaughtError` reaching a diagnostics sink.
- **Never persist `error.stack` in the diagnostics ring**: stacks embed
  file paths/URLs; name + truncated message is the inspectable shape.
- **Listeners installed on `window` outlive the test that added them**:
  later dispatched events hit every registered listener — assert on the
  row filtered by its `surface`, not `records.at(-1)`.
- **jsdom `window.location.reload` is non-configurable**: pin the Reload
  control's presence and click-safety instead of spying on the call.
- **TS `override` rules**: `componentDidCatch`/`render`/`state` require
  `override`; `static getDerivedStateFromError` must not carry it (not
  declared on the base class).
- **Fail-soft reporting**: a diagnostics-ring write failure must be
  swallowed — reporting a failure must never throw into a degraded page.

### U11 — sidepanel render cost
- **`useLiveQuery` queriers can gate on render state**: putting `open` in
  the deps and making the querier return a resolved `[]` without touching
  any table means a closed dialog installs zero Dexie observation ranges
  — writes cannot re-fire it. You do not need conditional component
  mounts (which would kill the close animation) to stop hidden queries.
- **Escalate the coalescing window on contention, not on event count**:
  `contended` = an event arrived while a refresh was already pending
  (armed timer OR in-flight read). Each contended cycle bumps the wait
  (50→100→200→400→500ms), an uncontended one decays, and a quiet gap
  longer than the cap resets outright — synchronous bursts still collapse
  to one read (escalation only affects the NEXT arming), and isolated
  writes keep short latency.
- **Read the burst level at fire, apply it at next arm**: an armed
  setTimeout delay cannot be retargeted — update the level in the fire
  callback and let the next `schedule()` pick it up. No extra state.
- **`Date.now()` under `vi.useFakeTimers` is mocked consistently** — a
  quiet-gap check works identically in tests and production.
- **Spy on `db.<table>.toArray` to prove "no live queries"** — module
  spies cannot intercept direct ESM bindings, but the Dexie table method
  is the observable sink every repo list goes through.

## Phase 7 Task 1 (H01+H02 — provider setup rollback, key hygiene)

- `unwindEnable`/`unwindConfigure` became snapshot-then-restore: capture raw
  `db.metadata` rows, `readProviderKey`/`readCredential` plaintext (catch →
  null), and a scoped `hasConsentAtOrigin` flag BEFORE the first write, then
  put-back-or-delete per piece. The raw-row restore keeps even a malformed
  prior row byte-for-byte. A fresh enable's empty snapshot collapses to the
  old unconditional delete — existing unwind tests keep passing.
- Consent restore is scoped to exactly the scope the flow grants — never
  `revokeConsentsAtOrigin` on the failure path, which would wipe sibling
  scopes a real send consented to earlier.
- LLM carry-forward: `messageHasBudget` (either field present) gates
  monthlyBudgetUsd/Unlimited; prior `provider.pricing` merges into
  `message.settings` only when the message omits pricing. `LLM_BUDGET_SET`
  stays the sole way to clear.
- Envelope ops serialize per material id via a self-draining
  `Map<id, Promise<void>>` chain (`prev.then(op, op)`; entry removed on
  settle) — the `7k4` TOCTOU where a save writes under a since-deleted
  CryptoKey is unreachable; reads serialize too so a mid-delete read sees
  before-or-after, never torn.
- `ProviderApiKey` (`trim().min(1).regex(/^[\x21-\x7e]+$/)`) lives in
  `schemas/provider.ts` and feeds both `ENABLE_PROVIDER.key` and
  `LLM_CONFIGURE.key` — trimmed value flows to `keyDisplaySuffix` and the
  credential store; rejects surface as `malformed_message` with zero writes.
- vi.hoisted-backed stateful key-store double: mocking `readProviderKey` to
  always-truthy would have made every snapshot look key-backed and broken
  the restore-vs-delete distinction — the map must actually persist what
  `saveProviderKey` writes.
- Reviewer verified: plaintext re-save is the right restore (raw-envelope
  bytes could reattach to a rotated key) and verbatim active-pointer
  restore is strictly better than delete-if-pointing-here.

## Phase 7 Task 2 (H03 — wider egress lint)

- `restrictedEgressGlobals` mechanically generates both rule sets, so the
  five names cannot drift apart: `no-restricted-globals` for bare
  references, `no-restricted-properties` for `globalThis`/`self`/`window`
  member forms. `navigator.sendBeacon` is property-only.
- `no-restricted-properties` requires a bare-identifier object —
  `window.navigator.sendBeacon(...)` chains past it. A
  `no-restricted-syntax` CallExpression selector keyed on
  `*.navigator.sendBeacon` closes that hole (reviewer's Info note, adopted).
- Lint-rule tests run the REAL flat config: `new ESLint({cwd})` +
  `lintText(code, {filePath})` matches `files:` globs against the virtual
  path — no fixture files on disk, no re-implemented config.
- `/* global importScripts */` (not `declare function`) keeps a worker
  global a global reference — a module-scope `declare` shadows it and the
  restriction rule legitimately skips it.
- `tsc` gap: tests/unit/credentials.test.ts's `globalThis as` cast needed
  `as unknown as` — tsc had not been re-run after the test-file addition
  in the previous task; run tsc AFTER test edits, not before.

## Phase 7 Task 3 (H04 + H05 — host warning and injection mitigations)

- Warn-but-save ordering: `LlmBaseUrl.safeParse` gates first, then
  `isNonPublicUrl(parsed)` — the fail-closed predicate never sees
  unparseable input, and an invalid URL fails Enable instead of
  warning (test pins all three states).
- `isNonPublicUrl` reuse is verbatim per spec: loopback hosts DO warn.
  That is disclosure of the same predicate that gates egress, not noise.
- `stripUrlsAndMarkdown` (src/llm/sanitize.ts): md-links keep the visible
  label, bare `scheme://` + `//` and `www.` URLs drop, line-leading
  structural markdown + emphasis + leftover `[]()/ `brackets drop, C0/C1
  control chars drop (needs a scoped `no-control-regex` disable — the
  range is the point), whitespace collapses incl. trailing space before
  newline. Idempotent; `\t`/`\n` deliberately survive for summaries.
- `sanitizeProposal` re-parses instead of truncating: strip only removes
  chars and drops emptied segments, so it cannot create
  length/depth/dupes that evade `RestructureProposal` — over-limit or
  duplicated output still rejects honestly. Reviewer confirmed: the
  transform is monotone, so re-parse is fail-honestly, not laundering.
- Wire schema first means grossly malformed paths (stray `//`) reject
  upstream of sanitize — sanitize only handles legal-but-dirty names;
  test with `*emphasis*`/`[label](x)`, not `https://` in a segment.
- Folder-name segments get an extra `[\t\n]+ → " "` flatten before
  re-parse (review Info): legal on the wire but a rendering artifact in
  a folder name.
- Empty-after-strip is a coded error, not Zod min(1): throw `Error` +
  `Object.assign(error, {code:"empty_summary"})` at the summarize output
  — `codeOf` propagates `cause.code`, so the pipeline reports
  `stage:"summarize", code:"empty_summary"` instead of an opaque
  persist-time schema failure. Double-strip at decisions/summaries.ts
  keeps the persist boundary producer-agnostic.
- Review feed shape: `listReviewable` + `listAutoApplied(50)` merge in
  App; ReviewView narrows `reviewQueue` to pending|unsure so the badge
  stays actionable, and `hiddenUnsaved` must count only
  `isUnsavedDecision` rows (the old `decisions.length - queue.length`
  would have counted history rows as hidden popup placeholders).
- Standalone `render(<ReviewView/>)` mounts no toast host — assert the
  store transition + sent intent, not `undo-toast`, outside App renders.
