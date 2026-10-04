# Deep Audit Fixes

## Overview

Resolve every finding from the 2026-10-04 whole-codebase audit (four read-only
slice audits: security/privacy, data integrity, decisions/jobs, UI) without
rewriting the extension. Native Chrome bookmarks stay authoritative. Core
features stay offline; optional AI stays consent-gated and exact-origin scoped.
Where the code and the README/consent claims disagree, **the code is changed to
honor the claim** (user decision, 2026-10-05), not the claim to match the code.

- **Type:** bug/hardening.
- **Priority:** High (P1).
- **Execution:** seven sequential phases; task-level parallelism only where
  tasks are file-disjoint (annotated in `plan.md`).
- **Verification:** automated gates only (user decision, 2026-10-05). Same
  override as `audit_hardening_20261001`: no manual wait at phase boundaries or
  at track completion; automated task, phase and final gates stay mandatory.
- **Track dependencies:** none (all earlier tracks archived).
- **Estimate:** unset.

## Audit Baseline

Observed on 2026-10-04 before any change: `npm run typecheck`, `npm run lint`,
`npx vitest run` (159 files / 2395 tests), `npm run build`, `check:manifest`,
`check:bundle` and `npm audit --omit=dev` all passed. Playwright e2e was not
run in the audit. Findings are static-analysis results from four slice audits;
four were additionally confirmed by direct code reads (P01, P02, A01, D04).
Every other finding is **unreproduced**.

**Verify-first rule:** `audit_hardening_20261001` already changed several of
these areas (undo serialization, blocklist on explain/summary, job ownership,
reservation settlement). Every task therefore begins with a failing regression
test against current code. If the test cannot be made to fail, record the
evidence in `learnings.md`, drop the behavior change for that item, and keep
the test only if it guards a plausible consumer-visible regression.

## Functional Requirements

Line references are from the audited baseline and will move.

### Phase 1 — Privacy and consent enforcement

| ID | Requirement |
|---|---|
| P01 | `readBlocklist()` must distinguish *unset* (`[]`) from *unreadable/malformed*. On an IndexedDB error or a non-array row, senders and the egress gate refuse the send with a typed error rather than treating the blocklist as empty. `src/decisions/blocklist.ts:21-30`, `src/net/send.ts` re-check. |
| P02 | `startRestructure` passes the persisted user blocklist to `buildLibrarySynopsis`; blocklisted hosts contribute no domain, title, tag/category count or folder path to the proposal prompt. `src/messages/restructure.ts:283`, `src/restructure/synopsis.ts`. |
| P03 | Add per-scope closed payload guards: the LLM gate parses a closed per-scope payload (no free-form notes/page text where the scope does not allow it) and re-runs `isSensitiveUrl`/blocklist; the Jev gate whitelists `questions[*]` instead of checking only `model` and `state`. `fetchImpl` becomes test-only (separate internal entry point). `src/net/llm-send.ts`, `src/net/send.ts`. |
| P04 | `llm_explain` and `llm_restructure` get a rendered disclosure (recipient, destination, fields, trigger, purpose) and an affirmative consent action. Their handlers refuse when exact-origin consent is absent and **never write the grant themselves**. Consent versions bump where disclosure text changes. `src/messages/llm-features.ts:356`, `src/messages/restructure.ts:287`, `RestructureView.tsx`, explain UI. |
| P05 | The popup's `SAVE_SUGGEST` request is sent only after an explicit user action (focus on the tags field or a "Suggest" control), never on open. `src/entrypoints/popup/App.tsx`. |
| P06 | The worker never starts provider egress on browser/worker startup. Jobs found `running` at cold start are moved to `paused` and need an explicit Resume click. (Worker eviction within a session is handled in J03 and is not a cold start.) `src/entrypoints/background.ts:584-590`. |
| P07 | The "Data sent" log writes a row **per attempt** at dispatch, with an outcome field (`ok`, `retried`, `timeout`, `redirect`, `transport`, `http_<status>`), including attempts that fail, time out or are redirected. `src/net/llm-send.ts`, `src/net/send.ts`. |
| P08 | Extraction identity: the injected script returns `location.href` and document identity; the worker re-verifies it against the bookmark and blocklist after injection and rejects on mismatch. In-page size caps: `maxElemsToParse`, `charThreshold`, truncated headings/description/excerpt, `.max()` limits in the schema. `src/extract/page.ts`, `src/extract/readability.ts`, `src/entrypoints/extract.ts`, `src/decisions/summaries.ts`. |
| P09 | Minimization strips path matrix params (`;jsessionid=…`) and replaces opaque high-entropy path segments (≥ 32 chars of `[A-Za-z0-9_-]`) with a fixed placeholder before egress. Disclosure text states that the path is sent. Local identity matching is unchanged. `src/decisions/minimize.ts`, `src/schemas/decision-state.ts`. |

