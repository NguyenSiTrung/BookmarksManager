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

### Phase 3 Task 1: Reserved output allowances on the wire

- Strict positive safe-integer declarations and wire limits, with effective
  output `min(caller, declared)`, feed both reservation and serialized
  `max_tokens`. Unknown alternate limit keys fail, never strip silently.
  The actual outbound field list includes the cap, without recording values.
- Caps survive HTTP/transport retries and all structured tiers/repairs.
  Reported overrun example: 1,000 actual output tokens against a 50-token
  allowance still charges $0.00201 at the fixture pricing; reported $0.02
  takes precedence. A provider ignoring the cap is not free spending.
- User explicitly approved bounded, validated internal LLM error
  classification instead of the inherited no-non-2xx-read pattern.
  Actual reading is capped at 4,096 bytes with strict UTF-8/EOF/envelope
  validation and cancellation; body processing cannot leak native causes.
  Token-limit fields/mentions veto structured fallback.
- Red: 30 failures / 125 tests before gate/wire changes; four client
  classification cases remained until approved ownership expansion.
  Final targeted: 187 passed; feature consumers: 232 passed.
  Task-scoped review: Spec PASS, Quality PASS.
- Fresh full gate: lint/typecheck and 152 files / 2,814 tests passed
  (`--maxWorkers=1`), then build/manifest/bundle/store passed.
  Initial browser run: 4 passed, 1 failed, 5 not run, because the fake
  wrapped non-2xx replies as completion bodies.
- Updated the existing wire fake with an explicit typed error envelope
  (success replies unchanged) and asserted all three browser fallback
  requests carry the actual 1,500-token proposal allowance. Targeted
  browser regression passed; fresh full LLM browser rerun: 10 passed,
  no skips. Lint/types/build/compliance reran successfully after fixture fix.
- Pattern: generic HTTP status cannot distinguish output-cap rejection
  from unsupported structured output. Validate a bounded envelope and
  conservatively refuse ambiguous/token-limit errors, never remove the cap.
- B09 missing/partial usage and B10 revoke settlement remain pending.
- Local commit: `a43400f`; task `BookmarksManager-lgd.3.1` closed.

### Phase 3 Task 2: Conservative missing usage and per-attempt accounting

- Omitted counts remain absent; each missing dimension uses its admitted
  reservation bound and pricing snapshot. Explicit zero is preserved.
  Independently validate consumed usage fields so a malformed sibling or
  unused total cannot erase a valid count, overrun or reported cost.
- Finite nonnegative reported cost takes precedence, including zero.
  Missing prices/cost stay unknown, never an invented monetary zero.
  Malformed/read-failed bodies settle conservative exposure.
- Removed age-based release of active reservations. Age is not proof that
  an attempted send was free. Pending unpriced rows surface as unknown;
  active snapshots remain available for late concurrent/idempotent settlement.
- Review found successful retries still erased earlier exposure. Revision 7
  uses existing reservation/usage tables per attempt: settle before a retry,
  then repeat current model/origin/consent/permission/feature/budget admission.
  The client receives and settles the final attempt separately.
- Two missing-usage attempts commit $0.00009, not $0.000045. A final reported
  zero leaves the earlier $0.000045 estimate intact. Earlier reported $0.02
  survives a final zero. Under a $0.00005 cap, the first $0.000045 estimate
  blocks a second $0.000045 paid attempt.
- Initial red: 49 failures / 177 tests; sibling-field red: 12 / 189;
  retry red: 14 / 203. Final named green: 203 tests. Covering consumers:
  14 files / 497 passed. Consumer row expectations now reflect attempts,
  retaining exact costs/request counts/caps/zero-egress checks.
- Scoped retry re-review: P1 addressed, Spec PASS, Quality PASS.
  Fresh coordinator gate: lint/types, 152 files / 2,889 tests
  (`--maxWorkers=1`), build/manifest/bundle/store and 10 isolated LLM E2E
  passed, no skips. Existing non-fatal React act warnings remain.
