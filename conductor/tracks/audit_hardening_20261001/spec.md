# Audit Hardening

## Overview

Repair every bug and improvement named in the preceding codebase audit,
without rewriting the extension or taking on unrelated historical backlog.
Native Chrome bookmarks remain authoritative. Core features remain offline;
optional AI stays consent-gated and exact-origin scoped.

- **Type:** bug/hardening.
- **Priority:** High (P1).
- **Execution:** sequential phases, limited parallelism within file-disjoint
  tasks.
- **Track dependencies:** none, because all preceding tracks are archived.
- **Estimate:** unset.
- **User approval:** scope, priority, automated-only verification, execution
  strategy, and the six-phase plan approved on 2026-10-01.

**Verification override:** The user explicitly approved **no manual checks**,
including at track completion. This overrides the per-phase manual-verification
instruction in `conductor/workflow.md` for this track only. Automated task,
phase, and final gates remain mandatory; successful automated phase checks
allow execution to continue without waiting for user verification.

## Audit Baseline

The audit verified 15 distinct bugs. Its existing-suite baseline was 151
unit/component files and 2,535 passing tests; lint, typecheck, build, and the
manifest/bundle/store/site checks also passed. These are historical audit
results, not verification of this track's future implementation.

Nine isolated synthetic probes confirmed additional faulty behavior without
leaving application changes. Their scratch files were removed. Chromium E2E
could not launch because the Playwright browser executable was missing:
20 launch failures, 9 tests not run, 1 skipped. This is an environment blocker,
not evidence that application tests passed or failed.

## Functional Requirements

### Verified bugs

| ID | Priority | Requirement and original evidence anchor |
|---|---|---|
| B01 | P1 | Make restructure compensation non-destructive. A failed inverse move or failed child read must never authorize recursive deletion of a created folder containing surviving bookmarks. Preserve a recoverable snapshot; restructure undo must recreate deleted captured bookmarks, preserve metadata, and resume safely after partial failure. `src/restructure/apply.ts:202-206`, `src/undo/restore.ts:restoreRestructure`. |
| B02 | P1 | Restore summaries in both recreated-node and surviving-node undo metadata paths. Preserve summary-only rows and unrelated metadata. `src/undo/restore.ts:296-299`. |
| B03 | P1 | Preserve summaries through JSON export → parse → normalized import plan → writer → new bookmark IDs. Include the summary in metadata presence checks; a successful import must not silently discard it. `src/io/import-plan.ts:236-239`, `src/io/import-write.ts:hasMeta/writeMeta`. |
| B04 | P1 | Startup reconciliation must not delete valid metadata created concurrently with its tree read. Limit deletion candidates to the initial metadata snapshot and confirm absence against current native state; ambiguous/failed reads defer cleanup. `src/sync/reconcile.ts:52-56`. |
| B05 | P1 | Explanations and summaries must consult the persisted user blocklist before affected provider sends. Reject a blocked explanation rather than leaking decision-derived state, and re-check summary admission at the LLM and Jev hops. A changed blocklist during fallback/repair must prevent subsequent affected sends. `src/llm/explain.ts:140`, `src/decisions/summaries.ts:171-174`. |
| B06 | P1 | The LLM summary payload must use the minimized URL, never the original extraction URL containing query/fragment secrets. Match consent disclosures and store/site privacy text to actual fields, including the cleaned URL. `src/llm/summarize.ts:62`, `src/decisions/summaries.ts:254`. |
| B07 | P2 | Keep resource identity separate from egress minimization. Differing semantic queries (`/watch?v=A` versus `/watch?v=B`) or application hash routes must not attach page B's summary to bookmark A. Permit only explicitly allowlisted tracking differences; ordinary document anchors may be ignored, but application hash routes are identity-bearing. `src/decisions/summaries.ts:153-154`. |
| B08 | P1 | Serialize the generation limit used by the LLM reservation. Clamp a lower caller limit consistently; reject invalid/conflicting limits. Apply the bound on retries, structured-output fallbacks, and repairs. Unsupported limits fail visibly rather than being silently removed; provider-reported overruns must still be charged honestly. `src/net/llm-send.ts:379`. |
| B09 | P1 | Missing or partial provider usage must not become a free successful request. Preserve explicit reported, estimated, and unknown provenance; with known prices use conservative reservation bounds for missing token dimensions. Preserve the existing explicitly confirmed manual unpriced path and refuse automatic unpriced spending. `src/llm/client.ts:78`. |
| B10 | P2 | Revocation must block new egress immediately but retain the reservation/pricing snapshot necessary to settle an already-sent response exactly once, even after settings/key removal. Keep explicit delete-all semantics distinct from ordinary provider revoke. `src/messages/llm-provider.ts:740-743`. |
| B11 | P1 | Rapid pause/resume must not overlap runners for one job, resend the same offset concurrently, or let stale progress overwrite a terminal state. Keep pause/cancel intent and durable batch boundaries across restart. Do not claim exactly-once billing across a browser crash where the provider offers no idempotency contract. `src/entrypoints/background.ts:439-442`. |
| B12 | P1 | A second click while decision Undo is pending must not fall through to generic undo or revert a second operation. Keep the decision target until the operation settles; stale completions must not overwrite a newer toast. `src/entrypoints/sidepanel/App.tsx:361-366`. |
| B13 | P2 | Serialize undo replay and stack disposal across extension contexts, not just within one module instance. Preserve LIFO semantics, atomic targeted-head checks, persisted ID remaps, pop-on-success, and retryable failures. `src/undo/restore.ts:162-166`. |
| B14 | P2 | Hidden-mounted Options panels must reflect current custom Jev origin, LLM provider/cap, consent, and escalation state after enable/revoke/change without reload or remount. Pending/failed reads must not reuse stale origin grants. `src/entrypoints/options/DecisionSettings.tsx:311-402`. |
| B15 | P2 | Restructure preview and apply must revalidate the same reviewed bookmark scope, including Other/Mobile roots where available. Apply only accepted, still-resolved IDs; no assignment may be silently omitted because apply reads only the bookmarks bar. Preserve managed/root guards and the existing destination-root policy. `src/restructure/apply.ts:142-143`. |