### Phase 2 — Accounting and egress robustness

| ID | Requirement |
|---|---|
| A01 | The LLM gate classifies `TimeoutError` as a timeout, does **not** retry it, and distinguishes user abort from timeout via `signal.reason`. `src/net/llm-send.ts:199-205,460-482`. |
| A02 | `Retry-After` HTTP-date form parses correctly; transport and 429 retries use jittered exponential backoff by reusing `src/jev/retry.ts`. |
| A03 | Reservations cannot be orphaned: a failing `appendSentLog`/`settleLlmUsage` cannot leave a row `active`; at worker start `active` rows older than the maximum request timeout are settled as unknown-cost per the existing conservative rule. |
| A04 | `sendLlmConsented` estimates prompt tokens and reserves `max(declared, estimate)` (or refuses over the declared bound). |
| A05 | Pre-response provider rejections of a capability probe (4xx on `json_schema` tier) carry an explicit "not billed" provenance and are excluded from the cap; timeouts, 5xx and non-JSON 200s keep conservative billing. Also reuse `BookmarksManager-eov`: record usage for responses that egressed but fail the answer cross-check. |
| A06 | Success response bodies are read through a size-capped reader before `JSON.parse` (Jev and LLM); response schemas gain `.max()` limits; unread bodies are cancelled. `src/jev/client.ts`, `src/llm/client.ts`. |
| A07 | `JOB_START`/`RESTRUCTURE_START` reject when a non-terminal job of the same kind exists, cap id count, and show a pre-run estimate. The README states exactly which paths the monthly USD cap covers. `src/entrypoints/background.ts:457-482`. |
| A08 | Retention and indexed reads: roll `usage`/`llmUsage` into per-month rows; prune settled/released reservations outside the cap window; cap `audit`, `jobs` and non-popup `decisions`; budget transaction queries only the current month through an index; `prunePopupDecisions` avoids full-table reads; Options "Data sent" reads lazily. Additive Dexie version bump only. `src/db/database.ts`, `src/net/llm-send.ts`, `src/decisions/store.ts`, `src/jobs/queue.ts`, `src/entrypoints/options/SentLog.tsx`. |

### Phase 3 — Jobs and decisions resilience

| ID | Requirement |
|---|---|
| J01 | A per-bookmark failure is recorded and skipped or retried; `failed` jobs can resume from `committedBatches`; restructure apply may use partial assignments. |
| J02 | Resume tolerates deleted ids (filter to live ids, recompute batches); an empty work set ends terminal, never an immortal `running`; unexpected errors in `runPersistedJob` set `failed` with a redacted code; a watchdog re-drives jobs with stale `updatedAt` and no live owner. |
| J03 | A keepalive (`chrome.alarms`, new `alarms` permission) keeps a job started **this session** alive and resumes it after worker eviction; in-worker sleeps are capped below the idle limit. Session marker lives in `chrome.storage.session`; cold start follows P06. |
| J04 | Decision persistence is idempotent per `(jobId, bookmarkId, kind)` with a deterministic id; re-analysis supersedes older pending rows for the same bookmark and kind. |
| J05 | The staleness guard is captured from the snapshot that was **sent** (parent, url, title), not at persist time; `stale`/`bookmark_gone` in the job path skips the item instead of failing the job; `assertFresh` covers url/title for add_tags, set_category and merge. |
| J06 | `approveDecision` has per-decision mutual exclusion (in-worker map plus conditional claim in the store); concurrent approvals and approve-vs-reject are safe; failure paths compensate consistently. |
| J07 | Near-duplicate decisions at level < 3 are not persisted as approvable; out-of-range confidence is treated as `unsure` instead of throwing `RangeError`. |
| J08 | `maybeEscalateDecision` rethrows job-authority errors; budget-skipped second opinions surface a visible indicator. |
| J09 | Job-level circuit breaker with delayed resume on 429/5xx; Pause is honored per item. |
| J10 | Restructure apply is idempotent: persisted `appliedAt`/terminal state, serialized apply, no empty-effect snapshot when `moved === 0`. |
| J11 | `RESTRUCTURE_UNDO` requires `snapshotId` and uses `undoExpected`. |
| J12 | Restructure diff pre-filters managed/root-adjacent bookmarks as unresolved and skips them; reuse `BookmarksManager-2v9`. |
| J13 | Restructure assignments are merged once per batch (or live in their own table keyed `(jobId, bookmarkId)`); `latestRestructureJob` uses an index. |
| J14 | `setBookmarkSummary` re-admits the bookmark before persisting; decisions for deleted bookmarks are cleaned (cascade). |

