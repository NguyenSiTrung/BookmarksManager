# Audit Hardening Implementation Plan

<!-- Last Revised: 2026-10-01 — B11 per-attempt paid-work authority -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` or `executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax. Read the spec and task's
> mapped Beads issue before claiming work.

**Goal:** Repair all named audit findings with permanent regressions,
bounded work, honest provider accounting, and PR quality gates.

**Architecture:** Preserve existing Chrome/Dexie/service-worker boundaries.
Separate local resource identity from minimized egress, coordinate undo across
contexts, and serialize job ownership through durable batch commits. Prefer
small extensions to existing modules over new frameworks.

**Tech Stack:** WXT MV3, strict TypeScript 6, React 19, Dexie 4, jitless Zod 4,
MiniSearch 7, Vitest 5/Testing Library, Playwright Chromium.

**Spec:** `conductor/tracks/audit_hardening_20261001/spec.md`

## Global Constraints

- **User override (2026-10-01): no manual checks, including at completion.**
  Replace workflow manual phase gates with automated checkpoints. Continue
  after an automated checkpoint passes; stop on failed/blocked checks.
- Phase boundaries are sequential even when tasks within a phase are parallel.
  Only annotated files are worker-owned. Explicit dependencies serialize
  tasks that share files. The coordinator owns track files, Beads operations,
  commits, and Git notes.
- No implementation task is started during track creation. All 30 tasks
  initially remain pending/open.
- Native bookmarks stay authoritative; managed/root guards and total
  message-result unions remain intact. All Zod imports use `src/schemas/z.ts`.
- Provider fetch remains under `src/net/**`. Re-check current exact-origin
  consent/permission and applicable blocklist before sensitive egress.
  Notes, full DOMs, credentials, and raw URL secrets remain unsent.
- Reuse installed dependencies. Use synthetic data, fake providers, and fresh
  extension profiles. Never use a saved user profile or real provider keys.
- Bounds: 50 ms tree refresh window; 300 retained synthetic popup decisions;
  500 emitted near-duplicate pairs; 50,000 candidate comparisons per plan.
  Preserve the 10k-corpus analyze-on-save worst-of-10 < 1.5 s gate.
- Reuse `BookmarksManager-f7c`, `BookmarksManager-w6y`, and
  `BookmarksManager-2qk`. Preserve their original descriptions/history and
  append this track's design/acceptance context.
- Per behavior task: failing regression → minimal implementation → targeted
  green tests/refactor → applicable local gate → coordinator updates
  plan/learnings → local commit and `git notes add` → close mapped Bead.
  Review the intended staged diff and preserve unrelated/untracked work.
- Never automatically push, pull, fetch, or run `bd dolt push`.
  `test:live`/`test:eval` stay outside the keyless local gate.
- File lists below are complete ownership boundaries, not permission for
  incidental refactors. If implementation requires a new shared file, revise
  ownership/dependencies before dispatching concurrent work.

## File and Interface Map

| Area | Files / contract |
|---|---|
| Tree mutation and restore | `src/restructure/apply.ts`, `src/undo/{restore,snapshot,lock}.ts`; guarded compensation, resumable replay, `undoLatest`, new atomic `undoExpected` |
| Metadata and import | `src/io/{import-plan,import-write}.ts`, `src/db/meta.ts`; existing `putMeta`, summary-carrying `ImportMeta` |
| Startup cleanup | `src/sync/reconcile.ts`; initial metadata candidate snapshot, live absence checks |
| AI privacy | `src/llm/{explain,summarize}.ts`, `src/decisions/{summaries,summary-identity}.ts`, consent/store/site docs |
| LLM accounting | `src/net/llm-send.ts`, `src/llm/{client,budget,wire}.ts`, `src/messages/llm-provider.ts`; bounded request, reservation-based settlement |
| Jobs | `src/jobs/{coordinator,queue,runner,estimate}.ts`, `src/schemas/job.ts`, `src/entrypoints/background.ts`; single owner, guarded writes, persisted pair plan |
| UI state | sidepanel `App.tsx`/`UndoToast.tsx`/`ScanPanel.tsx`; Options `DecisionSettings.tsx` and new `useDecisionProviderState.ts` |
| Live search/tree | `src/ui/hooks/{useBookmarkTree,useSearchIndex}.ts`, new `src/search/live-cache.ts`; coalescing and selective invalidation |
| Decision retention/pairs | `src/decisions/{store,candidates,near-duplicate-plan}.ts`; popup-only sweep and bounded deterministic pair plan |
| CI/integration | `.github/workflows/ci.yml`, new audit e2e specs/helpers, `README.md`, Conductor context |

## Task Protocol and Verification Commands

Task-specific code blocks are regression/implementation seeds, not a substitute
for reading the named modules. Extend the listed existing fixtures and setup;
do not keep the discarded audit scratch configuration or create another
parallel test harness.

Every behavior task has five concrete substeps. Run its named Vitest command
first to see the intended assertion fail, then rerun it after implementation.
Before the coordinator commits a task, run the applicable workflow slice:

```sh
npm run lint && npm run typecheck && npm run test -- --run &&
npm run build && npm run check:manifest && npm run check:bundle &&
npm run check:store
```

When touching egress/entrypoints, run the corresponding Playwright spec after
building. When touching the site, also run `npm run check:site`. Browser setup:

```sh
npx playwright install chromium
# macOS isolated runs:
E2E_HEADLESS=1 npm run test:e2e -- tests/e2e/llm.spec.ts
# Linux CI uses installed system dependencies and a virtual display:
xvfb-run -a npm run test:e2e
```

Use a fresh profile and wire-level fakes. Missing browser/dependency/display
failures block the relevant gate, not application assertions. Do not start
foreground watch modes or run key-gated suites to make a local gate green.

The coordinator commits only completed, verified task files, using the
repository's configured identity and recent conventional message style. Add
a task summary with `git notes add -m "..."`, record the SHA, and close the
mapped task. An automated checkpoint closes its phase only after all children
are complete. Phase container issues are coordination records, not separate
implementation work.

---

## Phase 1: Data safety
<!-- execution: parallel -->

- [x] Task 1: Non-destructive restructure compensation and resumable undo (6c20ef0)
  <!-- files: src/restructure/apply.ts, src/undo/restore.ts, tests/unit/restructure-apply.test.ts, tests/unit/undo.test.ts -->
  - Covers **B01**. Preserve `applyRestructurePlan(jobId, acceptedBookmarkIds?)`
    and `UndoResult`; add no unsafe bypass of mutation guards.
  - [x] Red: add controlled failures for the second forward move, the first
    inverse move, and a child lookup. Assert every original bookmark still
    resolves and occupied created folders remain. Add restructure undo of a
    deleted captured node plus a partial-replay retry with a persisted ID map.
    Extend `completedJob` and the installed fake in the existing tests.
    ```ts
    const result = await applyRestructurePlan(job.id);
    await api.removeTree("11");
    const undone = await undoRestructurePlan();
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      expect(undone.idMap["11"]).toBeDefined();
      expect((await api.get(undone.idMap["11"]!))[0]?.url)
        .toBe("https://a.io/x");
    }
    expect(result.snapshotId).toBeGreaterThan(0);
    ```
  - [x] Verify red:
    `npx vitest run tests/unit/restructure-apply.test.ts tests/unit/undo.test.ts`.
  - [x] Green: preserve the snapshot after incomplete compensation. Remove
    created folders bottom-up only after a successful empty-child read; use
    non-recursive empty removal so a racing child insertion fails safely.
    Recreate missing restructure nodes using existing `recreateSubtree`/
    `persistProgress`, restore metadata on recreated IDs, and move surviving
    IDs back without clobbering their later metadata edits.
    ```ts
    const children = await getChildren(id); // rejection means no deletion
    if (children.length !== 0) continue;
    await removeNode(id); // existing guard + Chrome's non-recursive remove
    ```
  - [x] Verify green: rerun the named tests; assert rollback failure retains a
    retryable snapshot and managed/root/occupied-folder cases remain safe.
  - [x] Coordinator gate/commit: use `fix(restructure): preserve bookmarks on
    failed compensation`, add notes, update learnings, close this task.

