<!-- Last refreshed: 2026-10-06 (refresh — no workflow drift; local gate unchanged) -->

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
