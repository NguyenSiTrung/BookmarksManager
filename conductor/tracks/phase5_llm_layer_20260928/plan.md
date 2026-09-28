# Phase 5 LLM Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` (recommended) or `executing-plans` to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a consent-gated OpenAI-compatible LLM layer for explanations,
budget-capped low-confidence escalation, restructure proposals, and
Jev-verified summaries, including custom providers and opt-in page extraction.

**Architecture:** Keep the fixed Jev transport unchanged and add a separate
dynamic-origin LLM gate. A capability-aware structured-output client feeds four
independent feature services; closed Zod inputs, recipient-specific consent,
exact-origin permissions, encrypted credentials, and pre-send budget
reservations protect every egress path.

**Tech Stack:** WXT MV3, TypeScript strict, React 19, Zod 4, Dexie 4,
`@mozilla/readability@0.6.0`, Vitest 5, Testing Library, and Playwright 1.63.

**Spec:** `conductor/tracks/phase5_llm_layer_20260928/spec.md`

## Global Constraints

- Remote custom providers use HTTPS. Plain HTTP is accepted only for
  `localhost`, `127.0.0.1`, and `[::1]`; redirects are rejected.
- Supported authentication is exactly Bearer, `api-key`, or none. Arbitrary
  headers and URL credentials are rejected.
- `fetch` stays under `src/net/**`; every message and response crosses a Zod
  trust boundary; errors are redacted.
- Existing Jev scopes and `sendConsented` behavior remain backward compatible.
- Page extraction is explicit-action only, never incognito, never static, and
  never retains a DOM or excerpt.
- Escalation is off by default, requires reliable pricing and a monthly cap,
  and never auto-applies a decision.
- Restructure plans and destructive/moving actions always require review.
- Store docs, permissions, consent snapshots, and behavior change together.
- Per task: failing test → narrow red/green cycle → applicable gate → update
  this plan and `learnings.md` → local commit → `git notes add` → close the
  mapped Beads task. Never push, pull, fetch, or run `bd dolt push`.
- Parallel workers own only annotated files. The coordinator serializes shared
  files, plan/learnings updates, Beads state, commits, and notes.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Provider domain | `src/schemas/llm.ts`, `src/llm/providers.ts` | Settings, presets, URL/auth/capability validation |
| Credentials | `src/security/credentials.ts`, `src/security/keys.ts` | Provider-neutral encrypted secrets plus Jev compatibility |
| Structured client | `src/llm/wire.ts`, `src/llm/structured.ts` | Chat schemas, capability tiers, repair loop |
| Budget | `src/llm/budget.ts`, `src/schemas/usage.ts` | Reservation, reconciliation, provenance |
| Egress | `src/net/llm-send.ts`, `src/net/send.ts` | Dynamic LLM gate and unchanged fixed Jev gate |
| Consent | `src/consent/*`, `src/schemas/provider.ts` | Scope/origin grants and disclosures |
| Provider setup | `src/messages/llm-provider.ts`, `src/entrypoints/options/LlmProviderSetup.tsx` | Worker-owned configuration and Options flow |
| Features | `src/llm/{explain,escalate,summarize}.ts`, `src/restructure/*` | Feature-specific inputs, outputs, and orchestration |
| Extraction | `src/extract/*` | On-demand Readability extraction |
| Integration | `src/messages/*`, `src/entrypoints/background.ts` | Total worker protocols |
| UI | `src/entrypoints/{options,sidepanel}/*` | Settings, review, summary, restructure |
| Tests | `tests/{unit,components,e2e,live,mock-servers}/` | Contract, UI, browser, and live verification |

---

## Phase 1: Pure LLM foundations
<!-- execution: parallel -->

- [x] Task 1: Provider schemas and destination normalization
  <!-- files: src/schemas/llm.ts, src/llm/providers.ts, tests/unit/llm-provider.test.ts -->
  - Interfaces: `LlmProviderSettings`, `LlmAuthMode`, `StructuredOutputTier`,
    `ModelPricing`, `resolveLlmDestination(settings)`.
  - Red tests: OpenAI/OpenRouter presets; custom `/v1` base paths; exact
    canonical origin and endpoint joining; remote HTTPS; literal loopback HTTP
    across ports; reject userinfo, query, fragment, non-loopback HTTP, unsupported
    schemes, blank model, arbitrary auth/header shapes, and unknown keys.
  - Green implementation keeps URL parsing and preset resolution pure.
  - Verify: `npx vitest run tests/unit/llm-provider.test.ts`.

