# Track Learnings: audit_hardening_20261001

Implementation discoveries belong here and in the mapped Beads task's notes.
This file starts with approved context and inherited patterns; it does not
claim that any audit bug has been fixed.

## Approved Decisions

- All named audit findings are in scope; unrelated historical backlog is not.
- High/P1 track priority. No active-track dependencies. Hours are unset.
- Six sequential phases, limited file-owned task parallelism.
- **No manual checks at any phase or at completion.** The user explicitly
  approved automated-only verification on 2026-10-01. General workflow
  instructions remain unchanged outside this track.
- Reuse `BookmarksManager-f7c`, `BookmarksManager-w6y`, and
  `BookmarksManager-2qk`; preserve their original issue history.
- Initial performance/retention bounds: 50 ms refresh window, 300 synthetic
  popup decisions, 500 near-duplicate pairs, 50,000 candidate comparisons.
- Planning only at creation. No application implementation, provider calls,
  browser install, deployment, or remote synchronization occurs here.

## Codebase Patterns (Inherited)

Selected applicable patterns from `conductor/patterns.md`:

1. **Metadata extensions must survive repository rewrites.** Include summary
   in replacement `putMeta` paths, format adapters, and metadata-emptiness
   tests. Schema validity alone does not establish round-trip preservation.
2. **Fail-closed per-call gates.** Resolve current exact origins, validate
   request/model/scopes, re-check consent/permission, then access secrets or
   send. Broad host capabilities are not authorization.
3. **Unknown cost is not zero.** Distinguish reported/estimated/unknown and
   reserve before spending; settlement is atomic/idempotent and uses a
   numeric pricing snapshot.
4. **Snapshot replay is idempotent and resumable.** Preserve ID maps after
   partial restores; skip still-live originals; pop only on success.
5. **A targeted snapshot must be disposed by ID.** Never let compensation
   drop another flow's latest snapshot. Put targeted head-check/replay
   together under cross-context coordination.
6. **Origin identity and pending state matter in live reads.** Tag a result
   with its requested identity; mismatches mean pending, not a reusable grant.
7. **Resumption follows durable input and user intent.** Preserve batch
   boundaries, proposal/assignment state, and explicit paused/canceled state.
8. **Native roots are guarded subjects, ordinary valid destinations.**
   Never mutate root subjects or managed nodes; Other/Mobile bookmarks still
   belong to a full-tree reviewed scope.
9. **Total message handlers.** Use typed, redacted `{ok:true} | {ok:false}`
   unions. Credentials do not belong in UI imports or protocol payloads.
10. **Jitless Zod import boundary.** Every schema imports from
    `src/schemas/z.ts`, never directly from `zod`.
11. **Browser tests fake the wire, not the feature client.** Fresh persistent
    profiles, `channel: "chromium"`, synthetic public-looking hosts, held
    requests, and guarded IndexedDB probes exercise real gates/persistence.
12. **Native permission prompts are not covered by the manifest-copy
    workaround.** State the limitation; never label it automated coverage.
13. **Tests must await async outcomes.** A no-change assertion can pass too
    early. Use controlled deferred promises, explicit completion, and
    teardown that drains held requests.
14. **Performance assertions require correctness controls.** Stop the clock
    before assertions; disclose mocked/bypassed work; gate worst-run behavior
    and deterministic work bounds, not a fast failure.
15. **Coordinate parallel ownership.** Serialize shared files, track state,
    Beads writes, local commits, and notes. No automatic Git/Dolt remote sync.

## Audit Evidence to Preserve

- Original summary-loss probes covered recreated and surviving metadata
  rewrites, and summary-only JSON import rows.
- A stale startup tree plus concurrently written metadata reproduced
  orphan cleanup deleting a live bookmark's sidecar.
- Output-limit probe: reserved 50 output tokens, fake response reported
  1,000; cap $0.00005, committed $0.0006015. The wire had no output bound.
- Missing-usage probe: a successful priced response committed zero cost,
  recorded zero unknown-cost requests, and left no active reservation.
- Hidden-mounted Options tests refreshed correctly only after remount;
  new regressions must keep the same shell alive.
- Decision Undo requires the real Review path under the Radix More menu;
  use existing `tests/components/menu-helpers.ts` rather than assuming a
  direct Review button.
- 100 bookmark creations caused 101 full-tree reads at the audit baseline.
- Destructive compensation, blocklist leaks, scan overlap, cross-context
  undo, full-scope mismatch, and summary identity were reproduced with
  in-memory native/IndexedDB state and fake provider requests.
