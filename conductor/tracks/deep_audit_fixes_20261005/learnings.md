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