- [x] Task 2: Generic encrypted credential storage
  <!-- files: src/security/credentials.ts, src/security/keys.ts, tests/unit/credentials.test.ts, tests/unit/keys.test.ts -->
  - Interfaces: `saveCredential(id, plaintext)`, `readCredential(id)`,
    `deleteCredential(id)`; existing Jev key exports remain wrappers.
  - Red tests: namespace isolation, unique IVs, non-extractable AES-GCM keys,
    malformed envelopes, wrong/missing material, concurrent saves, deletion,
    and redacted errors.
  - Verify: `npx vitest run tests/unit/credentials.test.ts tests/unit/keys.test.ts`.

- [x] Task 3: OpenAI-compatible wire schemas and structured-output engine
  <!-- files: src/llm/wire.ts, src/llm/structured.ts, tests/unit/llm-wire.test.ts, tests/unit/llm-structured.test.ts -->
  - Interfaces: `ChatCompletionRequest`, `ChatCompletionResponse`,
    `runStructured({ tier, schema, messages, send })`,
    `StructuredRunResult<T>`.
  - Red tests: strict schema, JSON object, prompt-only bounded extraction,
    fenced JSON, trailing prose rejection, explicit unsupported-tier fallback,
    malformed-output non-fallback, maximum two repairs, response-model capture,
    usage parsing, and redaction.
  - Verify:
    `npx vitest run tests/unit/llm-wire.test.ts tests/unit/llm-structured.test.ts`.

- [x] Task 4: Pure budget and usage accounting
  <!-- files: src/llm/budget.ts, tests/unit/llm-budget.test.ts -->
  <!-- depends: task1 -->
  - Interfaces: `reserveBudget(input)`, `reconcileBudget(reservation, usage)`,
    `releaseBudget(reservation)`, and
    `monthlyBudgetSnapshot({ providerId, usage, reservations, now })`; all
    functions are pure and receive persisted rows as input.
  - Red tests: reported/estimated/unknown provenance, input/output rates,
    UTC month boundaries, exact cap, cap+epsilon refusal, concurrent
    reservations, and actual-under-estimate release; automatic requests
    without pricing are refused; manual requests without pricing return
    `confirmation_required`; a manual retry with `unknownCostConfirmed: true`
    may proceed with unknown monetary cost while still recording
    tokens/requests; automatic escalation can never set that override.
  - Verify: `npx vitest run tests/unit/llm-budget.test.ts`.

- [x] Task: Conductor - User Manual Verification 'Pure LLM foundations' (Protocol in workflow.md)
  <!-- depends: task1, task2, task3, task4 -->
  - Run lint, typecheck, Phase 1 unit tests, and build; summarize evidence and
    request user approval before Phase 2.

## Phase 2: Persistence, consent, egress, and provider setup
<!-- execution: sequential -->

- [x] Task 1: Dexie and LLM configuration persistence
  - Files: `src/db/database.ts`, `src/llm/settings.ts`,
    `src/schemas/usage.ts`, `src/security/delete-all.ts`,
    `tests/unit/database-v4.test.ts`,
    `tests/unit/llm-settings.test.ts`, `tests/unit/delete-all.test.ts`.
  - Interfaces: `readLlmProvider`, `saveLlmProvider`, `deleteLlmProvider`,
    `readActiveLlmProvider`, `LlmUsageRecord`.
  - Red tests seed a genuine v3 database, open v4, preserve every table, validate
    provider/usage rows, prove delete-all clears credentials/settings/reservations,
    and keep raw secrets out of IndexedDB and exports.
  - Verify:
    `npx vitest run tests/unit/database-v4.test.ts tests/unit/llm-settings.test.ts tests/unit/delete-all.test.ts`.