The line anchors describe the audited baseline and will move during fixes.

### Named improvements

| ID | Requirement |
|---|---|
| I01 | Run lint, typecheck, unit/component tests, build, manifest/bundle checks, and isolated provider/entrypoint E2E on pull requests. Keep release-specific packaging/store gates separate from routine PR verification. Use read-only GitHub permissions; never introduce live provider keys. |
| I02 | Coalesce bookmark event bursts without losing the final native tree. Use a 50 ms refresh window, one in-flight tree read, and one trailing dirty refresh; cancel timers/listeners on unmount. A settled 100-event burst should require the initial read plus one refresh, not 101 reads. |
| I03 | Reuse unchanged search documents, preserve index identity, and avoid duplicate-group recomputation for metadata-only edits. Invalidate descendants on folder changes and indexed tag labels when definitions change. Keep search queries local and unpersisted. |
| I04 | Add permanent failure-injection, concurrency, cross-feature, and browser regressions for the audit findings. Assert correct outputs as well as zero-egress/request-count/accounting invariants. |
| I05 | Bound synthetic `popup:` decision retention to 300 rows using deterministic oldest-first cleanup, including legacy rows on startup/next save-suggest. Never prune real bookmark decisions, applied rows, snapshots, or unrelated audit history. Reuse `BookmarksManager-f7c`. |
| I06 | Bound near-duplicate planning to 500 emitted pairs and 50,000 candidate comparisons per plan. Avoid quadratic normalized-duplicate exclusion and unbounded common-token expansion. Preserve deterministic score/ID ordering over the evaluated candidates; disclose truncation rather than claiming exhaustive coverage. Include selected pair requests in pre-run estimates and durable progress, using the same persisted pair work set on resume. Reuse `BookmarksManager-w6y` and `BookmarksManager-2qk`. |
| I07 | Correct the README's stale `BookmarksManager-gyx` disclosure only after checking its closed issue evidence. Keep current browser prerequisites and verification instructions honest. Update Conductor workflow/stack descriptions when PR CI actually changes. |
| I08 | Restore the missing Playwright Chromium environment during implementation verification and run the real extension in isolated profiles with wire-level fake providers. Keep the native optional-host-permission prompt gap explicitly documented; no manual workaround or manual acceptance gate is required for this track. |

## Technical Approach

- Extend existing modules and tests instead of introducing a new state
  framework, provider abstraction, or bookmark store.
- Keep identity-bearing URLs in local matching only. Construct closed,
  minimized outbound summary payloads separately.
- Enforce the output allowance at the existing LLM egress gate and settle
  usage atomically from the durable reservation snapshot.
- Give each background job a single owner through completion of its current
  batch. Resume waits for that owner, then reloads committed progress;
  guarded writes prevent stale owners from changing newer state.