### Phase 4 — Duplicates, undo and data integrity

| ID | Requirement |
|---|---|
| D01 | `normalizeUrl` stops conflating distinct pages: keep route-like fragments (`#/`, `#!`), limit `ref` stripping to known hosts, keep `http`/`https` distinct for merge. "Normalized" duplicate groups are suggestions only. `src/duplicates/normalize.ts`, `group.ts`, `src/io/import-plan.ts`. |
| D02 | `mergeGroup` re-reads every member and rejects or drops one whose live URL no longer matches the kept node's key. |
| D03 | `mergeGroup` validates merged notes against the 10,000-character cap before pushing the snapshot, writes survivor meta only after removals succeed, and discards its snapshot on failure when nothing was removed; retry never double-appends notes. |
| D04 | `mergeGroup` returns the `snapshotId` it pushed; `applyMerge` stops using `peekLatest()`. `src/decisions/apply.ts:332`. |
| D05 | Undo retention is per origin (user vs decision); rows referenced by live decisions are not evicted; a byte/node bound is added. |
| D06 | `peekLatest` reads only the newest valid row (reverse cursor) instead of loading and validating all 20. |
| D07 | The toast Undo and palette "Undo last action" carry and use the `snapshotId` (`restoreById`/`undoExpected`). |
| D08 | Large-subtree restore is O(n): `getChildren` once per folder, batched `idMap` persistence, no per-node ancestor re-walk. `src/undo/restore.ts`. |
| D09 | Merge undo merges survivor meta instead of replacing; `bulk_move` undo skips a node whose parent changed since the move. |
| D10 | `deleteTagWithUndo` captures and deletes in one Dexie transaction; failure discards its snapshot. |
| D11 | `withUndoLock` nesting uses an explicit held token instead of the module-global `holdDepth`. |
| D12 | Orphaned meta is kept in a bounded tombstone table (URL-keyed, 30-day retention) and re-attached when a bookmark with the same URL reappears; undo's `nodeExists` check also verifies URL. `src/sync/listeners.ts`, `reconcile.ts`, `src/undo/restore.ts`, `src/db/database.ts`. |
| D13 | Rows carry a `schemaVersion`; rows failing Zod are counted and surfaced; an unparseable row is not overwritten without keeping a copy. `src/db/meta.ts`, `src/db/database.ts`. |
| D14 | The omnibox index is built lazily and cached for the worker lifetime (invalidated on bookmark/meta events, notes excluded); `group.ts` indexes exact groups; the unused `bookmarks-changed` broadcast is removed. |
| D15 | `isOpenableUrl` uses one shared scheme policy with `isBlockedScheme`: strip all C0 controls, allowlist `http`, `https`, `mailto`, `ftp`. |

### Phase 5 — Import and export

| ID | Requirement |
|---|---|
| I01 | Import is resumable: `importRootId` and a cursor are written to Dexie before the first write; progress is reported; Cancel works; reopening offers Resume. `src/io/import-write.ts`. |
| I02 | The import dialog cannot be closed or restarted while importing; late results from a reset run are ignored; `handleConfirm` has a synchronous re-entrancy guard. `ImportDialog.tsx`. |
| I03 | CSV/Netscape tags get a `TagDef` per distinct key; over-long tags are truncated or skipped individually instead of failing the whole meta row. |
| I04 | A duplicate skipped on import merges the file's tags/category (and notes when empty) into the existing bookmark, and skipped URLs appear in the preview. |
| I05 | CSV: strip a single leading `'` on import only when followed by a formula trigger; recover from or report swallowed rows after an unmatched `"`; escape `/` and `;` in folder/tag text. |
| I06 | `buildExport` flattens over-deep subtrees with a warning instead of failing with `invalid_envelope`. |
| I07 | `revokeObjectURL` is delayed; exports gain an "Include notes" checkbox (default on for JSON backup, off for CSV/HTML). |