- [x] Task 2: Preserve summaries in undo metadata rewrites (1158910)
  <!-- files: src/undo/restore.ts, tests/unit/undo.test.ts -->
  <!-- depends: task1 -->
  - Covers **B02**. Existing `putMeta(id, fields)` remains the writer; both
    recreated-node and surviving merge-target branches must include summary.
  - [x] Red: add summary+notes and summary-only delete/merge snapshots, with
    assertions on remapped IDs and a surviving kept bookmark.
    ```ts
    await putMeta("bm-a1", { tags: [], summary: "Verified summary." });
    const captured = await captureNodes(["bm-a1"]);
    await pushSnapshot({ kind: "delete", ...captured });
    await removeTree("bm-a1");
    const undone = await undoLatest();
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      expect((await getMeta(undone.idMap["bm-a1"]!))?.summary)
        .toBe("Verified summary.");
    }
    ```
  - [x] Verify red: `npx vitest run tests/unit/undo.test.ts`.
  - [x] Green: add `summary: meta.summary ?? null` to both replacement
    `putMeta` payloads in `restoreMetaRows`; retain the no-orphan and
    summary-only emptiness behavior supplied by the metadata repository.
  - [x] Verify green: rerun undo tests including the Phase 1 Task 1 retry and
    surviving-node cases; no unrelated fields are lost.
  - [x] Coordinator gate/commit: `fix(undo): retain summaries during restore`,
    notes/learnings, close this task.

- [x] Task 3: Preserve summaries through the JSON import pipeline (e6a71cd)
  <!-- files: src/io/import-plan.ts, src/io/import-write.ts, tests/unit/io-import.test.ts -->
  - Covers **B03**. Extend `ImportMeta` with optional `summary?: string`;
    `fromEnvelope`, `planImport`, and `writeImport` retain existing interfaces.
  - [x] Red: import a v1 JSON bookmark with only a summary, then a full
    tags/category/notes/summary row. Assert the new ID's stored summary and
    successful import counts; old exports, CSV, and HTML remain compatible.
    ```ts
    const items = fromEnvelope({
      version: 1, exportedAt: "2026-09-30T00:00:00.000Z", tags: [],
      tree: [{ id: "old", title: "Reference", url: "https://ref.dev/" }],
      meta: [{ id: "old", tags: [], summary: "Saved summary.",
        updatedAt: "2026-09-30T00:00:00.000Z" }],
    });
    const result = await writeImport(
      planImport({ items, existingUrls: new Set() }),
    );
    expect(result.ok).toBe(true);
    expect((await db.bookmarkMeta.toArray())
      .some((row) => row.summary === "Saved summary.")).toBe(true);
    ```
  - [x] Verify red: `npx vitest run tests/unit/io-import.test.ts`.
  - [x] Green: carry summary in `toImportMeta`, include it in `hasMeta`, and
    conditionally spread it into `writeMeta`. Keep fields absent for formats
    that cannot represent summaries; reuse export/parser validation.
  - [x] Verify green: rerun import tests, including invalid summary fixtures,
    duplicate skipping, remapping, and a genuine export/parse/import round trip.
  - [x] Coordinator gate/commit: `fix(io): restore summaries from JSON backups`,
    notes/learnings, close this task.

- [x] Task 4: Race-safe startup metadata reconciliation (e183cc2)
  <!-- files: src/sync/reconcile.ts, tests/unit/sync-reconcile.test.ts -->
  - Covers **B04**. Preserve `reconcileMetadata(): Promise<number>`.
  - [x] Red: defer `getTree`, create a bookmark and summary metadata after
    the stale tree snapshot, then resume reconciliation. Assert live metadata
    survives; truly dead rows are still removed.
    ```ts
    const cleanup = reconcileMetadata();
    // The fixture releases the held stale read after native creation.
    await putMeta("concurrent", { tags: [], summary: "Keep me." });
    releaseTreeRead();
    await cleanup;
    expect((await getMeta("concurrent"))?.summary).toBe("Keep me.");
    ```
    Add the deferred read/release pair in this test file, not production code.
  - [x] Verify red: `npx vitest run tests/unit/sync-reconcile.test.ts`.
  - [x] Green: snapshot stored IDs before the native-tree read; operate only
    on those initial candidates. Re-check candidate absence against a fresh
    successful native read/probe before deletion. Preserve the empty-tree
    guard and defer cleanup when state or API reads are ambiguous.
  - [x] Verify green: rerun reconcile tests for creation during both read
    windows, deletion, invalid-but-live rows, failed probes, and empty trees.
  - [x] Coordinator gate/commit: `fix(sync): preserve concurrently created metadata`,
    notes/learnings, close this task.

- [x] Task 5: Automated checkpoint for data safety
  <!-- files: -->
  <!-- depends: task1, task2, task3, task4 -->
  - [x] Run Phase 1 tests together and the applicable local gate.
  - [x] Record command results, summary round-trip evidence, and failure/
    concurrency coverage in learnings and Beads notes.
  - [x] Close the checkpoint and phase only after all four tasks pass.
    Continue automatically to Phase 2; do not request manual verification.

## Phase 2: Privacy and summary identity
<!-- execution: sequential -->

- [x] Task 1: Enforce current blocklist for explanation and summary egress (0bb1b8b)
  <!-- files: src/llm/explain.ts, src/llm/summarize.ts, src/llm/client.ts, src/net/llm-send.ts, src/decisions/summaries.ts, tests/unit/llm-explain.test.ts, tests/unit/llm-summarize.test.ts, tests/unit/llm-client.test.ts, tests/unit/llm-gate.test.ts -->
  - Covers **B05**. Reuse `readBlocklist()` and `minimizeBookmark`; refuse
    blocked multi-bookmark explanations instead of sending partial derived
    state. Re-read before subsequent repair/fallback sends and the Jev hop.
  - [x] Red: persist a blocked synthetic public host, seed valid providers/
    consents, and exercise the real feature pipeline. Use existing
    `seedProvider`, `server`, and `jevTransportFor` fixtures.
    ```ts
    await db.metadata.put({
      key: "decisions:blocklist", value: ["a-site.com"],
    });
    const result = await summarizeActiveBookmark({
      tabId: TAB_ID, bookmarkId: BOOKMARK_ID,
      unknownCostConfirmed: true,
    });
    expect(result.ok).toBe(false);
    expect(server.requests).toHaveLength(0);
    ```
    Also change the list between LLM completion and Jev verification, and
    between a rejected structured tier and its fallback. Assert no later
    affected send and no unverified summary persistence.
  - [x] Verify red:
    `npx vitest run tests/unit/llm-explain.test.ts tests/unit/llm-summarize.test.ts`.
  - [x] Green: introduce feature-local admission callbacks using the current
    persisted list and live referenced URLs; wrap structured `send` calls so
    each actual send rechecks admission. Keep typed, content-free refusal
    results and the existing per-origin transport gates.
    `summarizePage` owns the summary structured-send wrapper, so its options
    carry the orchestrator's admission callback into fallback/repair sends.
    Thread feature admission through the existing client/gate options and
    run it before every actual transport attempt, including internal HTTP
    and transport retries. Refused retries must not create a second request
    or persist a rationale/summary; existing origin gates remain mandatory.
  - [x] Verify green: rerun named tests with blocked/allowed positive
    controls, subdomain matching, and list changes between hops.
  - [x] Coordinator gate/commit: `fix(privacy): honor blocklists in LLM features`,
    relevant isolated LLM E2E, notes/learnings, close this task.

