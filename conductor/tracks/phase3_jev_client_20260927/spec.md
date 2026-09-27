# Spec: Phase 3 — Jev Client Hardening and Typed Question Builder

Track: `phase3_jev_client_20260927` · Type: feature · Source: PROJECT_PLAN.md §§2.3, 8.2–8.5, 10.1, 12, 13.5, 14, 15 (Phase 3)

## Overview

Phase 0 shipped the Phase 3 connection slice: wire schemas (`src/jev/wire.ts`), presets, consent,
encrypted keys, the consent gate (`src/net/send.ts`, synthetic `jev_test` request only), and the Options
Test-connection flow (`src/jev/connection.ts`). This track finishes Phase 3 so Phase 4 decision
features can call Jev safely: a scoped gate, a hardened client with retries, guards, splitting,
and usage accounting, an HTTP mock Jev server, the typed question-set builder from §8.4 with
per-field confidence from §10.1, and the remaining Options setup items from §8.5.

**Data flow does not change.** The only registered consent scope stays `jev_test`, the only
request that can leave the device stays the fixed synthetic request, `CONSENT_VERSION` stays 1,
and no permissions or store disclosures change.

## Functional Requirements

### FR1 Scoped network gate (`src/net/send.ts`, `src/consent/records.ts`)
- Generalize to `sendConsented(scope, preset, model, request, { signal })`. The gate order stays
  preset → model allowlist → https/origin → current consent for (scope, origin) →
  host permission → key, and it is re-checked on every call.
- A frozen scope registry holds only `jev_test`. Each scope carries a request guard. `jev_test`
  admits only a request deep-equal to `makeSyntheticRequest(model)`, so test consent cannot
  carry bookmark content. An unknown scope, or a request that fails its scope's guard, is
  refused (`unregistered_scope` or `request_not_allowed`) before any key or permission read.
- Consent helpers take a scope (`hasConsent(scope, preset)`). The existing `*TestConsent`
  wrappers and `sendConsentedTest` stay as thin wrappers, so current callers and tests keep working.
- The gate forwards an `AbortSignal` to `fetch`. An aborted send maps to `timeout`, and a
  sentLog row is written only when a request actually left.

### FR2 Pre-send guards and batch planning (`src/jev/budget.ts`)
- `estimateTokens(value)`: about 4 characters per token over the JSON, plus a 25% margin.
- Guards: choice options 2–255, score levels 2–10, unique non-empty question keys.
- `planBatches(request)`: every question must satisfy state + that question ≤ 32k tokens, or
  the call fails with a typed `too_large` error and nothing is sent. Questions are packed greedily,
  in key order, into batches where state + batch ≤ 64k tokens.

### FR3 Hardened client (`src/jev/client.ts`, `src/jev/retry.ts`, `src/jev/usage.ts`)
- `createJevClient({ preset, model, scope, transport?, timeoutMs = 10_000, maxRetries = 2,
  maxConcurrency = 4, sleep?, random?, now? })`. The default transport is the gate. Time and
  randomness are injectable for deterministic tests.
- `run(request)`: parse with `SystemOneRequest` → guards/plan → send each batch → validate
  with `SystemOneResponse` → cross-check that every question key has an answer of the
  same type and that there are no unrequested keys → merge the batch answers.
- Retries: exponential backoff with full jitter on 429, 529, 5xx, timeout, and transport errors.
  `retry-after` (delta-seconds or HTTP-date) is honored and capped. There is no retry on
  401, 422, other 4xx, invalid responses, or gate refusals.
- Per-preset concurrency limit shared by all clients of that preset.
- Typed errors (`JevClientError`): `auth`, `incompatible`, `retry_later` (retries exhausted),
  `timeout`, `http_error`, `invalid_response`, `answer_mismatch`, `model_mismatch` (batches
  answered by different versioned models), `too_large`, `invalid_request`, plus every gate code.
  Messages are redacted: bodies are never read on non-2xx, and `cause` is omitted wherever it
  could hold response content.
- Result: `{ model, answers, usage: { inputTokens, outputTokens, cost? }, batches }`.
  `UsageMeter` is a pure accumulator (sum tokens, sum cost when reported, record the models
  seen). Nothing is persisted.

### FR4 Confidence (`src/jev/confidence.ts`)
- `noulMargin(p, t = 0.5)` per §10.1. It validates `0 < t < 1` and `0 ≤ p ≤ 1`.
- `answerConfidence(answer, threshold?)`: choice and score answers use the returned
  `confidence`, and noul answers use the margin. Bands and actions (§10.2) are out of scope.

