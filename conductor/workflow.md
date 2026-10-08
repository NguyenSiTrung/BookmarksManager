<!-- Last refreshed: 2026-10-07 (refresh — no workflow drift; local gate list unchanged, check:store:public bar narrowed) -->

# Development Workflow

## Before a Task

1. Read `conductor/product.md`, `tech-stack.md`, `patterns.md`, this workflow, and the active track's `spec.md`, `plan.md`, and `learnings.md`.
2. Inspect the relevant code and issue state before editing. Claim the mapped Beads task when integration is enabled.
3. Keep the task small enough to implement and verify independently. Do not overwrite existing uncommitted or untracked work.

## Implement with Tests

1. Write a failing test for each behavior or bug fix, then make it pass and refactor. For project scaffolding or documentation, verify the corresponding artifacts and configuration instead.
2. Validate schemas at trust boundaries. Include invalid fixtures, privacy and consent cases, and error paths where relevant.
3. Run the narrowest relevant tests while developing. Before task completion, run the applicable slice of the CI gate — `lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle` → `check:store` (→ `xvfb-run -a test:e2e` when touching entrypoints or egress behavior; `check:site` when touching `site/`; `test:eval`/`test:live` are key-gated and never part of the local gate). Prioritize tests that cover meaningful behavior and error paths; do not write tests only for a number.
4. Keep code, permissions, disclosures, consent versions, and store documentation synchronized whenever data flow changes.

### Choosing how much to run

The full local gate costs ~100 s and the e2e suite ~110 s, so running everything
after every edit wastes most of the loop. Pick the cheapest rung that can
actually fail, and escalate only when the change is done:

| Rung | Command | Cost | Use when |
| --- | --- | --- | --- |
| 1 | `npx vitest run <file>...` | ~1.5 s | Mid-edit. Name the 1–3 files whose subject you touched. |
| 2 | `npx vitest run --project unit` | ~20 s | `src/` shared module changed (schemas, db, net, llm, decisions). |
| 3 | `npx vitest run --project components` | ~48 s | `src/entrypoints/**` changed. |
| 4 | full gate (§3 list) | ~100 s | Task complete, before commit. |
| 5 | `xvfb-run -a npm run test:e2e` | ~95 s | Entrypoints or egress behavior changed. |

`npx vitest related <file>` is **not** a shortcut here: the import graph is
dense enough that one shared module pulls 45–70 files (50 s), which is worse
than just running a whole project. Prefer explicit file names.

Do not lower a rung to make a red test go away. If a test fails only in the
full run, it is either a real ordering bug or a load artifact — reproduce it in
isolation before deciding which. `docs/test-suite-analysis.md` records the
measurements behind this table.

The CI workflow (`.github/workflows/ci.yml`) runs on every pull request and on
published releases, but not on routine pushes to `main`, with workflow-level
read-only `contents` permission and no secrets. A `quality` job runs lint →
typecheck → unit tests → build → `check:manifest` → `check:bundle` →
`check:site` and the Playwright suite under
`xvfb-run -a`. A separate `release-checks` job (`needs: quality`) owns the
release-strict `check:store` packaging gate and runs only for a published
release or manual dispatch, so routine pull requests never run store
packaging. Run the applicable local gate before each task commit rather than
relying on automatic CI feedback. The separate Pages workflow validates and
deploys site changes on `main` (or manual dispatch); it does not run the
extension gate.

## Task Completion and Commits

1. Update the plan marker and append useful patterns or gotchas to the track's `learnings.md`. Promote reusable patterns to `conductor/patterns.md` at phase or track completion.
2. Review `git diff` and staged status. Commit only the completed task's intended files **locally after its tests pass**.
3. Add a `git notes add -m "..."` task summary to the commit. Record the commit reference in the plan and close the corresponding Beads task only after completion.
4. Never automatically run `git push`, `git pull`, `git fetch`, or `bd dolt push`. The user decides when to synchronize code and Beads data.

## Phase Verification

At each `Conductor - User Manual Verification` task, summarize the completed phase, tests and build evidence, known limitations, and any manual steps needed. Ask the user to verify the behavior before marking that verification task complete or moving to the next phase. Record feedback and revise the plan if needed.

## Handoff

Leave the active plan, track learnings, and Beads issue notes in a state another session can resume. Report what changed, what was validated, what remains, and the local commit if one was created.

## Writing Tests That Survive a Parallel Run

This suite runs ~17 worker processes on one machine, so a test that measures or
waits on wall-clock time is really measuring scheduler contention. Three rules
keep such tests honest and non-flaky:

1. **Never assert a single wall-clock sample.** Take the best of several
   repetitions: the minimum is the standard estimator for a "how fast can this
   go" budget, because it discards descheduling noise instead of averaging it
   in. A genuine regression still moves it. Measured here, identical work
   produced 170 ms in isolation and 628 ms under load, while best-of-N held at
   264–363 ms across eight full parallel runs. See `tests/unit/search-perf.test.ts`.
2. **Prefer a ratio or an injected clock over an absolute duration.** When a
   test's subject is a *ratio* (a read that outlives several poll ticks), inject
   the cadence and scale the latency with it. `RestructureView` takes a
   `pollMs` seam for exactly this; the re-entrancy test runs at 1/20 speed and
   costs 0.9 s instead of 8.6 s. `App` has the same kind of seam
   (`undoToastAutoHideMs`). Verify by mutation that the sped-up test still
   fails when the behavior it guards is removed.
3. **Do not tighten a timeout to make a test fail fast.** A 5 s vitest default
   and a 1 s Testing Library `waitFor` default were both below the real cost of
   legitimate integration-shaped tests under load; both are raised globally
   (`vitest.config.ts`, `tests/setup-components.ts`). Raising a *wait* budget
   never weakens an assertion — `waitFor` resolves the moment its callback
   passes — it only lets a slow-but-correct component finish.

A red full run whose failures all pass in isolation is a load artifact and must
be fixed, not tolerated: once a suite is routinely read past, it stops
protecting anything. Fix the measurement, or fix the test's cost — never the
assertion's meaning.
