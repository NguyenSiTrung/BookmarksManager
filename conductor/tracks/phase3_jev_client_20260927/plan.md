# Phase 3 Jev Client — Implementation Plan

**Goal:** Finish PROJECT_PLAN.md §15 Phase 3: a scoped consent gate, a hardened Jev client (guards, split/merge,
retries, concurrency, usage), the §8.4 typed question builder with §10.1 confidence, an HTTP mock Jev server,
the §8.5 Options completion, e2e Test connection, and a live smoke script.

**Spec:** `conductor/tracks/phase3_jev_client_20260927/spec.md`.

## Global Constraints

- Data flow unchanged: only scope `jev_test`, only the synthetic request, `CONSENT_VERSION` stays 1, no new
  permissions, `store/` stays data-flow neutral.
- `fetch` only in `src/net/**`; `z` only from `src/schemas/z.ts`; handlers total; error messages redacted
  (never read bodies on non-2xx; no `cause` that can hold response content).
- `budget.ts`, `retry.ts`, `usage.ts`, `confidence.ts`, `define.ts` stay pure (no `chrome`/DOM/React).
- Per task: failing test → implement → narrow checks → update plan + `learnings.md` → commit intended files
  locally → `git notes add -m "…"` → close the mapped Beads task. Never push, pull, fetch, or `bd dolt push`.
- Phase-end tasks are **automated checkpoints** (full gate: `lint` → `typecheck` → `test -- --run` → `build`
  → `check:manifest` → `check:bundle` → `xvfb-run -a npm run test:e2e`), evidence in `learnings.md`, marked
  complete on green. The **only user verification is the last task of the track.**
- Parallel workers own only their annotated files in isolated worktrees; the coordinator serializes shared
  files (`package.json`, `package-lock.json`, `src/messages/provider.ts`, `plan.md`, `learnings.md`,
  `PROJECT_PLAN.md`, `conductor/*.md`), Beads status, and commits/notes.
- `PROJECT_PLAN.md` and `tests/e2e/search.spec.ts` carry pre-existing uncommitted user edits — never
  overwrite or commit them without asking.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Guards / batches | `src/jev/budget.ts` | Token estimate, option/level/key guards, `planBatches` |
| Confidence | `src/jev/confidence.ts` | `noulMargin`, `answerConfidence` |
| Retry / usage | `src/jev/retry.ts`, `src/jev/usage.ts` | Backoff + jitter, `retry-after` parse, retryable classification; `UsageMeter` |
| Gate | `src/net/send.ts`, `src/consent/records.ts` | Scoped `sendConsented`, scope registry, signal/timeout |
| Client | `src/jev/client.ts` | `createJevClient().run()`: validate → plan → send → cross-check → merge |
| Builder | `src/jev/define.ts` | `defineDecision`, `noul`/`choice`/`score`, `build`, typed `run` |
| Connection | `src/jev/connection.ts`, `src/messages/provider.ts`, `src/entrypoints/options/ProviderSetup.tsx` | Test connection via client; `timeout` code |
| Options info | `src/net/provider-info.ts`, `src/entrypoints/options/ProviderSetup.tsx` | Alias warning, data notes, policy links |
| Test infra | `tests/mock-servers/jev.ts`, `tests/e2e/provider.spec.ts`, `tests/live/*`, `vitest.live.config.ts` | Mock HTTP Jev, e2e, live smoke |

---

## Phase 1: Pure foundations
<!-- execution: parallel -->
<!-- depends: -->

- [x] Task 1: Pre-send guards and batch planner
  <!-- files: src/jev/budget.ts, tests/unit/jev-budget.test.ts -->
  - [x] Failing tests: token estimate formula; 1/2/255/256 options; 1/2/10/11 levels; empty/duplicate keys;
        32k per-question boundary → `too_large`; greedy key-order packing under 64k; batches cover every
        question exactly once; single-batch fast path
  - [x] Implement

- [x] Task 2: Noul margin and answer confidence
  <!-- files: src/jev/confidence.ts, tests/unit/jev-confidence.test.ts -->
  - [x] Failing tests: §10.1 formula at p = 0, t, 1 and custom t; invalid p/t rejected; choice/score use
        returned `confidence`
  - [x] Implement

- [x] Task 3: Retry policy and usage meter
  <!-- files: src/jev/retry.ts, src/jev/usage.ts, tests/unit/jev-retry.test.ts, tests/unit/jev-usage.test.ts -->
  - [x] Failing tests: retryable set (429/529/5xx/timeout/transport) vs not (401/422/4xx/invalid/gate);
        full-jitter bounds with injected `random`; `retry-after` delta-seconds, HTTP-date, garbage, cap;
        `UsageMeter` sums tokens, sums cost only when reported, records models
  - [x] Implement

- [x] Task 4: Mock Jev HTTP server
  <!-- files: tests/mock-servers/jev.ts, tests/unit/mock-jev-server.test.ts -->
  - [x] Failing self-tests: default answers per question type validate against `SystemOneResponse`;
        scripted 401/422/429+retry-after/529/5xx/delay/malformed/missing/mismatched/OpenRouter extras/
        varying model; request recording; both endpoint paths; binds 127.0.0.1 on an ephemeral port
  - [x] Implement