- [x] Task 2: Minimized summary payload and accurate disclosures (c779b2e)
  <!-- files: src/llm/summarize.ts, src/decisions/summaries.ts, src/consent/disclosure.ts, src/consent/records.ts, src/schemas/provider.ts, src/messages/summaries.ts, src/entrypoints/sidepanel/SummaryDialog.tsx, store/privacy-policy.md, store/privacy-practices.md, store/listing.md, store/reviewer-notes.md, site/privacy/index.html, tests/unit/llm-summarize.test.ts, tests/unit/summary-messages.test.ts, tests/unit/consent-snapshot.test.ts, tests/unit/consent.test.ts, tests/components/summary-dialog.test.tsx, tests/e2e/provider.spec.ts, tests/e2e/llm.spec.ts -->
  - Covers **B06**. Preserve the public summary functions; build a minimized
    outbound payload separately from the original extraction used locally.
  - [x] Red: add a summary with synthetic query/fragment secret markers,
    capture serialized provider requests, and assert allowed summary success
    without those markers. Pin the cleaned URL in disclosure snapshots.
    ```ts
    const serialized = JSON.stringify(server.requests.map((r) => r.body));
    expect(serialized).not.toContain("audit_query_secret");
    expect(serialized).not.toContain("audit_fragment_secret");
    expect(serialized).toContain("https://a-site.com/article");
    ```
  - [x] Verify red:
    `npx vitest run tests/unit/llm-summarize.test.ts tests/unit/consent-snapshot.test.ts tests/unit/consent.test.ts`.
  - [x] Green: pass a copy with `url: minimized.url` to `summarizePage`;
    add defense-in-depth cleaning/refusal in its payload builder. Disclose
    cleaned URL and actual existing summary fields consistently in the
    runtime and store/site text. Bump the existing consent version so
    stale disclosures do not authorize newly clarified grants; preserve
    origin-scoped consent and reacquisition behavior.
    The consent version is owned by `src/consent/records.ts`; update the
    provider browser test's expected current grant version in the same task.
    Add a read-only summary consent preflight to the existing total message
    protocol. The dialog displays both exact recipients and per-scope field
    disclosures before an affirmative send. Echo the displayed origins and
    consent version; the worker re-resolves and checks them before granting.
    Remove unconditional stale-grant refresh. Preflight/dismissal authorizes
    neither extraction nor egress; stale/missing approval refuses safely.
  - [x] Verify green: rerun named tests, stale/current consent cases,
    `npm run check:manifest`, `npm run check:store`, `npm run check:site`,
    and isolated LLM E2E. Do not send a raw URL just to preserve matching.
  - [x] Coordinator gate/commit: `fix(privacy): minimize summary URLs and disclosures`,
    notes/learnings, close this task.

- [x] Task 3: Resource-aware local summary identity (d8a69d4)
  <!-- files: src/decisions/summary-identity.ts, src/decisions/summaries.ts, tests/unit/summary-identity.test.ts, tests/unit/llm-summarize.test.ts -->
  - Covers **B07**. Create the pure local contract:
    ```ts
    export function summaryResourceKey(url: string): string | null;
    export function sameSummaryResource(saved: string, active: string): boolean;
    ```
    Keep these keys out of egress/storage/logs.
  - [x] Red: add query identity, tracking-only difference, port/origin/path,
    document-anchor, and application-hash-route cases.
    ```ts
    expect(sameSummaryResource(
      "https://video.dev/watch?v=A", "https://video.dev/watch?v=B",
    )).toBe(false);
    expect(sameSummaryResource(
      "https://ref.dev/p?utm_source=x", "https://ref.dev/p",
    )).toBe(true);
    expect(sameSummaryResource(
      "https://app.dev/#/item/A", "https://app.dev/#/item/B",
    )).toBe(false);
    ```
    Also assert a mismatch produces zero LLM/Jev calls.
  - [x] Verify red:
    `npx vitest run tests/unit/summary-identity.test.ts tests/unit/llm-summarize.test.ts`.
  - [x] Green: parse sendable URLs; canonicalize only normal URL syntax and
    remove `utm`, `utm_*`, `gclid`, `fbclid`, `msclkid` tracking keys. Preserve
    all other query data, original ordering, and nonempty fragments
    conservatively, including `#/` and `#!` application routes. Do not guess
    that an ambiguous fragment is a harmless document anchor. Compare local
    keys before independently minimizing the outbound URL.
  - [x] Verify green: rerun tests for malformed/unsupported URLs,
    duplicated query keys, tracking controls, and provider zero-egress.
  - [x] Coordinator gate/commit: `fix(summary): match resources before URL minimization`,
    relevant LLM E2E, notes/learnings, close this task.

- [x] Task 4: Automated checkpoint for privacy and identity
  <!-- files: -->
  - [x] Run Phase 2 tests, privacy/consent gates, build, store/site checks,
    and isolated LLM E2E.
  - [x] Record blocked/allowed request counts and secret-marker assertions,
    including changed-list fallback and separate identity tests.
  - [x] Close checkpoint/phase and continue without a manual gate.

## Phase 3: LLM limits and accounting
<!-- execution: sequential -->

- [x] Task 1: Enforce the reserved output allowance on the wire (a43400f)
  <!-- files: src/net/llm-send.ts, src/llm/client.ts, src/llm/wire.ts, tests/unit/llm-gate.test.ts, tests/unit/llm-client.test.ts, tests/unit/llm-wire.test.ts, tests/unit/llm-structured.test.ts, tests/e2e/llm.spec.ts, tests/e2e/helpers/llm.ts -->
  - Covers **B08**. Existing `max_tokens` is the default OpenAI-compatible
    limit; the gate, not a caller-supplied policy, owns serialization.
  - [x] Red: extend the existing happy-path `send` fixture to assert its
    50-token reservation matches the captured request; cover tighter/larger
    caller limits, invalid values, retries, tier fallback, and repair.
    ```ts
    const { result, fetch: fakeProvider } = send({ maxOutputTokens: 50 });
    const { reservation } = await result;
    expect(reservation.maxOutputTokens).toBe(50);
    expect(fakeProvider.requests[0]?.body).toMatchObject({ max_tokens: 50 });
    ```
  - [x] Verify red:
    `npx vitest run tests/unit/llm-gate.test.ts tests/unit/llm-wire.test.ts tests/unit/llm-structured.test.ts`.
  - [x] Green: strict-validate positive integer bounds; use
    `Math.min(parsed.max_tokens ?? declared, declared)` in both reservation
    and serialized body. Reject conflicting alternate limit fields; do not
    silently retry without a cap if the provider rejects `max_tokens`.
    Capability-tier fallback must not classify a token-limit rejection as a
    structured-output rejection. Charge any reported overrun rather than
    truncating usage to the reserved allowance.
    User-approved exception (2026-10-01): LLM capability classification may
    read a strictly bounded, validated error body internally, never log or
    propagate it. Explicit token-limit fields/mentions veto structured
    fallback; ambiguous, malformed and oversized bodies fail visibly.
    Preserve actual structured-capability fallback without dropping the cap.
  - [x] Verify green: rerun named tests and fake-provider cap rejection/
    overrun controls, including every actual repair/fallback request body.
  - [x] Coordinator gate/commit: `fix(llm): enforce reserved output limits`,
    relevant isolated LLM E2E, notes/learnings, close this task.