- [x] Task 2: LLM consent scopes, permissions, and disclosures
  - Files: `src/schemas/provider.ts`, `src/consent/records.ts`,
    `src/consent/disclosure.ts`, `wxt.config.ts`, `store/permissions.md`,
    `store/privacy-policy.md`, `store/privacy-practices.md`,
    `store/listing.md`, `store/reviewer-notes.md`,
    `tests/unit/consent.test.ts`, `tests/unit/consent-snapshot.test.ts`,
    `tests/unit/manifest.test.ts`.
  - Register `llm_test`, `llm_explain`, `llm_escalate`, `llm_restructure`,
    `llm_summary`, and `jev_summary_verify`; increase `CONSENT_VERSION`.
  - Red tests cover `(scope, origin)` isolation, stale grants, revoke-all,
    broad declared HTTPS versus exact requested origin, loopback patterns, and
    disclosure text matching each closed input schema.
  - Verify:
    `npx vitest run tests/unit/consent.test.ts tests/unit/consent-snapshot.test.ts tests/unit/manifest.test.ts && npm run check:manifest`.

- [x] Task 3: LLM egress gate, client, and scripted server
  - Files: `src/net/llm-send.ts`, `src/llm/client.ts`,
    `tests/mock-servers/openai.ts`, `tests/unit/llm-gate.test.ts`,
    `tests/unit/llm-client.test.ts`.
  - Interfaces: `sendLlmConsented(input, options)`, `LlmGateError`,
    `createLlmClient(providerId)`.
  - `options` carries the request mode (`automatic` or `manual`) and
    `unknownCostConfirmed`; the gate accepts the override only for manual
    feature scopes, never `llm_escalate`.
  - Gate order: registered scope → stored provider → normalized destination →
    closed feature input → current consent → exact permission → credential →
    budget reservation → fetch. Repairs may resend only the same-origin model
    response and validation error.
  - Red tests assert cheap-before-sensitive spy counts, credentials omitted,
    redirects rejected, auth modes exact, sent-log metadata only, timeout,
    transient retry/`retry-after`, permanent non-retry, repair cap,
    reconciliation on success/failure, unknown-cost `confirmation_required`,
    confirmed manual proceed, and escalation override rejection.
  - Verify:
    `npx vitest run tests/unit/llm-gate.test.ts tests/unit/llm-client.test.ts`.

- [x] Task 4: Worker-owned LLM provider protocol
  - Files: `src/messages/llm-provider.ts`, `src/entrypoints/background.ts`,
    `tests/unit/llm-provider-messages.test.ts`.
  - Intents: configure, status, test, revoke, and budget snapshot; replies expose
    only masked suffix, normalized destination, capability tier, model, latency,
    usage, and redacted errors.
  - Red tests cover trusted sender, malformed messages, denied/missing exact
    permission, synthetic-only test payload, stale replies, rollback on partial
    enable, consent-first revoke, and total handlers.
  - Verify: `npx vitest run tests/unit/llm-provider-messages.test.ts`.

- [x] Task 5: Options provider and budget UI
  - Files: `src/entrypoints/options/LlmProviderSetup.tsx`,
    `src/entrypoints/options/LlmBudget.tsx`,
    `src/entrypoints/options/main.tsx`,
    `src/ui/components/CostConfirmationDialog.tsx`,
    `tests/components/options-llm-provider.test.tsx`,
    `tests/components/cost-confirmation-dialog.test.tsx`.
  - UI requests the exact origin synchronously from the Enable click, supports
    preset/custom fields and three auth modes, requires unchecked affirmative
    consent, shows capability and cost provenance, and revokes permission and
    consent.
  - A reusable accessible `CostConfirmationDialog` states that monetary cost
    is unknown and returns a one-shot confirmation for the current manual
    action; it must not persist a blanket bypass.
  - Red tests cover keyboard/labels, invalid URL/model/pricing, no-auth flow,
    permission denial, pending/stale replies, raw-key clearing, budget display,
    no request before Test Connection, unknown-cost dialog copy and one-shot
    confirm/cancel, and no persisted bypass.
  - Verify:
    `npx vitest run tests/components/options-llm-provider.test.tsx tests/components/cost-confirmation-dialog.test.tsx`.

- [x] Task: Conductor - User Manual Verification 'LLM provider setup and security boundary' (Protocol in workflow.md)
  - Run lint, typecheck, Phase 2 tests, build, manifest and bundle checks; manually
    exercise exact-origin and loopback permission prompts before approval.

## Phase 3: Explanations and automatic second opinions
<!-- execution: parallel -->