### Phase 6 — UI correctness and safety

| ID | Requirement |
|---|---|
| U01 | "Approve all (N)" shows count and kinds, then applies under one aggregate snapshot (or batch revert) with an Undo toast. |
| U02 | Bulk Analyze routes through the job queue with a cost estimate, Pause/Cancel and a maximum selection size. `BulkBar.tsx`. |
| U03 | `RestructureView`: "Yes, apply" is disabled in flight (sync ref guard); polling uses a ref-based interval with serialized refreshes; poll runs in `starting`; `selectedIds` is keyed by job id. |
| U04 | `BookmarkList`: key events from the context menu do not reach the list handler; Delete has a re-entrancy guard and ignores key repeat. |
| U05 | dnd same-parent forward multi-moves compute the index against the post-removal list. |
| U06 | Quick save runs as one worker `SAVE` message (create + meta); popup suggestion rows use an indexed query; `openSidePanel`/open failures are surfaced. |
| U07 | `EditDialog` patches only changed fields via tag add/remove deltas; the pending-edit handoff consumes its key only after the entry resolves; the duplicates banner Undo calls the real undo and reflects its result. |
| U08 | `SummaryDialog` is rebuilt on the shared Dialog (focus trap, theme tokens); Close while running cancels or is labeled "continue in background". |
| U09 | Options: blocklist/settings writes are field-level patch messages; a permission granted after a preset switch is removed or completes the enable; `LlmBudget` refreshes live, clears stale errors and validates the cap with a decimal pattern. |
| U10 | A top-level `ErrorBoundary` with Reload per entrypoint plus a global `unhandledrejection` handler. |
| U11 | `TagManager` queries mount only while open; tree refresh is throttled while writes are in flight. |

### Phase 7 — Provider hardening and documentation