- [x] Task 2: Conservative missing and partial usage settlement (305f43c)
  <!-- files: src/llm/client.ts, src/llm/budget.ts, src/net/llm-send.ts, tests/unit/llm-client.test.ts, tests/unit/llm-budget.test.ts, tests/unit/llm-gate.test.ts, tests/unit/llm-structured.test.ts, tests/unit/llm-explain.test.ts, tests/unit/llm-summarize.test.ts -->
  - Covers **B09**. Extend `ActualUsage` so absent input/output token counts
    remain absent, rather than becoming zero. Preserve `settleLlmUsage`.
  - [x] Red: successful missing/partial usage and malformed JSON must not
    turn priced spending into zero; reported zero remains distinguishable
    from absence, and reported cost takes precedence.
    ```ts
    const settled = reconcileBudget(reservation, {}, NOW);
    expect(settled.usageRow.estimatedCostUsd).toBe(reservation.reservedUsd);
    expect(settled.usageRow.provenance).toBe("estimated");
    ```
    Use the existing priced reservation fixture; add explicit unpriced
    manual and automatic refusal controls.
  - [x] Verify red:
    `npx vitest run tests/unit/llm-client.test.ts tests/unit/llm-budget.test.ts tests/unit/llm-gate.test.ts`.
  - [x] Green: parse usage without substituting zeros. For each missing
    token dimension, reconcile with its reservation bound; estimate from
    the reservation's pricing snapshot. Without prices/cost, record unknown
    monetary cost. Retain atomic/idempotent settlement and prevent the
    current TTL cleanup from silently converting unresolved paid exposure
    into free requests; test the unknown-exposure path explicitly.
    Settle each actual retry attempt separately before admitting another,
    preserving earlier estimated/unknown amounts alongside final reported
    cost, including reported zero and prior overruns. Retry admission repeats
    current provider/model/origin, consent/permission and feature checks.
    Update adjacent consumer row expectations for per-attempt reservations,
    retaining exact spend, wire-cap and zero-egress assertions.
  - [x] Verify green: rerun named tests for partial counts, null/negative
    costs, genuine zeros, concurrent settlement, UTC month boundaries,
    missing usage on HTTP/error paths, and subsequent budget admission.
  - [x] Coordinator gate/commit: `fix(llm): account conservatively for missing usage`,
    relevant LLM E2E, notes/learnings, close this task.

- [x] Task 3: Preserve in-flight accounting through provider revoke (f4dc035)
  <!-- files: src/messages/llm-provider.ts, src/net/llm-send.ts, tests/unit/llm-provider-messages.test.ts, tests/unit/llm-client.test.ts, tests/unit/llm-gate.test.ts, tests/e2e/llm.spec.ts, tests/e2e/helpers/llm.ts -->
  - Covers **B10**. Consent removal remains first. Settlement uses the
    reservation snapshot, not the provider settings that revoke removes.
  - [x] Red: hold a fake response after the request leaves, revoke the
    provider, then release its successful response. Assert a new send is
    blocked, the old usage is stored once, and duplicate settlement is inert.
    ```ts
    await revokeWhileResponseIsHeld();
    releaseHeldCompletion();
    await inFlightSend;
    expect(await db.llmUsage.count()).toBe(1);
    await settleLlmUsage(reservationId, "llm_explain", actualUsage);
    expect(await db.llmUsage.count()).toBe(1);
    ```
    Add these deferred-response helpers to the existing test file; no
    production test-only protocol is introduced.
  - [x] Verify red:
    `npx vitest run tests/unit/llm-provider-messages.test.ts tests/unit/llm-client.test.ts tests/unit/llm-gate.test.ts`.
  - [x] Green: revoke grants/settings/key as before but retain active
    reservations until terminal reconciliation. Prune only accounted terminal
    rows under the existing retention policy; preserve unknown paid exposure
    from Task 2. Ordinary revoke must not erase usage; explicit delete-all
    still follows its separate intentional wipe contract.
  - [x] Verify green: rerun named tests for revoke failures, key deletion,
    late success/error, double settle, re-enable, and delete-all distinction.
    Add isolated real-extension browser controls for omitted successful usage
    and revoke while an actual routed response is held. Assert conservative
    stored amounts, matching wire caps, zero new egress and one late usage row.
  - [x] Coordinator gate/commit: `fix(llm): settle in-flight requests after revoke`,
    relevant LLM E2E, notes/learnings, close this task.

- [x] Task 4: Automated checkpoint for LLM limits and accounting
  <!-- files: -->
  - [x] Run Phase 3 tests, the applicable full local gate, and isolated LLM
    E2E with bounded requests, omitted usage, and held revoke responses.
  - [x] Record reserved/committed amounts and reported/estimated/unknown
    controls. Clearly separate a provider ignoring its cap from accounting.
  - [x] Close checkpoint/phase and continue without a manual gate.

## Phase 4: Workflow and UI correctness
<!-- execution: parallel -->

- [x] Task 1: Single-owner scan runners and guarded progress
  <!-- files: src/jobs/coordinator.ts, src/jobs/queue.ts, src/jobs/runner.ts, src/schemas/job.ts, src/entrypoints/background.ts, src/restructure/assign.ts, src/decisions/pipeline.ts, src/decisions/duplicates.ts, src/llm/escalate.ts, src/jev/client.ts, src/net/send.ts, tests/unit/job-coordinator.test.ts, tests/unit/jobs-queue.test.ts, tests/unit/jobs-runner.test.ts, tests/unit/background-jobs.test.ts, tests/unit/decisions-pipeline.test.ts, tests/unit/decisions-duplicates.test.ts, tests/unit/llm-escalate.test.ts, tests/unit/jev-client.test.ts, tests/unit/network-gate.test.ts, tests/e2e/decisions.spec.ts -->
  - Covers **B11**. Create a worker-local coordinator for all production
    `runPersistedJob` entry paths; one MV3 worker owns production scans.
    ```ts
    export function coordinateJob(
      jobId: string, drive: () => Promise<void>,
    ): Promise<void>;
    ```
    Persist an owner generation for guarded writes, with a compatible
    default for old jobs.
  - [ ] Red: hold the first analysis mid-batch, pause then resume twice,
    release it, and assert one active runner, no concurrently repeated
    bookmark request, monotonic committed batches, and stable completion.
    ```ts
    const first = coordinateJob("job-a", drive);
    const second = coordinateJob("job-a", drive);
    expect(first).toBe(second);
    releaseDrive();
    await Promise.all([first, second]);
    expect(drive).toHaveBeenCalledTimes(1);
    ```
    Add stale-owner completion/failure/progress writes and restart controls.
  - [ ] Verify red:
    `npx vitest run tests/unit/job-coordinator.test.ts tests/unit/jobs-queue.test.ts tests/unit/jobs-runner.test.ts tests/unit/background-jobs.test.ts`.
  - [ ] Green: keep the drive promise keyed by job ID until its batch settles.
    Resume waits for the existing owner, then re-reads status/progress before
    relaunch; terminal/canceled jobs never relaunch. Claim a generation in a
    transaction and guard every progress/status write against owner mismatch
    and terminal state. Observe pause/cancel before new paid work.
    Pass the captured owner generation through the actual restructure
    assignment callback, so a held superseded response cannot merge stale
    assignments after progress/status fencing has rejected that owner.
    Carry captured authority through actual analysis, duplicate-pair and
    escalation callbacks to every transport attempt, including queued,
    preflight and retry waits. Drain sibling wire batches before releasing
    ownership on rejection. Same-owner paused batches may drain; canceled
    or superseded owners must start no new paid request.
  - [ ] Verify green: rerun named tests with repeated pause/resume/cancel,
    batch failures, both analysis and restructure jobs, and worker restart.
    Preserve documented at-least-once uncommitted-batch crash behavior.
  - [ ] Coordinator gate/commit: `fix(jobs): serialize pause and resume runners`,
    isolated decisions E2E, notes/learnings, close this task.