- No new tables, migrations, dependencies, permissions, logs or native
  causes. Native permission prompts and key-gated live/eval remain excluded.
  Crash-orphaned active exposure is intentionally retained rather than freed;
  no exactly-once external billing guarantee is claimed.
- B10 ordinary revoke still needs to preserve these active snapshots.
- Local commit: `305f43c`; task `BookmarksManager-lgd.3.2` closed.

### Phase 3 Task 3: Reservation lifetime through revoke

- Ordinary revoke removes consent first, then permission/settings/pointer/key,
  but never usage or reservation snapshots. No existing separate terminal
  retention policy exists, so no new pruning policy was invented.
  Explicit delete-all still intentionally drops all extension-owned data.
- Held success/error/malformed/abort responses settle from admitted bounds,
  model and pricing once after settings/key removal. Re-enable cannot erase
  prior reserved exposure; new egress refuses even during held cleanup.
- Review caught a late synthetic Test connection overwriting deleted or
  re-enabled settings, including restoring an old unlimited cap. Fresh
  validated-record equality and tier save now share one metadata transaction.
  Absent/changed records are not recreated or overwritten.
- Initial red: 11 failures / 213 tests; stale-probe red: four / 218;
  removing only atomicity reproduced two boundary failures (51 unrelated
  tests excluded in that focused mutation run). Restored immediately.
  Final named: 220 passed; adjacent: 17 files / 594 passed.
- Core scoped re-review: P1 addressed, Spec/Quality PASS.
  Revision 8 adds required Phase 3 browser accounting controls to the
  existing LLM spec/helper rather than count future Phase 6 evidence.
- Browser omitted usage: 64/16 bounds at $2/$4 per million commit
  $0.000192 estimated, matching wire cap 16. Held revoked response reports
  10/5 and commits $0.00004 from the original pricing; settings/key/consents
  remain absent, new intents send nothing, duplicate settlement is inert.
- Both browser regressions failed on successful historical builds/launches:
  pre-B09 `a43400f` charged zero; pre-B10 `305f43c` lost late usage.
  Agent-owned git-archive snapshots were used, never resetting main.
- Browser duplicate checks execute bundled existing production settlement
  in a separate extension context using installed Vite in memory; no shipped
  debug protocol, dependency, fixture DB rewrite or build artifact.
  Test-only resolver failures were corrected, not labeled product red.
- Browser controls review: Spec/Quality PASS. Fresh complete gate:
  lint/types, 152 files / 2,908 tests (`--maxWorkers=1`), build,
  manifest/bundle/store and 14 isolated LLM/provider E2E passed, no skips.
  Existing React act warnings remain non-fatal. Native permission prompts
  and key-gated live/eval remain excluded; temporary install-time grants
  may cause permission-removal partial failures without authorizing egress.
- Local commit: `f4dc035`; task `BookmarksManager-lgd.3.3` closed.

### Phase 3 Automated Checkpoint

- B08/B09/B10 complete: `a43400f`, `305f43c`, `f4dc035`.
  Six phase files / 315 tests passed together. The unchanged native,
  message/schema and feature boundaries also passed the full suite.
- Latest fresh full command:
  `npm run lint && npm run typecheck && npm run test -- --run --maxWorkers=1 && npm run build && npm run check:manifest && npm run check:bundle && npm run check:store`,
  152 files / 2,908 tests and all gates passed.
  Browser command:
  `xvfb-run -a npm run test:e2e -- tests/e2e/llm.spec.ts tests/e2e/provider.spec.ts`,
  14 passed, including omitted usage and a held revoked response.
- Wire limits match effective reserved allowances on retries/tiers/repairs.
  Invalid/unsupported limits fail visibly. Provider-reported overruns are
  charged honestly, not claimed impossible by client-side caps.