- Use one extension-origin Web Lock for undo stack read/replay/pop/disposal.
  Add a targeted undo primitive that checks its expected snapshot under the
  same lock. No module-local fallback may pretend to provide cross-context
  safety; an unavailable locking surface returns a typed, non-destructive
  refusal.
- Reuse Dexie live reads and existing total message protocols for Options
  state. Credentials remain worker-only.
- Use deterministic bounded near-duplicate planning shared by estimation
  and execution. Persist pair IDs and planning limits, not another raw
  content copy; support existing jobs conservatively.

## Non-Functional Requirements

1. Native `chrome.bookmarks` remains the tree authority. Preserve fixed-root,
   managed-node, URL-scheme, undo, and metadata compatibility guards.
2. Notes, raw URL secrets, full DOMs, credentials, and user data must not
   enter outbound bodies, logs, errors, issue descriptions, or fixtures.
3. All provider sends remain under `src/net/**` with current exact-origin
   consent and host permission checks. No new static content scripts,
   default egress, permissions, analytics, or remote code.
4. Use strict TypeScript and jitless Zod via `src/schemas/z.ts`. Reuse
   installed dependencies; no dependency change is required by this design.
5. Follow TDD for behavior changes. Use controlled deferred promises,
   synthetic public-looking domains, fake IndexedDB/bookmarks, fake clocks,
   and wire-level provider responses for deterministic regressions.
6. Preserve real user/untracked work, especially
   `.beads/.auto-import-issues.jsonl`. Use fresh browser profiles, never
   attached authenticated user profiles.
7. Phase boundaries remain sequential. Parallel tasks require disjoint
   ownership or an explicit dependency ordering overlapping files. One
   coordinator owns planning files, Beads state, local commits, and notes.
8. No manual verification gates. Every phase has an automated checkpoint.
   Browser launch failures block completion and are reported separately
   from application failures.
9. No automatic `git push`, `git pull`, `git fetch`, or `bd dolt push`.
   Provider live/evaluation suites stay key-gated and outside this track's
   local verification gate.

## Acceptance Criteria

- Every B01–B15 bug has a permanent regression that fails against the
  audited behavior and passes with the corresponding fix.
- I01–I08 each has an implementation/verification task and measurable
  evidence, including retention/work bounds and complete scan estimates.
- Undo and JSON round trips preserve summaries alongside tags/category/notes,
  including summary-only rows, remapped IDs, and surviving merge targets.
- Multi-context undo, failed restructure compensation, concurrent creation
  during reconcile, pause/resume with a held request, provider revoke with a
  held response, and Options changes without remount are tested explicitly.
- Blocklisted or mismatched summary inputs produce zero affected provider
  requests; allowed inputs succeed, and serialized payloads contain no
  synthetic query/fragment secret marker.
- Missing usage cannot silently lower a priced request's conservative
  committed spend to zero; late settlement after revoke is idempotent.
- Performance tests prove final-state correctness and bounded work.
  Preserve the existing analyze-on-save worst-of-10 gate below 1.5 s at a
  10k-bookmark corpus; add a 5k+ same-domain planning fixture.
- The final automated gate passes: `npm run lint`, `npm run typecheck`,
  `npm run test -- --run`, `npm run build`, `npm run check:manifest`,
  `npm run check:bundle`, `npm run check:store`, `npm run check:site`,
  and isolated `npm run test:e2e` with installed Chromium (Linux headed
  under Xvfb; macOS can use `E2E_HEADLESS=1`).
- Record exact commands and pass/fail/skip counts. Explain key-gated and
  native-prompt coverage exclusions; do not imply they ran.
- All 30 plan tasks and their Beads mappings are complete only after their
  automated acceptance criteria pass. No user manual acceptance is needed.

## Out of Scope

- Unrelated historical backlog, including title-quality heuristics, Jev
  cross-check-failure usage, handoff/protocol refactoring, broader egress
  lint, scanner hardening, key-write serialization, and real permission
  prompt automation.
- New product features, UI redesign, a new state framework, blanket
  architectural rewrites, or new providers.
- Retroactively recovering summaries/bookmarks already lost before these
  fixes, or guaranteeing exactly-once external billing after worker/browser
  failure without provider support.
- Public store submission, release ZIP regeneration, deployment, paid/live
  provider requests, or remote Git/Dolt synchronization.
- Implementing any fix while creating this planning track.