- [x] Task 2: Extension-wide undo serialization and atomic targeted replay
  <!-- files: src/undo/lock.ts, src/undo/restore.ts, src/decisions/apply.ts, tests/fakes/web-locks.ts, tests/setup-web-locks.ts, vitest.config.ts, tests/unit/undo-lock.test.ts, tests/unit/undo.test.ts, tests/unit/decisions-apply.test.ts -->
  - Covers **B13**. One origin-scoped exclusive Web Lock protects every
    replay/discard path. Preserve public generic undo/discard result unions.
    ```ts
    export function withUndoLock<T>(run: () => Promise<T>): Promise<T>;
    export function undoExpected(snapshotId: number): Promise<UndoResult>;
    ```
    Add a typed `conflict` refusal and map it to existing decision
    `undo_conflict`; never hold the lock and recursively acquire it.
  - [ ] Red: import independent restore-module instances over the same DB,
    start simultaneous restores of one delete snapshot, and assert only one
    recreated bookmark. Assert a targeted undo cannot lose its checked head
    to another context before replay.
    ```ts
    const results = await Promise.all([contextA.undoLatest(), contextB.undoLatest()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await api.getChildren("1"))
      .filter((node) => node.url === restoredUrl)).toHaveLength(1);
    ```
    Provide a shared fake LockManager in the new lock test; missing-lock
    tests must prove a typed refusal with zero mutations.
  - [ ] Verify red:
    `npx vitest run tests/unit/undo-lock.test.ts tests/unit/undo.test.ts tests/unit/decisions-apply.test.ts`.
  - [ ] Green: acquire `navigator.locks.request` with one stable extension
    lock name and exclusive mode around read/replay/pop/discard. Keep the
    existing internal queue for same-context ordering, not as a fallback.
    Implement `undoExpected`'s head comparison inside the lock; replace
    decision compensation/revert's separate peek-then-undo calls with it.
    Put the shared queueing fake in `tests/fakes/web-locks.ts` and register
    `tests/setup-web-locks.ts` as `setupFiles` in both Vitest projects so
    existing undo callers keep exercising a real serialization contract in
    jsdom/Node. Missing/rejected-lock tests explicitly override that fake.
  - [ ] Verify green: rerun tests for independent contexts, lock rejection/
    absence, release after failure, retry/idMap persistence, targeted conflict,
    summary restoration, and next-snapshot ordering.
  - [ ] Coordinator gate/commit: `fix(undo): coordinate restores across contexts`,
    isolated core-manager E2E, notes/learnings, close this task.

- [x] Task 3: Re-entry-safe decision toast undo
  <!-- files: src/entrypoints/sidepanel/App.tsx, src/entrypoints/sidepanel/UndoToast.tsx, tests/components/sidepanel-actions.test.tsx, tests/components/undo-reentry.test.tsx -->
  - Covers **B12**. The dispatch guard lives before choosing decision versus
    generic undo; the existing generic controller guard alone is insufficient.
  - [ ] Red: apply a review decision through the real sidepanel harness,
    hold `REVERT_DECISION`, click Undo twice, and assert exactly one revert
    and zero generic undos. Navigate via the existing More-menu helpers.
    ```ts
    fireEvent.click(undoButton);
    fireEvent.click(undoButton);
    expect(revertCalls).toBe(1);
    expect(genericUndoSpy).not.toHaveBeenCalled();
    ```
    Also replace/dismiss the toast while the held revert is outstanding.
  - [ ] Verify red:
    `npx vitest run tests/components/sidepanel-actions.test.tsx tests/components/undo-reentry.test.tsx`.
  - [ ] Green: acquire a synchronous in-flight ref before dispatch. Preserve
    the target until settlement, release in `finally`, and use a toast
    generation/token so an old completion cannot overwrite a newer toast.
    Expose busy/disabled Undo state accessibly without altering generic undo.
  - [ ] Verify green: rerun named component tests with resolve/reject paths,
    newer-toast races, dismissal, keyboard activation, and subsequent retry.
  - [ ] Coordinator gate/commit: `fix(ui): guard decision undo dispatch`,
    isolated decisions E2E, notes/learnings, close this task.

- [x] Task 4: Align restructure preview and apply scope
  <!-- files: src/restructure/apply.ts, src/messages/restructure.ts, tests/unit/restructure-apply.test.ts, tests/unit/restructure-messages.test.ts -->
  - Covers **B15**. Existing `buildRestructureDiff` and reviewed accepted
    IDs remain authoritative; preserve the destination root policy.
  - [ ] Red: preview assignments from Bookmarks bar, Other, and Mobile;
    apply accepted IDs from each and assert the move count and live parents.
    ```ts
    const result = await applyRestructurePlan(job.id, ["bar-id", "other-id", "mobile-id"]);
    expect(result.moved).toBe(3);
    ```
    Seed all roots through the existing bookmarks fake and completed-job
    helper; assert unaccepted/stale/managed rows do not move.
  - [ ] Verify red:
    `npx vitest run tests/unit/restructure-apply.test.ts tests/unit/restructure-messages.test.ts`.
  - [ ] Green: use full `getTree()` revalidation at apply, matching preview/
    status, then filter the reviewed ID set. Read failures produce a typed
    refusal, never a silent empty scope. Keep B01's safe compensation.
  - [ ] Verify green: rerun named tests including selective apply, user moves
    between review/apply, managed roots, and undo back to original roots.
  - [ ] Coordinator gate/commit: `fix(restructure): apply the full reviewed scope`,
    isolated LLM E2E, notes/learnings, close this task.

