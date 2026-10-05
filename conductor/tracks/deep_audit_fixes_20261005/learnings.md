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
