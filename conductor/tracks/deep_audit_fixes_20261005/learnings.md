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