- [x] Task 5: Reactive provider and escalation state in Options
  <!-- files: src/entrypoints/options/DecisionSettings.tsx, src/entrypoints/options/useDecisionProviderState.ts, tests/components/options-decisions.test.tsx, tests/components/options-app.test.tsx, tests/components/options-llm-settings.test.tsx -->
  - Covers **B14**. Create a focused live-read hook keyed by relevant
    metadata/consent changes; obtain origin/status through existing worker
    protocols. Keep keys and credential reads out of the UI import graph.
  - [ ] Red: keep the Options shell mounted, enable/change/revoke a custom
    Jev and LLM provider, switch its panels, and assert updated radios,
    origin/consent/cap/escalation controls without remount.
    ```ts
    expect(screen.queryByRole("radio", { name: /custom/i })).toBeNull();
    await enableCustomProviderInMountedShell();
    expect(await screen.findByRole("radio", { name: /custom/i })).not.toBeNull();
    ```
    Add the mounted-shell helper in the component test using current
    `OptionsApp` props/protocol mocks.
  - [ ] Verify red:
    `npx vitest run tests/components/options-decisions.test.tsx tests/components/options-app.test.tsx tests/components/options-llm-settings.test.tsx`.
  - [ ] Green: use `useLiveQuery` for revision inputs and refetch the typed
    status messages on changes. Tag results with their requested identity;
    mismatched pending results are not reused. Cancel stale reads, preserve
    a user's explicit provider selection, and surface settled read errors.
  - [ ] Verify green: rerun named tests for enable/revoke/origin/cap changes,
    toggles, rapid changes, hidden-mounted panels, and retryable failures.
  - [ ] Coordinator gate/commit: `fix(options): refresh live provider state`,
    isolated provider/LLM E2E, notes/learnings, close this task.

- [ ] Task 6: Automated checkpoint for workflow and UI correctness
  <!-- files: -->
  <!-- depends: task1, task2, task3, task4, task5 -->
  - [ ] Run Phase 4 unit/component tests and the applicable local gate.
    Run decisions/provider/core-manager/LLM isolated E2E.
  - [ ] Record single-runner counts, cross-context lock evidence, exact
    decision/generic undo dispatch counts, full-scope moves, and no-remount
    Options transitions.
  - [ ] Close checkpoint/phase and continue without a manual gate.

## Phase 5: Bounded performance
<!-- execution: parallel -->

- [x] Task 1: Coalesce native bookmark refresh bursts
  <!-- files: src/ui/hooks/useBookmarkTree.ts, tests/components/useBookmarkTree.test.tsx -->
  - Covers **I02**. Preserve `useBookmarkTree(): FlattenedTree`.
  - [ ] Red: use fake timers to emit 100 synchronous events after the
    initial read; assert one trailing refresh and the final 100-bookmark
    state. Also emit events while a tree read is held.
    ```ts
    await act(async () => {
      emitOneHundredBookmarkEvents();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(latest?.bookmarks.size).toBe(100);
    ```
    Build the emitter from the installed event fake in this test file.
  - [ ] Verify red: `npx vitest run tests/components/useBookmarkTree.test.tsx`.
  - [ ] Green: retain immediate initial read, schedule subsequent refreshes
    through a 50 ms window, allow only one read in flight, and queue one
    dirty trailing read. Keep generation/cancellation guards and cancel
    timers/listeners on unmount; failed reads wait for a new event to retry.
  - [ ] Verify green: rerun all five event types, delayed reads, failures,
    unmount cleanup, and settled burst correctness. Keep UI waits aligned
    with intentional coalescing rather than immediate render assumptions.
  - [ ] Coordinator gate/commit: `perf(tree): coalesce bookmark event refreshes`,
    isolated core-manager/search E2E, notes/learnings, close this task.

- [x] Task 2: Selective live search document invalidation
  <!-- files: src/ui/hooks/useSearchIndex.ts, src/search/live-cache.ts, tests/components/useSearchIndex.test.tsx, tests/unit/search-live-cache.test.ts -->
  - Covers **I03**. Preserve `useSearchIndex(tree, metas, tagDefs)` and
    stable MiniSearch index identity. The pure cache has no Chrome/React I/O.
  - [ ] Red: seed 10k documents, edit one bookmark's metadata, and assert
    only that document is rebuilt/replaced and duplicate collection does not
    rerun. Rename a folder and assert descendant paths invalidate.
    ```ts
    const sameIndex = latest?.index;
    await editOneMetaAndRerender();
    expect(latest?.index).toBe(sameIndex);
    expect(duplicateCollectorSpy).not.toHaveBeenCalled();
    expect(documentBuilderSpy).toHaveBeenCalledTimes(1);
    ```
    Define these spies/helpers in the existing hook test; retain query
    correctness checks rather than measuring a fast failure.
  - [ ] Verify red:
    `npx vitest run tests/components/useSearchIndex.test.tsx tests/unit/search-live-cache.test.ts`.
  - [ ] Green: cache relevant bookmark/ancestor/meta/tag inputs, reuse
    unchanged documents, rebuild only invalidated ones, and run duplicate
    grouping only when IDs/URLs change. Track folder descendants and tag
    label dependents; preserve tree-order context even without doc changes.
  - [ ] Verify green: rerun adds/removes/moves, folder rename, tag rename,
    metadata/category/notes updates, duplicate filters, index identity, and
    unmount memory cleanup. Search queries remain unsent and unpersisted.
  - [ ] Coordinator gate/commit: `perf(search): reuse unchanged index documents`,
    isolated search E2E, notes/learnings, close this task.

- [x] Task 3: Bound synthetic popup decision retention
  <!-- files: src/decisions/store.ts, src/entrypoints/background.ts, tests/unit/decisions-store.test.ts, tests/unit/decisions-save-suggest.test.ts, tests/components/popup-suggestions.test.tsx -->
  - **Reuse `BookmarksManager-f7c`; covers I05.**
    ```ts
    export const POPUP_DECISION_LIMIT = 300;
    export function prunePopupDecisions(): Promise<number>;
    ```
  - [ ] Red: seed more than 300 synthetic pending/unsure popup rows plus
    real pending/applied rows and snapshots. Sweep and assert only the oldest
    eligible synthetic rows disappear; tied timestamps sort by decision ID.
    ```ts
    await prunePopupDecisions();
    const rows = await db.decisions.toArray();
    expect(rows.filter((row) =>
      row.bookmarkIds.every((id) => id.startsWith("popup:")),
    ).length).toBeLessThanOrEqual(300);
    expect(await getDecision("real-applied")).toBeDefined();
    ```
  - [ ] Verify red:
    `npx vitest run tests/unit/decisions-store.test.ts tests/unit/decisions-save-suggest.test.ts tests/components/popup-suggestions.test.tsx`.
  - [ ] Green: transactional popup-only retention after synthetic suggestion
    persistence and a fail-soft startup/next-save legacy sweep. Scope cleanup
    to rows whose references are all synthetic and whose status is safe to
    prune; never delete applied/audit/undo or mixed/real bookmark rows.
  - [ ] Verify green: rerun concurrent popup opens, legacy cleanup, failure
    recovery, retention bounds, and preservation controls.
  - [ ] Coordinator gate/commit: `fix(decisions): bound popup suggestion retention`,
    isolated decisions E2E, append original Bead context, close `f7c`.