- Missing/partial dimensions, valid reported zero/cost, unknown manual
  exposure, automatic unpriced refusal, TTL retention, successful retry
  exposure, UTC month transitions and duplicate settlement are permanent
  regressions. Revoke blocks new sends while retaining late accounting.
- No skips in final gates; non-fatal React act warnings remain.
  Native permission prompts, live/eval provider calls and exactly-once
  billing after browser failure are not claimed. No manual gate or remote
  synchronization. Continue automatically to Phase 4.

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

## Phase 4 Task 1 — Single-owner scan runners (B11)

- `coordinateJob` keys the drive promise by job ID until every admitted batch
  settles, so duplicate starts, resumes and startup scans coalesce into one
  owner. Claims are transactional; progress/status/assignment writes carry the
  captured `ownerGeneration` and no-op on mismatch or terminal state.
- Ownership must travel with the callback, not stop at the runner entry:
  analysis, duplicate-pair, second-opinion and restructure assignment paths
  all forward `beforeSend` so the real gate rechecks admission after its own
  preflight and after queued/retry waits. Refusals are rethrown outside
  transport classification, so they never retry and never wrap content.
- Split wire batches drain with `Promise.allSettled` before the owner
  releases; spent sibling usage is retained once via `onPartialUsage`.
  Same-owner pause drains the in-flight batch and stays resumable; cancel,
  owner replacement and terminal states start no new paid request.
- Pass `beforeSend` to injected transports only when an authority exists.
  Always forwarding the key changes the transport call shape and broke
  `jev-connection` callers that capture no job (found by the full gate).
- Permanent regressions: promise identity/release, two-resume coalescing,
  per-bookmark liveness, pair cancel/replace/pause, canceled low-confidence
  escalation, real preflight and shared-slot cancel, retry-wait cancel,
  split-drain partial usage, stale restructure callback, restart offsets.
- Documented boundary: a request that left the device and returned non-2xx
  still contributes no usage row (unknowable whether it was billed), matching
  the earlier malformed/read-failed ruling; at-least-once uncommitted-batch
  crash replay is likewise not exactly-once billing.
- The browser fixture's forbidden word `notes` matched static category
  instruction text ("release notes"), not leaked notes. Structural
  `state.notes`/`bookmark.notes` checks and the query-marker checks remain
  the real assertions; only the ambiguous plain word was dropped.

## Phase 4 Tasks 3-5 (in progress notes)

- B15 (`b62f078`): preview/status read the root subtree; apply now revalidates
  with the full `getTree()` and filters to the reviewed accepted ids. Read
  rejections and empty reads refuse typed (`read_failed`) before any write;
  B01 compensation unchanged. An accepted managed row outside the bar now
  aborts the batch with compensation instead of being dropped as stale —
  uniform with the pre-existing bar-managed case. Follow-up bead
  `BookmarksManager-2v9` covers flagging managed rows in the preview.
- B13: one origin-scoped exclusive Web Lock (`bookmarks-manager:undo`) in
  `src/undo/lock.ts`; a per-instance `holdDepth` lets nested same-context
  calls join the hold instead of re-acquiring the non-reentrant platform
  lock. `restore.ts` keeps its module-local promise tail strictly for
  same-context ordering — never as a missing-lock fallback: a runtime with
  no/rejected/aborted lock refuses typed (`conflict`, mapped to decision
  `undo_conflict`) with zero mutations. `undoExpected(snapshotId)` checks
  the head and replays/pops the row it READ inside one hold; decision
  `compensate`/`revertDecision` use it instead of peek-then-undo. The
  shared queueing LockManager fake is installed via `setupFiles` in both
  Vitest projects; missing-lock tests explicitly remove it. Review
  `00fd4eda` PASS (P3: the `holdDepth` fast path can run direct
  `withUndoLock` siblings inline — contained, no production direct caller;
  pre-existing notes: `applyMerge` records a peeked id outside the lock but
  revert re-verifies head, and the snapshot cap evicts oldest rows, never
  the head). Core-manager E2E 6 passed.