| ID | Requirement |
|---|---|
| H01 | A failed re-enable or re-configure of a working provider restores its previous credential, settings and consent; re-configure preserves `monthlyBudgetUsd` and pricing. `unwindEnable`, `unwindConfigure`. |
| H02 | API keys are trimmed and validated (`/^[\x21-\x7e]+$/`) at the message boundary; `saveProviderKey` and envelope save/delete are serialized per material id. Reuse `BookmarksManager-7k4`. |
| H03 | The ESLint egress ban covers `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `importScripts`. Reuse `BookmarksManager-bih`. |
| H04 | Options warns when a custom provider host is non-public (reuse `isNonPublicUrl`); the endpoint stays allowed. |
| H05 | Prompt-injection mitigations: the source domain is shown next to auto-applied changes; restructure folder names are length-limited and sanitized; persisted summaries strip URLs/markdown. |
| H06 | Documentation matches shipped behavior: README, `store/*.md`, `store/permissions.md` (`alarms`), privacy policy, consent versions, disclosure text, `conductor/{tech-stack,patterns}.md`; the credential claim describes the real boundary (worker convention, non-extractable key in IndexedDB). |
| H07 | Final gate and regression sweep (see Acceptance Criteria). |

## Technical Approach

- Extend existing modules and tests; no new state framework, provider
  abstraction or bookmark store.
- Gate enforcement lives in `src/net/**`; callers keep minimizing, but the gate
  is the last line and fails closed.
- Dexie changes are additive (new version, new indexes/tables); no destructive
  migration. Old rows keep working.
- Jobs: single owner per job stays; add per-item outcome, idempotent decision
  ids, session marker plus alarm keepalive, cold-start pause.
- Undo: ids travel with the UI action; global LIFO stays but retention and
  targeting become origin-aware.
- Reuse `BookmarksManager-2v9`, `-eov`, `-7k4`, `-bih` (preserve their history,
  append this track's design/acceptance context).

## Non-Functional Requirements

1. Native `chrome.bookmarks` remains the tree authority. Preserve fixed-root,
   managed-node, URL-scheme, undo and metadata compatibility guards.
2. Notes, raw URL secrets, full DOMs, credentials and user data must not enter
   outbound bodies, logs, errors, issue text or fixtures.
3. All provider sends stay under `src/net/**` with current exact-origin consent
   and host permission checks. The only new permission is `alarms` (J03), and
   only with `store/permissions.md` justification and passing
   `check:manifest`. No new static content scripts, default egress, analytics
   or remote code.
4. Strict TypeScript; Zod only via `src/schemas/z.ts`; message handlers stay
   total (`{ok:true}|{ok:false,code,message}`).
5. TDD for behavior changes using deferred promises, synthetic public-looking
   domains, fake IndexedDB/bookmarks, fake clocks and wire-level provider
   responses. Keep the 10k-corpus analyze-on-save worst-of-10 < 1.5 s gate.
6. Preserve untracked/uncommitted user work, especially
   `.beads/.auto-import-issues.jsonl`. Fresh browser profiles only; never real
   provider keys.
7. Phases are sequential. Parallel tasks need disjoint file ownership or an
   explicit dependency. One coordinator owns track files, Beads, commits and
   git notes.
8. No manual verification gates; every phase ends with an automated checkpoint.
   Browser launch failures are reported separately from application failures.
9. Never automatically `git push`, `git pull`, `git fetch` or `bd dolt push`.

## Acceptance Criteria

- Every item above has a permanent regression that fails on the audited
  behavior and passes with the fix, **or** a recorded note in `learnings.md`
  showing the behavior no longer reproduces (verify-first rule).
- P01/P02/P03/P04: with a throwing or malformed blocklist read, a blocklisted
  host, or missing per-scope consent, the provider receives zero requests;
  allowed inputs succeed; no payload contains a notes marker.
- P05/P06: opening the popup and cold-starting the worker with a `running` job
  produce zero provider requests (wire-level fake endpoint).
- P07: a 503-then-200 provider produces two sent-log rows; a timeout and a
  redirect each produce one.
- A01: a hung provider yields `timeout`, one reservation, one request.
- A03/A08: a killed worker mid-request leaves no permanent `active`
  reservation after the next start; table sizes stay within the retention caps;
  the budget transaction reads only current-month rows.
- J01–J14: scans survive one failing item, a deleted bookmark and worker
  eviction; replayed batches create no duplicate decisions; double approve and
  double restructure confirm apply once.
- D01–D15: distinct SPA/`?ref=` URLs are not grouped for merge or dropped on
  import; merge of stale or oversize-notes groups is refused or safe; undo
  targets the displayed action; a 5k-node folder restore completes in linear
  time on the fake.
- I01–I07: an interrupted import resumes; CSV/Netscape tags appear in the tag
  manager; a CSV export→import round trip preserves titles beginning with
  `=+-@`.
- U01–U11: Approve-all is confirmed and undoable; bulk Analyze is cancellable;
  context-menu Delete cannot delete the selection; render errors show a
  recoverable fallback.
- H01–H07: failed reconfigure leaves the previous provider usable; keys with
  whitespace are normalized or rejected with a clear message; docs, store files
  and consent versions match behavior.
- Final gate passes: `npm run lint`, `npm run typecheck`,
  `npm run test -- --run`, `npm run build`, `npm run check:manifest`,
  `npm run check:bundle`, `npm run check:store`, `npm run check:site`, and
  isolated `npm run test:e2e` with Playwright Chromium installed (macOS may use
  `E2E_HEADLESS=1`). Record exact commands and pass/fail/skip counts; do not
  claim key-gated (`test:live`, `test:eval`) or native-permission-prompt
  coverage.

## Out of Scope

Filed as separate P3 Beads at track creation rather than done here:

- **Active Jev provider pointer** (`readActiveJevProvider` picks the first
  configured provider) and its Options UI. The consent and gate fixes above
  still apply per exact origin.
- **`navigator.storage.persist()`, auto-backup or backup reminder** for
  IndexedDB-only notes/tags.
- **Applied/History view** exposing `REVERT_DECISION` for applied rows (U01's
  aggregate undo covers bulk approve; a general history view is a feature).
- **`add_tags` per-tag confidence policy** (one weak tag lowers a whole
  decision to `unsure`). Changing it alters pinned release policy and requires
  re-running the eval corpus; not a bug fix.

Also out of scope: UI redesign, new providers, new dependencies, releasing or
re-zipping the store package, public store submission, live/paid provider
requests, remote Git/Dolt synchronization, retroactive recovery of data already
lost, and implementing any fix while creating this planning track.