- [x] Task 4: Bounded deterministic near-duplicate candidate planning
  <!-- files: src/decisions/candidates.ts, src/decisions/near-duplicate-plan.ts, tests/unit/decisions-candidates.test.ts, tests/unit/near-duplicate-plan.test.ts, tests/unit/decisions-perf.test.ts -->
  - **Reuse `BookmarksManager-w6y`; covers candidate work in I06.**
    Keep `nearDuplicatePairs(bookmarks)` as a compatible wrapper; create:
    ```ts
    export const NEAR_DUPLICATE_PAIR_LIMIT = 500;
    export const NEAR_DUPLICATE_COMPARISON_LIMIT = 50_000;
    export interface NearDuplicatePlan {
      pairs: NearDuplicatePair[];
      comparisons: number;
      truncated: boolean;
    }
    export function planNearDuplicates(
      bookmarks: readonly NearDuplicateSource[],
    ): NearDuplicatePlan;
    ```
    Import the existing source/pair types from `candidates.ts`; use type-only
    imports so the wrapper does not create a runtime circular dependency.
  - [ ] Red: 5k+ same-domain common-title and normalized-duplicate fixtures
    must stay under both bounds and preserve deterministic results when
    input order changes. Compare small uncapped fixtures to current semantics.
    ```ts
    const plan = planNearDuplicates(dominantDomainBookmarks);
    expect(plan.pairs.length).toBeLessThanOrEqual(500);
    expect(plan.comparisons).toBeLessThanOrEqual(50_000);
    expect(plan.truncated).toBe(true);
    expect(planNearDuplicates([...dominantDomainBookmarks].reverse()))
      .toEqual(plan);
    ```
  - [ ] Verify red:
    `npx vitest run tests/unit/near-duplicate-plan.test.ts tests/unit/decisions-candidates.test.ts tests/unit/decisions-perf.test.ts`.
  - [ ] Green: map normalized URLs to duplicate group keys rather than
    enumerating every duplicate pair. Bucket by domain and inverted title
    token, sort candidates by stable IDs, bound common-token posting
    expansion and candidate attempts (including filtered/duplicate attempts)
    before scoring, then sort selected candidates by
    similarity/IDs and take 500. Mark truncation whenever work/output was
    limited. Do not claim globally exhaustive top-K under bounded evaluation.
  - [ ] Verify green: rerun dominant-domain/common-token/exact-duplicate,
    empty/no-domain, threshold, determinism, and existing analyze-on-save
    performance gates with correctness/request-count controls.
  - [ ] Coordinator gate/commit: `perf(decisions): bound near-duplicate planning`,
    notes/learnings, close `w6y`; do not close the cost-estimate Bead yet.

- [x] Task 5: Pair-inclusive scan estimates and durable work plans
  <!-- files: src/jobs/estimate.ts, src/jobs/queue.ts, src/jobs/runner.ts, src/schemas/job.ts, src/entrypoints/background.ts, src/entrypoints/sidepanel/ScanPanel.tsx, tests/unit/jobs-estimate.test.ts, tests/unit/jobs-queue.test.ts, tests/unit/jobs-runner.test.ts, tests/unit/background-jobs.test.ts, tests/components/scan-panel.test.tsx, tests/components/sidepanel-scan-ask.test.tsx -->
  <!-- depends: task3, task4 -->
  - **Reuse `BookmarksManager-2qk`; covers estimates/progress in I06.**
    Task 3 precedes this task because both own `background.ts`; Task 4
    supplies `planNearDuplicates` and bounds.
  - [ ] Red: assert estimate request counts and queued totals include each
    selected pair, not just bookmark batches. Persist the selected pair IDs,
    restart with changed title ordering, and assert resume uses the stored
    work set without skipping/resending a committed pair batch.
    ```ts
    expect(estimate.requests).toBe(bookmarks.length + plan.pairs.length);
    expect(job.progress.totalBatches).toBe(
      Math.ceil(bookmarks.length / job.batchSize)
        + Math.ceil(plan.pairs.length / job.batchSize),
    );
    expect(job.nearDuplicatePlan?.pairs).toEqual(pairIds);
    ```
  - [ ] Verify red:
    `npx vitest run tests/unit/jobs-estimate.test.ts tests/unit/jobs-queue.test.ts tests/unit/jobs-runner.test.ts tests/unit/background-jobs.test.ts tests/components/scan-panel.test.tsx tests/components/sidepanel-scan-ask.test.tsx`.
  - [ ] Green: extend estimate options with kind and ID-bearing bookmarks;
    add request/pair/truncation counts while retaining token-lower-bound
    wording. Extend `Job` compatibly with optional `nearDuplicatePlan`
    containing pair IDs, planner limits/version, and truncation state.
    Enqueue resolved bounded pair plans, initialize truthful batch totals,
    and execute the stored plan on resume. Legacy uncommitted jobs acquire
    one plan; fail typed rather than reinterpret ambiguous committed pair
    offsets. Display the truncation/cost scope before a new scan starts.
  - [ ] Verify green: rerun library versus selection scans, zero pairs,
    truncated plans, old jobs, title edits/restart, held pause/resume, exact
    progress/request counts, and no raw metadata in persisted plan fields.
  - [ ] Coordinator gate/commit: `fix(jobs): include pair work in scan estimates`,
    isolated decisions E2E, append original Bead context, close `2qk`.

- [ ] Task 6: Automated checkpoint for bounded performance
  <!-- files: -->
  <!-- depends: task1, task2, task3, task4, task5 -->
  - [ ] Run Phase 5 tests and the applicable local gate; run search and
    decisions E2E. Record 100-event reads, selective index updates, synthetic
    retention, pair/comparison bounds, and estimate/actual request counts.
  - [ ] Verify the existing 10k-corpus worst-of-10 < 1.5 s benchmark with
    its disclosed gate bypasses and successful-output assertions.
  - [ ] Close checkpoint/phase and continue without a manual gate.

## Phase 6: CI and integrated regressions
<!-- execution: parallel -->

- [x] Task 1: Pull-request quality gates separated from release checks
  <!-- files: .github/workflows/ci.yml, tests/unit/ci-workflow.test.ts -->
  - Covers **I01**. Routine PR CI uses read-only permissions and no secrets;
    published-release/manual store packaging checks stay separate.
  - [ ] Red: add a local config contract test reading the workflow and
    asserting PR triggers, quality steps, Chromium/Xvfb prerequisites,
    read-only permissions, and release-only strict store checks.
    ```ts
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8",
    );
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/contents:\s*read/);
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run test:e2e");
    ```
  - [ ] Verify red: `npx vitest run tests/unit/ci-workflow.test.ts`.
  - [ ] Green: add `pull_request` and `push` on `main` triggers with
    `permissions: { contents: read }`. Keep a routine lint/types/unit/build/
    manifest/bundle/site/E2E quality job; make release-strict store/packaging
    depend on it and run only for published release/manual dispatch.
    Preserve Node 22, dependency installation, and headed Chromium setup.
  - [ ] Verify green: rerun the config contract test and locally execute the
    routine job's commands. Do not publish a PR, run release packaging, or
    claim hosted CI ran during local verification.
  - [ ] Coordinator gate/commit: `ci: run quality gates on pull requests`,
    notes/learnings, close this task.

- [ ] Task 2: Cross-feature browser data-safety regressions
  <!-- files: tests/e2e/audit-data-safety.spec.ts, tests/e2e/helpers/audit-data.ts -->
  - Covers **I04/I08**, exercising **B01–B04/B13/B15** through real extension
    surfaces/IndexedDB and the existing isolated extension launcher.
  - [ ] Add failing coverage by running the new specs against the audited
    revision in a separate clean worktree when needed. Current HEAD must not
    be reset or user files overwritten. Cover JSON/undo summaries,
    concurrent create/reconcile, held compensation, Other/Mobile scope,
    and two sidepanel contexts racing one undo row.
    ```ts
    await Promise.all([
      panelA.getByRole("button", { name: "Undo", exact: true }).click(),
      panelB.getByRole("button", { name: "Undo", exact: true }).click(),
    ]);
    expect(await restoredBookmarkCount()).toBe(1);
    ```
    Implement `restoredBookmarkCount` in the dedicated audit helper using
    synthetic IDs/URL fixtures and guarded IndexedDB probes.
  - [ ] Confirm red evidence comes from behavior assertions, not browser
    launch, permission-prompt, or navigation failures.
  - [ ] Implement helpers using existing `startExtension`, `openSurface`,
    seed and DB conventions; inject controlled failures only in fresh test
    contexts and restore patched API methods during teardown.
  - [ ] Verify:
    `E2E_HEADLESS=1 npm run test:e2e -- tests/e2e/audit-data-safety.spec.ts`
    after build; run under Xvfb on Linux. Assert final state, uniqueness, and
    metadata values rather than only button visibility.
  - [ ] Coordinator gate/commit: `test(e2e): cover audit data integrity races`,
    notes/learnings, close this task.