- B12: a synchronous `decisionUndoBusyRef` is acquired before the
  decision-vs-generic branch (React state lags the click and the command
  palette bypasses the disabled control); the armed decision id survives to
  settlement and is re-armed only on refusals that left the row applied.
  A toast generation token retires the armed target on every slot
  transition (new toast, dismissal, auto-hide), so a late completion can
  neither resurrect nor overwrite a newer toast. `state_unrecorded` reports
  the typed message with no Undo affordance and no re-arm because the
  replay already ran — the row stays `applied` until worker-side recovery,
  which is accepted (a retry could only be refused as `undo_conflict`).
  `undoToastAutoHideMs` is a test-only prop mirroring the `askDebounceMs`
  precedent; production always uses the 8 s constant. Review `8a58e3b7`
  PASS plus delta re-check PASS; decisions E2E 6 passed.
- B14: Options provider/escalation state derives from a live-read hook keyed
  by the revision rows (`JEV_PROVIDER_IDS`, `llmProvider:*`,
  `llmActiveProvider`, `llmEscalation`) plus the `jev_test`/`llm_test`
  consent grants; every read is tagged with the revision it requested, so a
  superseded value can never render while a newer read is in flight, stale
  reads are dropped, and settled failures surface with retry. A vanished
  custom origin falls back to the default so consent is never requested at
  a stale origin; the grant/revoke control is withheld (plain-text reason,
  retry above) until the origin resolves. The escalation toggle renders the
  worker-persisted row rather than the write reply's local snapshot. The
  hook imports no key/credential module directly; the transitive reach
  through message-schema modules is pre-existing and reads nothing. Review
  `351dee7b` PASS with four P3 coverage gaps; the fix round added pinning
  tests for the revision-tag window, consent-only keying, explicit
  selection survival, and the unresolved-origin control (all
  mutation-verified) plus the copy/doc corrections — delta re-check PASS,
  provider/LLM E2E 14 passed.

## Phase 5 (in progress notes)

- I02 `useBookmarkTree`: the initial read stays immediate; all five native
  event types coalesce through a 50 ms window with one in-flight read and
  exactly one dirty trailing read; generation/cancellation guards kept;
  unmount clears the timer and every listener; a failed read keeps the
  previous model and waits for a new event (no spin). Review `48a85321`
  PASS (P3: the test helper drains a fixed three-microtask chain — it fails
  loudly rather than false-passing if the read chain deepens; accepted).
  Isolated core-manager/search E2E batched into the Phase 5 gate at the
  user's request to stop running heavy gates per task.
- I03 `src/search/live-cache.ts` (pure — no Chrome/React) owns the MiniSearch
  index and its documents: unchanged documents are reused by comparing a
  signature over every `toSearchDocument` input (title, url, dateAdded, raw
  tag keys, resolved tag display names, category, notes, parent id, memoized
  ancestor path key); a folder rename/move invalidates exactly its
  descendants; duplicate grouping reruns only when an order-insensitive
  `id→url` corpus map changes; tree order is recomputed every update; the
  unmount cleanup calls `clear()`. `useSearchIndex(tree, metas, tagDefs)`
  keeps its signature and stable MiniSearch identity and only routes
  invalidated documents through `applyDocDiff`. Review `95523801` PASS; the
  P2 (unmount-clear wiring) and P3 (tagDefs-only dependency) gaps plus a
  vacuous egress assertion were fixed and mutation-killed, and the delta
  re-check confirmed zero source drift against the reviewed blobs. One
  scoped `react-hooks/set-state-in-effect` suppression is accepted: the
  effect syncs the external index and realizes the documented `null` →
  "Indexing…" contract. Isolated search E2E is batched into the Phase 5
  gate.