- [x] Task 1: Explanation service
  <!-- files: src/llm/explain.ts, src/decisions/store.ts, tests/unit/llm-explain.test.ts, tests/unit/decisions-store.test.ts -->
  - Interfaces: `explainDecision(decisionId, providerId)`,
    `persistDecisionRationale(decisionId, rationale)`.
  - `persistDecisionRationale` is exported by `src/decisions/store.ts`,
    updates only `rationale`, preserves status and all payload fields, and
    writes no audit or status-transition row.
  - Red tests cover the minimized input, 1,000-character output cap, strict
    response, stale/missing decisions, no status transition, no apply/undo
    writes, and redacted failures.
  - Verify:
    `npx vitest run tests/unit/llm-explain.test.ts tests/unit/decisions-store.test.ts`.

- [x] Task 2: Escalation router
  <!-- files: src/llm/escalate.ts, src/schemas/decision.ts, src/decisions/pipeline.ts, tests/unit/llm-escalate.test.ts, tests/unit/decisions-pipeline.test.ts -->
  - Interfaces: `maybeEscalateDecision(decision, context)`,
    `LlmEscalation` with verdict, optional constrained alternative, rationale,
    model, and usage reference.
  - Red tests cover only `< REVIEW_FLOOR`, off-by-default settings, candidate-ID
    cross-checks, no invented action, consent/permission/pricing/cap fallback,
    agree/disagree/unsure persistence, scan resume, and never auto-apply.
  - Verify:
    `npx vitest run tests/unit/llm-escalate.test.ts tests/unit/decisions-pipeline.test.ts`.

- [x] Task 3: LLM feature messages and background wiring
  <!-- files: src/messages/llm-features.ts, src/entrypoints/background.ts, tests/unit/llm-feature-messages.test.ts -->
  <!-- depends: task1, task2 -->
  - Add Explain, read/write escalation settings, and budget-status intents with
    total handlers and trusted-sender checks.
  - Red tests prove no content or credentials cross replies and malformed or
    unavailable paths return stable codes.
  - Verify: `npx vitest run tests/unit/llm-feature-messages.test.ts`.

- [x] Task 4: Review and escalation settings UI
  <!-- files: src/entrypoints/sidepanel/ReviewView.tsx, src/entrypoints/options/DecisionSettings.tsx, tests/components/review-view.test.tsx, tests/components/options-llm-settings.test.tsx -->
  <!-- depends: task3 -->
  - Render Explain, rationale, verdict, constrained alternative, unavailable and
    budget-blocked states; add off-by-default escalation and monthly-cap controls.
  - When the worker returns `confirmation_required` for Explain, show
    `CostConfirmationDialog` and resend that one manual intent with
    `unknownCostConfirmed: true`; automatic escalation has no dialog or
    bypass.
  - Red tests cover focus retention, duplicate clicks, stale rows, live updates,
    non-color-only verdicts, and screen-reader status announcements.
  - Verify:
    `npx vitest run tests/components/review-view.test.tsx tests/components/options-llm-settings.test.tsx`.

- [x] Task: Conductor - User Manual Verification 'Explanations and automatic escalation' (Protocol in workflow.md)
  <!-- depends: task4 -->
  - Run applicable gate and manually verify Explain plus one budget-capped
    low-confidence escalation before approval.

## Phase 4: Opt-in page extraction and verified summaries
<!-- execution: parallel -->

- [x] Task 1: On-demand Readability extractor
  <!-- files: package.json, package-lock.json, wxt.config.ts, src/extract/page.ts, src/extract/readability.ts, tests/unit/page-extraction.test.ts, store/permissions.md -->
  - Install `@mozilla/readability@0.6.0`; add `scripting` with no static content
    scripts.
  - Interface: `extractActivePage(tabId)` returns bounded title, description,
    headings, and excerpt or a redacted refusal.
  - Red tests cover explicit invocation, active-tab requirement, incognito,
    restricted/sensitive URLs, hostile markup, deterministic caps, Readability
    failure, and no raw DOM retention.
  - Verify:
    `npx vitest run tests/unit/page-extraction.test.ts && npm run check:manifest`.

- [x] Task 2: Summary persistence and Jev verification contract
  <!-- files: src/schemas/meta.ts, src/schemas/summary-verification.ts, src/jev/tasks/verify-summary.ts, src/net/send.ts, src/db/meta.ts, tests/unit/summary-verification.test.ts, tests/unit/meta.test.ts, tests/unit/network-gate.test.ts -->
  - Interfaces: `SummaryVerificationState`, `verifySummary.run(client, state)`,
    `setBookmarkSummary(id, summary)`.
  - Add a dedicated `jev_summary_verify` guard; do not add page text to
    metadata-only `DecisionState`.
  - Red tests cover strict state, summary/excerpt caps, notes rejection,
    blocklist, separate consent, supported/unsupported/uncertain verdicts, and
    backward-compatible metadata rows.
  - Verify:
    `npx vitest run tests/unit/summary-verification.test.ts tests/unit/meta.test.ts tests/unit/network-gate.test.ts`.

