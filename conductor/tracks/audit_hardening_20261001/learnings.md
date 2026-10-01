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
- Loaded the project patterns (117 top-level bullet entries). The approved track already supplies the design
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
- Local commit: `e183cc2`; task `BookmarksManager-lgd.1.4` closed.

### Phase 1 Task 1: Non-destructive restructure recovery

- Initial implementation passed 66 targeted tests and the full
  2,563-test gate plus 16 isolated browser tests, but task-scoped review
  found a remaining P1 failure: converting every native ID lookup
  rejection into absence can duplicate a still-live bookmark during the
  new restructure recreation path.
- Fixed original/mapped/parent/cleanup lookup handling for restructure.
  Confirmed missing IDs may recreate; transient failures return typed
  `api`, leave native state unchanged, and retain the snapshot/remap.
- Initial red: 13 expected failures, 53 passing. Review red: 4 additional
  failures, 66 passing. Final targeted green: 70 tests in restructure/undo,
  adjacent green: 157 tests across five files.
- Guarded non-recursive empty-folder removal protects original bookmarks
  after failed inverse moves, failed child reads, and racing insertion.
  Missing captured nodes recreate with durable ID remaps; surviving
  originals retain their later metadata edits, including summaries.
- Scoped re-review: Spec PASS, Quality PASS; original finding addressed.
- Fresh coordinator gate: lint/typecheck, 151 files / 2,567 tests
  (`--maxWorkers=1`), build, manifest/bundle/store and isolated
  core-manager/LLM E2E (16 passing, no skips).
- Limitations: native creation and durable remap persistence are separate
  calls, not crash-atomic. Cross-context locking is Phase 4 work. B02 shared
  delete/merge summary paths remain for the next task.
- Local commit: `6c20ef0`; task `BookmarksManager-lgd.1.1` closed.

### Phase 1 Task 2: Undo summary preservation

- Both remapped and surviving-node `restoreMetaRows` replacement payloads
  now include `summary: meta.summary ?? null`.
- Red: `npx vitest run tests/unit/undo.test.ts`, 4 expected failures,
  56 passing. Green: 60 passing. Summary-only/full delete and merge rows
  restore under new/original IDs, unrelated rows remain unchanged, and
  absent captured summaries still clear post-merge summaries.
- Phase tests together: four files / 124 passing. Fresh full gate:
  lint/typecheck, 151 files / 2,572 tests (`--maxWorkers=1`), build,
  manifest/bundle/store and isolated core-manager/LLM E2E (16 passing).
  Existing non-fatal React `act` warnings remain. No tests were skipped.
- Review: the two-line replacement-field extension uses the same metadata
  writer and emptiness behavior; regression expectations come from fixed
  fixtures and check native remapping as well as stored metadata.
- Local commit: `1158910`; task `BookmarksManager-lgd.1.2` closed.

### Phase 1 Automated Checkpoint

- B01–B04 have permanent red/green regressions and four local task commits:
  `6c20ef0`, `1158910`, `e6a71cd`, `e183cc2`.
- Latest combined phase command:
  `npx vitest run tests/unit/restructure-apply.test.ts tests/unit/undo.test.ts tests/unit/io-import.test.ts tests/unit/sync-reconcile.test.ts`,
  four files / 124 tests passed.
- Latest full applicable gate:
  `npm run lint && npm run typecheck && npm run test -- --run --maxWorkers=1 && npm run build && npm run check:manifest && npm run check:bundle && npm run check:store`,
  all passed, 151 files / 2,572 tests with no skips.
- Browser command:
  `xvfb-run -a npm run test:e2e -- tests/e2e/core-manager.spec.ts tests/e2e/llm.spec.ts`,
  16 passed with no skips. `git diff --check` passed.
- Synthetic failure coverage includes incomplete compensation, child-read
  and native-removal races, transient original/remapped lookup failures,
  partial-remap retry, full/summary-only round trips, and creation in both
  reconciliation windows.
- Live/evaluation provider suites and the native permission prompt were
  not run. No manual acceptance was requested. No remote synchronization.
- Coordinator continues to Phase 2 automatically under the approved override.

### Phase 2 Task 1: Current blocklists at every affected send

- Explanations refuse the entire derived decision when any live/captured
  reference is blocked or unreadable, instead of sending a reduced array.
  Summaries admit both the live bookmark and captured extraction URL.
- Admission wraps structured initial/fallback/repair calls and Jev
  queued/retry calls. Review found internal LLM retries bypassed the first
  wrappers; Revision 3 carries optional admission to each gate fetch attempt.
- Refusal stays outside transport retry classification. Unsent reservations
  release; already-sent attempts settle conservative input/output exposure
  from the durable pricing snapshot. One counted retry exposure example is
  $0.000045; two are $0.00009. Confirmed unpriced exposure stays unknown.
- Red: final original baseline had 19 expected failures / 51 tests.
  Internal retry follow-up red had 15 expected failures / 100 tests.
  Final covering gate: 10 files / 227 passing; no skips.
- Scoped re-review: original P1 addressed, Spec PASS and Quality PASS.
- Fresh full gate: lint/typecheck, 151 files / 2,620 tests
  (`--maxWorkers=1`), build, manifest/bundle/store and isolated
  `xvfb-run -a npm run test:e2e -- tests/e2e/llm.spec.ts` (10 passing).
- Pattern: client-level retries do not revisit feature wrappers. Put
  feature admission at each actual transport attempt, not only structured
  output fallback, and never erase previous paid exposure on refusal.