### FR5 Typed question-set builder (`src/jev/define.ts`)
- `defineDecision({ goal, fields })` with `noul(question, criteria?)`,
  `choice(question, options)`, and `score(question, levels)`.
- Field names become question keys. `goal` plus the field question build the `instructions`
  object `{ goal, question }`, sent in every question (never omitted). Choice option
  descriptions become the criteria.
- `build(state, model)` returns a `SystemOneRequest`. `run(client, state)` returns typed `values`
  (choice → the literal union of option keys, noul → `boolean` at the threshold, score → `number`)
  plus per-field `confidence`, raw `probabilities`, `model`, and `usage`.

### FR6 Test connection on the client (`src/jev/connection.ts`, `src/messages/provider.ts`)
- `testJevConnection` runs through the client under scope `jev_test` with `maxRetries: 0`.
  Existing codes and messages are kept. The new `timeout` code is carried through the
  message union and the Options UI copy.

### FR7 Options setup completion (§8.5 steps 6–7)
- Model picker: choosing a moving alias (`jev-latest`, `jev-preview`) shows a warning that
  thresholds tuned on one version may not carry over. Pinned ids show no warning.
- Per-preset provider data notes and a privacy-policy link, with URLs verified at
  implementation time. Links use `target="_blank" rel="noopener noreferrer"`.

### FR8 Test infrastructure
- `tests/mock-servers/jev.ts`: a Node HTTP server on 127.0.0.1 implementing `POST /v1/systemone`
  and `/api/v1/systemone`. It answers from the question types by default and can be scripted
  per call to return 401, 422, 429 or 529 with `retry-after`, 5xx, a delay or hang, malformed
  JSON, missing or mismatched answers, OpenRouter extras (`id`, `provider`, `usage.cost`), or
  varying `model`. It records the requests it receives.
- Playwright e2e: Options setup → consent → Test connection against a routed fake provider shows
  the model, latency, and cost and writes one sentLog row. Test connection without consent makes no
  request.
- `npm run test:live`: a separate Vitest config under `tests/live/` that sends the synthetic
  request to TypeSafe and OpenRouter when `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is set.
  It is skipped otherwise and never runs in CI.

## Non-Functional Requirements
- Import `z` only from `src/schemas/z.ts`. `fetch` stays confined to `src/net/**`. Handlers stay total.
- No `chrome` or DOM imports in `budget.ts`, `retry.ts`, `usage.ts`, `confidence.ts`, or `define.ts`.
- The client's added overhead stays negligible, measured against the mock server.
- The full CI gate stays green. Coverage of new `src/jev/**` modules is above 80%.

## Acceptance Criteria
1. The gate refuses unknown scopes and non-synthetic `jev_test` requests before reading a key
   or permission (spy call counts prove it). All existing gate, connection, and message tests pass.
2. Guard tests cover the 255/256 options, 10/11 levels, and 32k/64k boundaries, and splitting
   produces batches that each fit and together cover every question exactly once.
3. Against the mock server: retries honor `retry-after` and the backoff bounds, 401 and 422 are not
   retried, a timeout aborts, `answer_mismatch` and `model_mismatch` fire, merged answers
   and usage are exact, and concurrency never exceeds the limit.
4. Builder snapshot tests pin the exact JSON for noul, choice, and score, with `instructions`
   always present. Typed results and confidence match §10.1.
5. Options shows the alias warning and the per-preset data notes. The e2e Test connection passes
   with exactly one sentLog row, and the zero-egress specs still pass.
6. `check:manifest` is unchanged, there are no new permissions, `CONSENT_VERSION === 1`, and `store/`
   needs no data-flow edits.

## Out of Scope
- Any bookmark-data consent scope, disclosure, or `CONSENT_VERSION` bump (Phase 4).
- Question sets for real tasks, confidence bands and routing, the review queue, the job queue,
  and persisted cost tracking (Phase 4).
- The OpenRouter alpha Decisions preset and custom base URLs (release 1.1).
- The LLM layer (Phase 5), labeled fixtures and evals (Phase 6).
- The open `followup phase0` Beads items (for example `-42k` provider.ts split, `-bih` egress lint
  breadth, `-sd1` sentLog cap), unless an implementing task touches them anyway.
