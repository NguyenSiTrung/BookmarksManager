# Track Learnings: phase3_jev_client_20260927

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list in `conductor/patterns.md`. The phase0 connection-slice learnings are already elevated there;
the ones most relevant to this track:

- `fetch` is ESLint-banned in `src/**` except `src/net/**` (tests are outside the ban, so a Node mock server may use `fetch`).
- Fail-closed gates re-verify per call; prove short-circuiting with dependency-spy call counts (key store untouched on earlier refusals).
- Never read a response body on non-2xx. Omit `cause` when it can hold response content (SyntaxError snippets, ZodError `input`).
- Message handlers are total `{ok:true,…} | {ok:false,code,message}` Zod unions; two `ok: true` shapes need `z.union`, not `discriminatedUnion`.
- All Zod through `src/schemas/z.ts` (jitless); Zod 4 refines still run after a failed base check — guard throwing ops.
- `vi.mock(path, async (importOriginal) => ({ ...actual, dep: vi.fn() }))` keeps real error classes for `instanceof` assertions.
- `chrome.permissions.request` needs a synchronous user gesture; trusted-page check uses `sender.url`.
- RTL here: `globals: false` → set `IS_REACT_ACT_ENVIRONMENT`, call `cleanup()` manually; no jest-dom.
- Playwright: `channel: "chromium"`; extension pages drive `chrome.*` via `page.evaluate`; egress assertions filter out internal schemes and assert after `context.close()`.
- Store disclosures must match `consent/disclosure.ts` constants nearly verbatim; data-flow changes need `CONSENT_VERSION` + `store/` updates in the same change (not expected in this track).

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-27 03:22] - Phase 1 Task 2: Noul margin and answer confidence
- **Implemented:** `src/jev/confidence.ts` — `noulMargin(p, t=0.5)` per §10.1 `(p−t)/(1−t)` / `(t−p)/t` with RangeError bounds (0≤p≤1, 0<t<1, NaN rejected); `answerConfidence` uses `answer.confidence` for choice/score.
- **Files changed:** `src/jev/confidence.ts`, `tests/unit/jev-confidence.test.ts` (18 tests)
- **Commit:** `4216692` (landed from worktree `wt/p3-p1t2`, worker commit `677a7fa`)
- **Learnings:**
  - Patterns: pure `src/jev/` modules take `import type { Answer } from "./wire"` only — no chrome/DOM/fetch.
  - Context: `answerConfidence` deliberately does NOT validate `threshold` for choice/score answers — the field is returned verbatim per spec; noul invalid-t propagates RangeError.
---

## [2026-09-27 03:26] - Phase 1 Task 3: Retry policy and usage meter
- **Implemented:** `src/jev/retry.ts` (`RetryableFailure` structural classification, `isRetryable`, `parseRetryAfter`, `retryDelay` full-jitter honoring retry-after capped at `DEFAULT_MAX_DELAY_MS`) and `src/jev/usage.ts` (`UsageMeter` — token/cost sums, unique model list; `costUsd` undefined when nothing reported, `costComplete` tracks all-reported).
- **Files changed:** `src/jev/retry.ts`, `src/jev/usage.ts`, `tests/unit/jev-retry.test.ts` (20), `tests/unit/jev-usage.test.ts` (8)
- **Commit:** `181543d` (landed from worktree `wt/p3-p1t3`, worker commit `0d0864e`)
- **Learnings:**
  - Gotchas: `Date.parse` leniently parses `"1.5"`, `"-5"`, `"+3"` as year-2001 dates — `parseRetryAfter` requires a letter before trying the HTTP-date branch or garbage silently becomes 0 ms.
  - Patterns: `permanent: true` wins over any retryable signal in `isRetryable` (a 503 carrying an invalid-response verdict is not retried); `retry.ts`/`usage.ts` are import-free — client maps its own errors onto `RetryableFailure`, keeping `src/jev` decoupled from `src/net`.
---

## [2026-09-27 03:29] - Phase 1 Task 1: Pre-send guards and batch planner
- **Implemented:** `src/jev/budget.ts` — `estimateTokens` (JSON chars/4 × 1.25), `checkGuards` (typed `BudgetError`: `invalid_request` for empty/duplicate keys, non-record questions, choice <2/>255 options, score <2/>10 levels), `planBatches` (32k per-question `too_large`, greedy key-order packing ≤64k, empty questions → `[]`).
- **Files changed:** `src/jev/budget.ts`, `tests/unit/jev-budget.test.ts` (37 tests)
- **Commit:** `a0051ab` (landed from worktree `wt/p3-p1t1`, worker commit `5da1ace`)
- **Learnings:**
  - Patterns: BudgetError messages may name question *keys* (developer-chosen field names) but never instructions/criteria/state — those can carry bookmark content.
  - Gotchas: `checkGuards` is total on un-parsed input (non-record questions/question values) — typed BudgetError, never raw ZodError/TypeError, since it's called before/without `SystemOneRequest.parse`.
---