- B06 minimized summary URL/disclosures, B07 local identity, and B09/B10
  general usage/revoke lifecycle remain pending.
- Local commit: `0bb1b8b`; task `BookmarksManager-lgd.2.1` closed.

### Phase 2 Task 2: Minimized summaries and explicit renewed consent

- LLM summary bodies use a separate minimized URL copy; direct builder also
  cleans/refuses. Original extraction remains available only for local
  admission. All initial/fallback/repair/internal-retry bodies exclude the
  synthetic query/fragment secret markers while allowed summaries succeed.
- Actual LLM fields: cleaned URL, page title, excerpt, headings, optional
  site name and meta description. Jev fields: bookmark title/cleaned URL/
  domain, excerpt, headings and generated summary. Runtime/store/site
  disclosures now align. Shared consent version is 4; historical grants
  remain stored but cannot authorize sends.
- Review identified silent automatic grant refresh. Revision 4 adds
  read-only `LLM_SUMMARY_PREFLIGHT`, both recipients' production disclosure,
  and **Agree and summarize**. Approval binds version, origins, IDs, models
  and endpoints to freshly resolved settings. No extraction/egress/grant
  occurs on preflight or dismissal. Cost confirmation is separate and its
  bound resend cannot restore revoked grants.
- Red: initial B06 command had 28 failures / 123 tests; renewed production
  consent command had 31 failures / 86 tests. Additional self-review caught
  missing approval (1 failure) and revoked cost-resend grants (2 failures).
  Final targeted consumer gate: 12 files / 345 passing, no skips.
- Scoped consent re-review: original P1 addressed, Spec PASS. A new P2
  disclosure-layout finding was fixed inline with a permanent browser
  regression: at 360×480, the action had viewport ratio 0 before the fix;
  bounded flex layout, keyboard-focusable scrolling content and fixed action
  footer passed the same rebuilt browser test. Component/accessibility
  slice: 15 passing. No structural/source-text layout assertion was used.
- Fresh full gate: lint/typecheck, 151 files / 2,681 tests
  (`--maxWorkers=1`), build, manifest/bundle/store/site passed.
  `xvfb-run -a npm run test:e2e -- tests/e2e/llm.spec.ts tests/e2e/provider.spec.ts`:
  12 passed, no skips. Native permission prompts/live/eval remain excluded.
- The summary browser fixture uses real preflight/affirmative protocol for
  extraction because toolbar `activeTab` is not automated. It separately
  opens/dismisses the production narrow dialog and proves zero provider
  requests. B07 resource identity is still the next dependent task.
- Local commit: `c779b2e`; task `BookmarksManager-lgd.2.2` closed.

### Phase 2 Task 3: Local resource identity

- Added pure local-only `summaryResourceKey`/`sameSummaryResource`.
  Permit HTTP(S) sendable resources and remove only decoded allowlisted
  tracking keys (`utm`, `utm_*`, `gclid`, `fbclid`, `msclkid`).
- Preserve remaining raw query data, order, repeated keys, percent/plus
  spelling and all nonempty fragments, including ambiguous anchors. The
  conservative fragment choice follows the approved plan rather than guess
  which fragment is an application route.
- Summary admission now compares local resource keys before independently
  minimizing outbound URLs, including each later admission callback.
  Keys are never persisted, logged, or sent.
- Initial red: six pipeline mismatches incorrectly returned success.
  Final previous-admission replay: 7 expected failures / 91 tests, including
  a saved semantic-query change after the LLM response; implementation was
  restored immediately and the full green gate ran afterward.
- Pure controls: 27 tests. Summary pipeline: 64 tests. Combined phase:
  7 files / 237 passing. Full gate: 152 files / 2,716 passing
  (`--maxWorkers=1`), lint/typecheck/build/manifest/bundle/store/site passed.
  Isolated LLM/provider E2E: 12 passed, no skips.
- Mismatches produce zero initial LLM/Jev requests; the changed-reference
  post-LLM case produces one LLM and zero Jev requests with no persistence.
  Allowed tracking-only variations succeed and remain minimized on the wire.
- Inline review: existing current-blocklist/binding checks still precede
  sends; the small pure mapper preserves native URL syntax without relying
  on an egress-cleaned URL for identity.
- Local commit: `d8a69d4`; task `BookmarksManager-lgd.2.3` closed.

### Phase 2 Automated Checkpoint

- B05–B07 complete with local commits `0bb1b8b`, `c779b2e`, `d8a69d4`.
- Phase tests: seven files / 237 passed. Full latest applicable gate:
  `npm run lint && npm run typecheck && npm run test -- --run --maxWorkers=1 && npm run build && npm run check:manifest && npm run check:bundle && npm run check:store && npm run check:site`,
  152 files / 2,716 passed with no skips.
- Browser command:
  `xvfb-run -a npm run test:e2e -- tests/e2e/llm.spec.ts tests/e2e/provider.spec.ts`,
  12 passed. Secret-marker assertions cover initial/fallback/repair/HTTP and
  transport retries. Changed-list/native-reference refusals preserve prior
  exposure and prevent additional affected sends.
- Summary preflight/dismissal is zero-egress; stale grants do not auto-refresh.
  Exact-origin/model/endpoint bindings survive separate cost confirmation.
  Local semantic-query/hash-route mismatches never attach another resource's
  summary; allowlisted tracking differences still work with minimized bodies.
- No manual checks or remote synchronization; native prompts/live/eval
  excluded. Continue automatically to Phase 3 output limits/accounting.

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