- [ ] Task 3: Cross-feature browser privacy and provider-workflow regressions
  <!-- files: tests/e2e/audit-provider-workflows.spec.ts, tests/e2e/helpers/audit-provider.ts -->
  - Covers **I04/I08**, exercising **B05–B12/B14** plus bounded scan/UI
    behavior. Reuse wire-level Jev/LLM fake helpers and request valves.
  - [ ] Add regressions for blocked/mismatched summary zero-egress,
    minimized allowed payloads, bounded outputs, missing usage, revoke with
    a held response, held scan pause/resume, rapid decision Undo, and live
    Options configuration without reload. Include allowed positive controls.
    ```ts
    await blockSyntheticHost();
    await triggerSummary();
    expect(providerRequests()).toHaveLength(0);
    await allowSyntheticHostAndTriggerSummary();
    expect(providerRequests()).toHaveLength(2); // LLM + Jev verification
    expect(serializedProviderBodies()).not.toContain("audit_query_secret");
    ```
    Define helper functions in the dedicated audit provider helper, driving
    actual disclosed clicks and synthetic exact-origin fakes.
  - [ ] Verify original-failure evidence against the audited revision when
    needed; do not call a launch failure a reproduced application bug.
  - [ ] Implement typed wire responses and deterministic valves; use
    preinstalled permission patterns in a temporary manifest copy as the
    existing harness does. Disclose that this bypasses the native prompt.
    Record no real keys, URLs, excerpts, or user data.
  - [ ] Verify:
    `E2E_HEADLESS=1 npm run test:e2e -- tests/e2e/audit-provider-workflows.spec.ts`
    after build, plus existing provider/decisions/LLM specs. Drain held
    requests and dispose temporary profiles/extension copies.
  - [ ] Coordinator gate/commit: `test(e2e): cover audit provider workflows`,
    notes/learnings, close this task.

- [ ] Task 4: Correct documentation and align current workflow context
  <!-- files: README.md, conductor/workflow.md, conductor/tech-stack.md, conductor/patterns.md -->
  <!-- depends: task1, task2, task3 -->
  - Covers **I07/I08**. This is a documentation task; verify artifacts rather
    than fabricating a behavior red test.
  - [ ] Inspect `bd show BookmarksManager-gyx` and current regression
    evidence. Replace the stale unresolved-Options-drift claim with accurate
    browser prerequisites and known native-prompt limitations.
  - [ ] Update workflow/stack CI descriptions to match Task 1's actual
    triggers and release split; retain the general repository manual-phase
    policy outside this track's explicit override.
    ```sh
    npx playwright install chromium
    npm run build
    E2E_HEADLESS=1 npm run test:e2e
    ```
  - [ ] Promote verified reusable patterns for metadata rewrites,
    cross-context locks, reservation lifetime, single-owner jobs, bounded
    pair planning, and burst coalescing. Do not claim unrun live/prompt tests.
  - [ ] Check README commands against `package.json`, inspect the intended
    documentation diff, and run applicable store/site/config contract tests.
  - [ ] Coordinator commit: `docs: record audit hardening and verification limits`,
    notes/learnings, close this task.

- [ ] Task 5: Automated final checkpoint and implementation handoff
  <!-- files: -->
  <!-- depends: task1, task2, task3, task4 -->
  - [ ] Run the final gate after all code, tests, and documentation changes:
    ```sh
    npm run lint && npm run typecheck && npm run test -- --run &&
    npm run build && npm run check:manifest && npm run check:bundle &&
    npm run check:store && npm run check:site
    E2E_HEADLESS=1 npm run test:e2e
    ```
    Linux uses `xvfb-run -a npm run test:e2e` for the last command.
  - [ ] Run plan/spec coverage, metadata/Beads mapping, dependency cycle,
    ownership-conflict, and pending-task checks. Every B/I requirement has
    evidence; all tasks are verified before closure. Report skipped
    key-gated live/eval and native permission-prompt coverage explicitly.
  - [ ] Record exact commands/counts, meaningful warnings, and limitations;
    update learnings/patterns and Beads notes. Close the final checkpoint,
    Phase 6, and epic only after the full gate passes. Mark track completed
    and hand off local commit references without requesting manual checks
    or performing remote synchronization.

## Requirement Coverage

| Requirement | Primary task | Integrated verification |
|---|---|---|
| B01 | phase1_task1 | phase6_task2 |
| B02 | phase1_task2 | phase6_task2 |
| B03 | phase1_task3 | phase6_task2 |
| B04 | phase1_task4 | phase6_task2 |
| B05 | phase2_task1 | phase6_task3 |
| B06 | phase2_task2 | phase6_task3 |
| B07 | phase2_task3 | phase6_task3 |
| B08 | phase3_task1 | phase6_task3 |
| B09 | phase3_task2 | phase6_task3 |
| B10 | phase3_task3 | phase6_task3 |
| B11 | phase4_task1 | phase6_task3 |
| B12 | phase4_task3 | phase6_task3 |
| B13 | phase4_task2 | phase6_task2 |
| B14 | phase4_task5 | phase6_task3 |
| B15 | phase4_task4 | phase6_task2 |
| I01 | phase6_task1 | phase6_task5 |
| I02 | phase5_task1 | phase5_task6 |
| I03 | phase5_task2 | phase5_task6 |
| I04 | phase6_task2, phase6_task3 | every automated checkpoint |
| I05 | phase5_task3 (`BookmarksManager-f7c`) | phase5_task6 |
| I06 | phase5_task4 (`BookmarksManager-w6y`), phase5_task5 (`BookmarksManager-2qk`) | phase5_task6 |
| I07 | phase6_task4 | phase6_task5 |
| I08 | phase6_task2, phase6_task3, phase6_task4 | phase6_task5 |

## Beads Dependency Rules

- `metadata.json` maps all six phase containers and all 30 tasks.
- Preserve `parent-child` hierarchy, but do not rely on parenthood alone to
  block ready work. Every phase after Phase 1 depends on the previous phase;
  its root tasks also depend directly on that previous phase container.
- Sequential phases have consecutive task blockers. Parallel phases have
  only explicit task blockers; checkpoints depend on all preceding tasks.
- Phase 1 Task 2 follows Task 1 because both own restore/undo tests.
- Phase 5 Task 5 follows Tasks 3/4 because it shares background ownership
  with Task 3 and consumes Task 4's bounded planner.
- Phase 6 Task 4 follows Tasks 1/2/3; the final checkpoint follows all four.
- Reparent the three unparented canonical backlog issues into Phase 5,
  preserve original context/priorities/history, and append track ownership,
  acceptance, and dependencies. Do not create duplicates or close them
  during planning.
- No issue is claimed or marked implementation-in-progress by new-track
  creation. The initial ready implementation set is Phase 1 Tasks 1/3/4.