- [x] Task 3: Summary orchestration
  <!-- files: src/llm/summarize.ts, src/decisions/summaries.ts, tests/unit/llm-summarize.test.ts -->
  <!-- depends: task1, task2 -->
  - Interface: `summarizeActiveBookmark(input)` performs extract → LLM summarize
    → Jev verify → persist only on positive support.
  - Red tests cover separate recipient grants, active-page/bookmark URL match,
    LLM validation, Jev false/uncertain, lost tab context, no excerpt
    persistence, usage rows, and no write on any failure.
  - Verify: `npx vitest run tests/unit/llm-summarize.test.ts`.

- [x] Task 4: Summary protocol and UI
  <!-- files: src/messages/summaries.ts, src/entrypoints/background.ts, src/entrypoints/sidepanel/SummaryDialog.tsx, src/entrypoints/sidepanel/App.tsx, tests/unit/summary-messages.test.ts, tests/components/summary-dialog.test.tsx -->
  <!-- depends: task3 -->
  - Add explicit Summarize intent and progress/result states; show persisted
    summaries only after verified storage.
  - When the worker returns `confirmation_required` for Summarize, show
    `CostConfirmationDialog` and resend that one manual intent with
    `unknownCostConfirmed: true`.
  - Red tests cover unavailable consent/provider/tab, retry, cancellation,
    focus trap/return, announcements, and no automatic invocation.
  - Verify:
    `npx vitest run tests/unit/summary-messages.test.ts tests/components/summary-dialog.test.tsx`.

- [x] Task: Conductor - User Manual Verification 'Opt-in extraction and verified summaries' (Protocol in workflow.md)
  <!-- depends: task4 -->
  - Run applicable gate and manually verify the Chrome scripting prompt,
    extraction disclosure, positive verification, and refused incognito path.

## Phase 5: Restructure proposals
<!-- execution: sequential -->

- [x] Task 1: Bounded synopsis and proposal schemas
  - Files: `src/schemas/restructure.ts`, `src/restructure/synopsis.ts`,
    `tests/unit/restructure-synopsis.test.ts`.
  - Interfaces: `buildLibrarySynopsis(tree, metas, limits)`,
    `RestructureProposal`.
  - Red tests cover deterministic aggregate order, title/domain caps, no URL or
    notes leakage, folder count/depth/name/description limits, duplicate paths,
    empty libraries, and sensitive-site exclusion.
  - Verify: `npx vitest run tests/unit/restructure-synopsis.test.ts`.

- [ ] Task 2: LLM proposal and resumable Jev assignment
  - Files: `src/restructure/propose.ts`, `src/restructure/assign.ts`,
    `src/jev/tasks/restructure.ts`, `src/schemas/job.ts`,
    `src/jobs/queue.ts`, `src/jobs/runner.ts`,
    `tests/unit/restructure-propose.test.ts`,
    `tests/unit/restructure-assign.test.ts`,
    `tests/unit/jobs-runner.test.ts`.
  - Interfaces: `proposeLayout`, `assignProposedFolders`,
    `JobKind = ... | "restructure"`.
  - Red tests cover one bounded proposal, candidate-ID cross-check, per-bookmark
    confidence, unresolved low-confidence assignments, persisted batch cursor,
    pause/resume/cancel, and restart without duplicate egress.
  - Verify:
    `npx vitest run tests/unit/restructure-propose.test.ts tests/unit/restructure-assign.test.ts tests/unit/jobs-runner.test.ts`.

- [ ] Task 3: Preview, guarded apply, and undo
  - Files: `src/restructure/diff.ts`, `src/restructure/apply.ts`,
    `src/schemas/undo.ts`, `tests/unit/restructure-apply.test.ts`.
  - Interfaces: `buildRestructureDiff`, `applyRestructurePlan`,
    `undoRestructurePlan`.
  - Red tests cover stable before/after diff, unresolved rows excluded, live-tree
    revalidation, folder creation order, move failures, compensating rollback,
    idempotent undo, and never applying before explicit confirmation.
  - Verify: `npx vitest run tests/unit/restructure-apply.test.ts`.