- I05 popup retention (`BookmarksManager-f7c`): `POPUP_DECISION_LIMIT = 300`
  plus `prunePopupDecisions()` — one `rw` transaction that prunes only rows
  whose `bookmarkIds` are all `popup:`-prefixed and whose status is
  `pending`/`unsure`, oldest-first by `createdAt` with an ascending-id
  tie-break, keeps the newest 300, and returns the deleted count. The
  post-save sweep runs after synthetic rows commit and is fail-soft; startup
  runs a fire-and-forget sweep with an attached `.catch`. Review `fce2a990`
  PASS; the fix round pinned the id tie-break (frozen scan order, since the
  id is the primary key), atomicity (a real `bulkDelete` then throw rolls
  back; a `currentTransaction.mode === "readwrite"` probe inside the sweep),
  and the startup catch (`defineBackground().main()` plus an
  `unhandledRejection` probe with a control rejection) — all three
  mutations killed. Delta re-check PASS, drift-free. Isolated decisions E2E
  is batched into the Phase 5 gate.
- I06 estimates and durable plans (`BookmarksManager-2qk`):
  `estimateJobCost` takes `kind` + ID-bearing bookmarks and reports
  `requests` (bookmarks + planned pairs), `pairs`, `comparisons`,
  `truncated`, `pairLimit`; the token fold stays a documented lower bound.
  `enqueueJob` accepts a bounded plan, reduces it to content-free pair IDs +
  planner limits/version/truncation on the optional `Job.nearDuplicatePlan`,
  and seeds pair-inclusive `progress.totalBatches`. The runner executes the
  STORED plan on resume (pair sides re-hydrated from the live work set, so
  edited titles cannot shift offsets), acquires exactly one plan for a
  legacy uncommitted `library_scan` via an atomic `attachNearDuplicatePlan`,
  and fails typed BEFORE any status/work write for a committed plan-less
  scan or a plan referencing an unknown bookmark. `background.startJob`
  resolves the plan best-effort at enqueue (a tree-read failure falls back
  to a plan-less legacy row); `ScanPanel` shows the pair-inclusive request
  count and the 500-pair truncation notice before start. Review `26c9983a`
  PASS with P2/P3 test gaps; two fix rounds closed them (stored-vs-recomputed
  discrimination, no-write ordering, truncated persist/resume, background
  fallback, and a 5 s timeout fixture reworked to 832 ms at batchSize 50);
  delta re-check PASS with sources byte-identical. Migration edge: a
  pre-Task-5 `library_scan` that already committed a batch without a plan
  fails typed on resume (ambiguous offsets). Isolated decisions E2E is
  batched into the Phase 5 gate.
- I06 candidates: near-duplicate planning is now bounded and deterministic.
  `NEAR_DUPLICATE_PAIR_LIMIT = 500`, `NEAR_DUPLICATE_COMPARISON_LIMIT =
  50_000`; exclusion is O(1) raw-or-normalized URL equality (no intra-group
  pair enumeration); above the comparison budget the planner generates
  candidates from an inverted title token index in sorted domain/token/ID
  order, caps attempts (including filtered/duplicate attempts) before
  scoring, sorts the selected pairs by similarity then canonical ids, and
  sets `truncated` true — a bounded shortlist, never a claimed global
  top-K. `nearDuplicatePairs` stays a compatible wrapper whose doc now
  states parity only up to the 500-pair cap (truncation is surfaced only by
  `planNearDuplicates`; Task 5 persists it). Review `6b315db7` PASS with a
  300-fixture differential against HEAD showing zero differences; fix round
  corrected the wrapper doc and added `chrome://` raw-URL, mixed-similarity,
  and identical-title normalized fixtures (all mutation-killed); delta
  re-check PASS with no source drift. Perf: 10k/5×2000-domain library =
  50 000 comparisons, 500 pairs, ~176–228 ms (budget 500 ms); analyze-on-save
  gate median ~81 ms (budget 1500 ms).