- Audit scratch tests were removed; their assertions must become permanent
  regressions in the existing unit/component/e2e harnesses.

## Validation Baseline and Known Limits

- Historical audit: 151 unit/component files, 2,535 passing tests;
  lint/typecheck/build and manifest/bundle/store/site checks passed.
- Non-blocking React `act(...)` warnings were observed.
- Browser tests did not execute application assertions because the
  Playwright Chromium executable was absent. Record launch failures
  separately; install the matching browser during implementation validation.
- README's `BookmarksManager-gyx` issue claim is stale; inspect the closed
  issue before correcting it. Do not reopen the resolved assertion drift
  merely because the browser environment is missing.
- Existing Beads warnings: directory permissions 0755 instead of recommended
  0700 and unset `beads.role`. They were not modified during the audit.
- Preserve user-owned `.beads/.auto-import-issues.jsonl`.

## Implementation Learnings

### Session setup

- User explicitly selected implementation directly on `main`.
- Loaded 93 project patterns. The approved track already supplies the design
  and plan; no new design or manual verification gate was added.
- Baseline `npm run test -- --run`: 151 files, 2,532 passing and 3 timing
  failures (two sidepanel actions and search index construction). Both files
  passed in isolation with `--maxWorkers=1` (20 tests). Subsequent full
  one-worker verification passed; no assertions or time budgets were weakened.
- `npx playwright install chromium` succeeded. Fresh-profile, wire-fake
  browser tests now execute application assertions. The manifest-copy
  workaround still does not test native optional permission prompts.

### Phase 1 Task 3: JSON summary round trips

- Added `summary` to `ImportMeta`, the JSON adapter, writer admission, and
  `putMeta` payload. Other formats still omit fields they cannot express.
- Red: `npx vitest run tests/unit/io-import.test.ts`, 2 expected failures,
  34 passing. Summary-only metadata disappeared; full metadata lost summary.
- Green: the same command, 36 passing. Real export → serialize → parse →
  plan → write preserves summary-only/full rows under fresh native IDs.
  Invalid summaries and skipped duplicates remain rejected/skipped.
- Applicable gate: lint, typecheck, 151 files / 2,563 tests
  (`npm run test -- --run --maxWorkers=1`), build, manifest, bundle and store
  checks passed. Isolated core-manager/LLM browser run: 16 passed, no skips.
- Pattern: fields in the export schema must also cross the normalized
  import adapter, metadata-presence predicate, and replacement writer.
- Local commit: `e6a71cd`; task `BookmarksManager-lgd.1.3` closed.

### Phase 1 Task 4: Race-safe startup reconcile

- Take the raw metadata key snapshot before reading Chrome and only remove
  initial candidates also absent from a fresh successful confirming read.
  Empty or failed confirming reads authorize no cleanup.
- Red: `npx vitest run tests/unit/sync-reconcile.test.ts`, 5 expected
  failures, 8 passing. Green: 13 passing, including both creation windows,
  stale initial state, failed/empty confirmation, dead invalid rows and
  invalid-but-live preservation. No network call is made.
- Applicable gate: lint, typecheck, full 151 files / 2,563 tests
  (`--maxWorkers=1`), build, manifest/bundle/store checks, and isolated
  core-manager/LLM E2E (16 passing, no skips).
- Pattern: Chrome does not reuse native IDs. A pre-read candidate set keeps
  newly created sidecars out of orphan cleanup; confirmation protects
  candidates incorrectly absent from a stale snapshot.

## Planning Validation

- Created Beads epic `BookmarksManager-lgd`, six phase containers, and
  mappings for all 30 tasks. Three canonical issues were reused; 34 new
  issues were created. All implementation tasks remain open and unclaimed.
- Verified coverage for B01–B15 and I01–I08, metadata counts, balanced
  Markdown code fences, and the automated-only verification override.
- Verified all 49 blocker edges against plan semantics and explicit phase
  entry gates; no dependency cycles were found.
- Verified every overlapping parallel file set is dependency-ordered.
  Initial ready implementation tasks are Phase 1 Tasks 1, 3, and 4.
- Verified the passive Beads export contains exactly the expected new
  issues and three reused-issue changes. Original descriptions, designs,
  acceptance criteria, priorities, status, and existing notes were preserved.
- `git diff --check` passed. Application tests/builds and Chromium E2E were
  not rerun for this documentation/issue-planning change. Historical audit
  results above are not fresh implementation verification.