- [x] Task 5: Phase 1 automated checkpoint — full gate green, evidence in `learnings.md`

## Phase 2: Scoped gate and hardened client
<!-- execution: sequential -->
<!-- depends: phase1 -->

- [x] Task 1: Scoped consent gate
  <!-- files: src/net/send.ts, src/consent/records.ts, tests/unit/network-gate.test.ts, tests/unit/consent.test.ts -->
  - [x] Failing tests: unknown scope → `unregistered_scope`, non-synthetic `jev_test` request →
        `request_not_allowed`, both before key/permission reads (spy counts); `hasConsent(scope, preset)`
        scope/origin/version checks; signal abort → `timeout` with no sentLog row; existing
        `sendConsentedTest`/`*TestConsent` wrappers unchanged
  - [x] Implement

- [x] Task 2: Hardened Jev client
  <!-- files: src/jev/client.ts, tests/unit/jev-client.test.ts -->
  - [x] Failing tests (injected transport + mock server): parse/guard failures send nothing; split/merge
        exactness; cross-check → `answer_mismatch` (missing, wrong type, unrequested key); differing
        batch models → `model_mismatch`; retries honor `retry-after` and backoff, 401/422 not retried,
        retries exhausted → `retry_later`; timeout aborts; per-preset concurrency ≤ limit; usage summed
        across batches; redacted messages
  - [x] Implement

- [ ] Task 3: Test connection through the client
  <!-- files: src/jev/connection.ts, src/messages/provider.ts, src/entrypoints/options/ProviderSetup.tsx, tests/unit/jev-connection.test.ts, tests/unit/connection-message.test.ts, tests/unit/provider-messages.test.ts, tests/components/test-connection.test.tsx -->
  - [ ] Failing tests: `maxRetries: 0`; existing codes/messages preserved; new `timeout` code through the
        message union and Options copy
  - [ ] Implement

- [ ] Task 4: Phase 2 automated checkpoint — full gate green, evidence in `learnings.md`

## Phase 3: Typed question-set builder
<!-- execution: sequential -->
<!-- depends: phase2 -->

- [ ] Task 1: `defineDecision` and request building
  <!-- files: src/jev/define.ts, tests/unit/jev-define.test.ts -->
  - [ ] Failing snapshot tests: exact JSON for noul (with/without criteria), choice, score;
        `instructions` = `{ goal, question }` always present; invalid field names/option sets rejected
  - [ ] Implement

- [ ] Task 2: Typed `run()` results
  <!-- files: src/jev/define.ts, tests/unit/jev-define.test.ts -->
  - [ ] Failing tests (mock server): choice value typed as option-key union, noul → boolean at threshold,
        score → number; per-field confidence via `answerConfidence`; probabilities, model, usage carried
        through; client errors propagate unchanged
  - [ ] Implement

- [ ] Task 3: Phase 3 automated checkpoint — full gate green, evidence in `learnings.md`

## Phase 4: Options completion, e2e, live smoke
<!-- execution: parallel -->
<!-- depends: phase2 -->

- [ ] Task 1: Alias warning and provider data notes
  <!-- files: src/net/provider-info.ts, src/entrypoints/options/ProviderSetup.tsx, tests/components/provider-setup.test.tsx -->
  - [ ] Verify provider privacy-policy URLs and data-note wording (firecrawl) before writing constants
  - [ ] Failing component tests: warning for `jev-latest`/`jev-preview`, none for pinned ids; per-preset
        notes + link with `rel="noopener noreferrer"`
  - [ ] Implement

- [ ] Task 2: E2E provider setup and Test connection
  <!-- files: tests/e2e/provider.spec.ts, tests/e2e/helpers/provider.ts -->
  - [ ] Spec: routed fake TypeSafe endpoint → consent → Test connection shows model/latency and writes
        one sentLog row; without consent, zero requests. If Playwright cannot route the extension service
        worker's fetch, record it in `learnings.md` and file a Beads follow-up instead of weakening asserts
  - [ ] Implement helpers

- [ ] Task 3: Live smoke script
  <!-- files: tests/live/jev-smoke.test.ts, vitest.live.config.ts, package.json -->
  - [ ] `npm run test:live`: synthetic request to TypeSafe/OpenRouter when `TYPESAFE_API_KEY` /
        `OPENROUTER_API_KEY` is set, validates `SystemOneResponse`; skipped without keys; not in CI or
        the default Vitest include
  - [ ] Implement

- [ ] Task 4: Phase 4 automated checkpoint — full gate green, evidence in `learnings.md`

## Phase 5: Track close
<!-- execution: sequential -->
<!-- depends: phase3, phase4 -->

- [ ] Task 1: Docs sync — `PROJECT_PLAN.md` §1.1/§15/§18 Phase 3 status (after asking about its uncommitted
      edits), `conductor/tech-stack.md`, `conductor/product.md`; confirm `store/` needs no data-flow change
- [ ] Task 2: Final full gate (+ `npm run test:live` if keys are available) and elevate learnings to `patterns.md`
- [ ] Task 3: Conductor - User Manual Verification 'Phase 3 Jev Client track' (Protocol in workflow.md)