- [ ] Task 4: Restructure protocol and UI
  - Files: `src/messages/restructure.ts`, `src/entrypoints/background.ts`,
    `src/entrypoints/sidepanel/RestructureView.tsx`,
    `src/entrypoints/sidepanel/App.tsx`,
    `src/entrypoints/sidepanel/views.ts`,
    `tests/unit/restructure-messages.test.ts`,
    `tests/components/restructure-view.test.tsx`.
  - Add start/pause/resume/cancel/confirm/undo intents and a dedicated view with
    progress, confidence, unresolved assignments, tree diff, and destructive
    confirmation.
  - When the worker returns `confirmation_required` for a manual restructure
    proposal, show `CostConfirmationDialog` and resend that one manual intent
    with `unknownCostConfirmed: true`.
  - Red tests cover worker restart, stale tree, partial failure, duplicate
    confirmation, keyboard tree navigation, focus, and non-color-only confidence.
  - Verify:
    `npx vitest run tests/unit/restructure-messages.test.ts tests/components/restructure-view.test.tsx`.

- [ ] Task: Conductor - User Manual Verification 'Restructure proposals' (Protocol in workflow.md)
  - Run applicable gate and manually verify proposal, pause/resume, preview,
    apply, and undo before approval.

## Phase 6: Integration hardening and release documentation
<!-- execution: parallel -->

- [ ] Task 1: End-to-end LLM suite
  <!-- files: tests/mock-servers/openai.ts, tests/e2e/llm.spec.ts, tests/e2e/helpers/llm.ts -->
  - Cover fresh-install/no-consent zero egress, exact-origin custom setup, all
    output tiers, Explain, automatic escalation, budget exhaustion, revoke,
    summary→Jev verification, restructure apply/undo, and restart from committed
    progress.
  - Use wire-level routing; document the existing Playwright
    `chrome.permissions.request` limitation and retain a real-Chrome manual step.
  - Verify: `xvfb-run -a npm run test:e2e -- tests/e2e/llm.spec.ts`.

- [ ] Task 2: Live, performance, and accessibility gates
  <!-- files: tests/live/llm-live.test.ts, tests/unit/llm-performance.test.ts, tests/components/llm-accessibility.test.tsx, vitest.live.config.ts -->
  - Add key-gated OpenAI/OpenRouter strict-output smokes; custom compatibility
    stays on the scripted server.
  - Gate synopsis/extraction bounds and verify labels, focus, announcements, and
    keyboard-only operation on each new surface.
  - Verify:
    `npm run test:live && npx vitest run tests/unit/llm-performance.test.ts tests/components/llm-accessibility.test.tsx`.

- [ ] Task 3: Compliance and project-context synchronization
  <!-- files: scripts/check-manifest.mjs, scripts/check-bundle.mjs, tests/unit/compliance-scripts.test.ts, tests/unit/consent-snapshot.test.ts, store/privacy-policy.md, store/privacy-practices.md, store/listing.md, store/reviewer-notes.md, store/permissions.md, PROJECT_PLAN.md, conductor/product.md, conductor/tech-stack.md, conductor/patterns.md -->
  <!-- depends: task1, task2 -->
  - Pin broad declared HTTPS capability to exact-origin runtime requests in
    tests and reviewer notes; update website/store disclosures, page-text data
    category, auth handling, retention, and feature triggers.
  - Mark Phase 5 delivered only after the implementation evidence exists.
  - Verify:
    `npx vitest run tests/unit/compliance-scripts.test.ts tests/unit/consent-snapshot.test.ts && npm run check:manifest && npm run check:bundle`.

- [ ] Task 4: Full release gate
  <!-- depends: task1, task2, task3 -->
  - Run:
    `npm run lint && npm run typecheck && npm test -- --run && npm run build && npm run check:manifest && npm run check:bundle && xvfb-run -a npm run test:e2e`.
  - Record exact counts, warnings, build size, and known limitations in
    `learnings.md`; resolve regressions before marking complete.

- [ ] Task: Conductor - User Manual Verification 'Phase 5 LLM layer complete' (Protocol in workflow.md)
  <!-- depends: task4 -->
  - Present the full evidence and manual script for custom setup, Explain,
    automatic escalation, summary verification, restructure apply/undo, revoke,
    and zero-egress behavior. Advance only after user acceptance.