## [2026-09-27 03:29] - Phase 1 Task 4: Mock Jev HTTP server
- **Implemented:** `tests/mock-servers/jev.ts` — `startMockJevServer()` on 127.0.0.1:ephemeral; `POST /v1/systemone` + `/api/v1/systemone`; deterministic same-type default answers; FIFO `queue`/`setHandler` scripting (statuses, retry-after, delay, hang, malformed, omit/override answers, OpenRouter extras, model override); records every request; `close()` destroys sockets so hangs can't wedge it.
- **Files changed:** `tests/mock-servers/jev.ts`, `tests/unit/mock-jev-server.test.ts` (29 tests)
- **Commit:** `b61fee5` (landed from worktree `wt/p3-p1t4`, worker commit `5e7a7ca`)
- **Learnings:**
  - Context: mock default answers are deterministic (noul 0.9, choice first-key 0.75 confidence, score middle-level) so downstream tests assert stable values; `input_tokens` estimated from rawBody length.
  - Gotchas: only valid POST calls consume the scripted queue (404s don't); `close()` is idempotent via `closeAllConnections()` + timer sweep.
---

## [2026-09-27 03:32] - Phase 1 Task 5: Automated checkpoint — FULL GATE GREEN
- **Gate evidence:** `npm run lint` 0 errors (1 known `react-hooks/incompatible-library` warning on the TanStack virtualizer call) · `npm run typecheck` clean · `npx vitest run` **66 files / 1703 tests, all pass** (+112 vs Phase 2 baseline 1591) · `npm run build` 1.08 MB · `check:manifest` OK · `check:bundle` OK · `xvfb-run -a npm run test:e2e` **11/11 pass**.
- **Parallel execution notes:** 4 workers in `.worktrees/p3-p1t{1..4}` on `wt/p3-p1tN` branches with `cp -al` hardlinked `node_modules`/`.wxt`; disjoint file sets meant clean cherry-picks; coordinator (this session) serialized commits, notes, plan markers, and all `bd` updates.
---

## Phase 2 — Task 1: Scoped consent gate

- `sendConsented(scope, preset, model, request, {signal})` gate order: scope registry → preset → model
  allowlist → HTTPS/origin → per-scope `admits(request, model)` guard → wire-schema parse → consent →
  permission → key → fetch. `SCOPE_REGISTRY` is a frozen `ReadonlyMap`; `jev_test` admits only requests
  structurally equal to `makeSyntheticRequest(model)` (key-order-insensitive deep equal, values must match).
- Abort handling has three observably different checkpoints: pre-aborted signal → `timeout` before any
  fetch; abort during the gate's async consent/permission/key reads → `timeout`, fetch never called; abort
  mid-flight → `timeout` after fetch was invoked. `sentLog` is written only when `fetch` resolves (incl.
  HTTP errors) — a real "bytes left" boundary, not "fetch was called".
- Testing mid-flight abort: an immediate `controller.abort()` fires while the gate is still in async DB
  reads, so `fetchSpy` stays at 0. Use `vi.waitFor` until fetch is invoked, then abort — otherwise the test
  conflates pre-flight and in-flight abort.
- Adding gate error codes ripples typecheck failures into `src/messages/provider.ts`: `ProviderErrorCode`
  is the crossing-boundary union and must enumerate every code the gate can emit, even if a later task
  handles UX copy.
- `hasConsent`/`grantConsent`/`revokeConsent` take `(scope, preset)`; the old `*TestConsent` wrappers are
  one-line forwarders — kept for existing call sites and tests.

## Phase 2 — Task 2: Hardened Jev client

- `createJevClient` composes `SystemOneRequest.safeParse` → model-equality check (`request.model` must
  equal the configured client model, else `invalid_request`) → `planBatches` → per-batch send with retry
  → `SystemOneResponse` + per-batch cross-check → merge. `BudgetError` codes relay verbatim (`too_large`,
  `invalid_request`).
- Error-code mapping on exhaustion: retryable HTTP status → `retry_later`; timeout → `timeout`; gate
  `transport` → `transport`. Gate refusals relay their code (`no_consent`, …) and are never retried;
  non-gate throws (e.g. `ProviderKeyError`) propagate unwrapped — same convention as `connection.ts`.
- Per-preset concurrency is a module-level `Map<PresetId, {running, limit, queue}>` counting semaphore;
  the first client created for a preset fixes the shared limit. Export a `resetJevClientPools()` test
  hook or cross-test leakage makes limits sticky.
- Response inspection returns a discriminated `SendOutcome` union (`{ok}`) rather than
  `T | Failure` — `instanceof` does not work on interfaces and `in`-narrowing across a union was
  brittle under `noUncheckedIndexedAccess`; the nominal union keeps TS honest.
- Each send attempt gets its own `AbortController` + `setTimeout(timeoutMs)`; `controller.signal.aborted`
  in the catch distinguishes our timeout (retryable `timeout`) from transport errors. The signal is
  forwarded to the transport so the gate/fetch actually aborts.
- To split a request into N batches under the 64k-token cap: questions of ~15.6k tokens each
  (~50k chars of JSON at 4 chars/token × 1.25 margin) pack 4 per batch; `4*N - (N-1)` questions
  yield exactly N batches. Deterministic without runtime probing.
- `vi.fn<JevTransport>` with an unused trailing param trips `no-unused-vars` — drop the underscore
  param entirely rather than naming it `_options` (the lint rule counts leading-underscore args too).
