# Track Learnings: phase5_llm_layer_20260928

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Read `conductor/patterns.md` before each task. It contains 98 consolidated
pattern entries from Phases 0–4. The ones most relevant to this track:

- **Scoped consent gates validate cheap-before-sensitive.** Scope registration
  and request-shape validation happen before consent rows, permissions, or key
  material are read. Prove short-circuits with dependency-spy call counts.
- **Fail-closed gates re-verify every call.** Destination, model, transport,
  origin, consent, exact host permission, credential, and feature payload are
  not trusted from setup-time state.
- **Keep the fixed Jev registry fixed.** Dynamic OpenAI-compatible destinations
  use a separate LLM gate rather than weakening `src/net/send.ts`.
- **Enable consent last; revoke consent first.** Partial setup cannot leave an
  egress-capable provider, and a partial revoke still fails closed.
- **Worker-owned secrets stay worker-only.** UI protocols receive masked
  suffixes and redacted status, never credential material.
- **Domain layers stay pure.** Provider parsing, structured-output validation,
  budget math, synopsis construction, and diff generation import no
  Chrome/DOM/React/fetch APIs.
- **Snapshot before mutation.** Restructure apply must be idempotently undoable;
  stale-tree validation happens before the first mutation.
- **Read-modify-write belongs inside the transaction.** This is required for
  concurrent budget reservations and persisted job cursors.
- **Dexie migrations use a genuine prior database.** Seed v3, reopen through
  the real class, assert the new version and preserved rows.
- **Unknown cost is not zero.** Existing usage code intentionally distinguishes
  absent provider cost from `$0.00`; LLM estimates must preserve provenance.
- **Exact optional properties are spread conditionally.** Never assign
  `undefined` under `exactOptionalPropertyTypes`.
- **MV3 jobs resume from committed progress.** User pause/cancel wins races;
  transient active-tab work is not falsely labeled resumable.
- **Playwright routes service-worker fetch, but its host-permission prompt is
  not trustworthy.** Keep routed e2e coverage and a real-Chrome manual gate.
- **Store disclosures mirror typed constants.** Sent fields, recipients,
  triggers, permissions, and consent versions change in one task.
- **Parallel workers use disjoint files.** The coordinator serializes shared
  entrypoints, package files, store docs, plan/learnings, commits, notes, and
  Beads state.

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-28 03:26] - Phase 1 Task 1: Provider schemas and destination normalization
- **Implemented:** `LlmProviderSettings` (strict discriminated union: preset
  openai/openrouter, custom baseUrl+model+auth+pricing), `LlmAuthMode`
  (bearer/api-key/none), `StructuredOutputTier` (json_schema/json_object/
  prompt_only), `ModelPricing`, `LlmBaseUrl` canonical-URL validator, and
  `resolveLlmDestination` producing origin/baseUrl/chat+models URLs/host
  permission pattern.
- **Files changed:** `src/schemas/llm.ts`, `src/llm/providers.ts`,
  `tests/unit/llm-provider.test.ts`
- **Commit:** (see below)
- **Learnings:**
  - Patterns: canonical-base-URL validation = parse + scheme/userinfo/query/
    fragment checks + `value === origin + path` equality — input must already
    BE canonical, so `..` segments, default ports, uppercase hosts, and
    trailing slashes are rejected without rewriting rules.
  - Gotchas: `new URL()` does NOT collapse `//` in paths — canonical equality
    alone accepts `https://h//v1`; check `path.includes("//")` separately.
  - Context: Chrome match patterns can't express ports — `permissionPattern`
    is host-only (`http://localhost/*`); the Phase-2 gate must re-check the
    exact origin (port included) per request.
---

## [2026-09-28 03:32] - Phase 1 Task 2: Generic encrypted credential storage
- **Implemented:** `src/security/credentials.ts` — `saveCredential`/
  `readCredential`/`deleteCredential(id)` under a `credential:<id>` namespace
  (both envelope key and CryptoKey row), plus exported low-level
  `*Envelope(storageKey, materialId, …)` functions for namespaced wrappers.
  `src/security/keys.ts` is now a thin wrapper preserving legacy
  `provider:<preset>`/`providerKey:<preset>` ids and `ProviderKeyError`.
- **Files changed:** `src/security/credentials.ts`, `src/security/keys.ts`,
  `tests/unit/credentials.test.ts`, `tests/unit/keys.test.ts` (unchanged —
  14/14 still pass, proving compat)
- **Commit:** (see below)
- **Learnings:**
  - Patterns: keep legacy storage ids verbatim in wrappers — do NOT re-derive
    them from the new namespace formula (legacy envelopes at `providerKey:*`
    would orphan). Wrappers translate `CredentialError` → `ProviderKeyError`
    so callers see the same error contract.
  - Gotchas: `getOrCreateKey` had a key-generation race — concurrent saves
    could each `put` a CryptoKey, leaving the losing envelope undecryptable.
    Fixed with a per-materialId in-memory lock (`keyCreationLocks` map);
    concurrent saves now share one key and last-write-wins.
  - Context: credential ids are validated (1–300 chars, no blank/whitespace)
    but NOT secrets — they embed the provider locator, never the token.
---

## [2026-09-28 03:38] - Phase 1 Task 3: OpenAI-compatible wire schemas and structured-output engine
- **Implemented:** `src/llm/wire.ts` — strict `ChatCompletionRequest`/
  `ChatMessage`/`ResponseFormat` (json_schema+json_object), loose
  `ChatCompletionResponse` (provider responses are untrusted: validate only
  consumed fields), `firstText`, `parseUsage` (OpenRouter `cost` →
  `reportedCostUsd`, null = unknown never 0). `src/llm/structured.ts` —
  `runStructured({tier, model, schema, schemaName, messages, send})`,
  `LlmCapabilityError` (tier-fallback signal), `StructuredOutputError`
  (redacted, reason-tagged), `extractBoundedJson` (64KB cap + whole-body-or-
  single-fence-only), ≤2 repairs per tier, fallback only on explicit
  capability rejection.
- **Files changed:** `src/llm/wire.ts`, `src/llm/structured.ts`,
  `tests/unit/llm-wire.test.ts`, `tests/unit/llm-structured.test.ts`
- **Commit:** (see below)
- **Learnings:**
  - Patterns: repair = append assistant echo (truncated to 4KB) + generic
    user instruction carrying the failure reason, staying on the same tier;
    a tier's failure NEVER descends — only `LlmCapabilityError` descends.
    Tier system-prompt merges into an existing leading system message rather
    than stacking a second one (some providers accept only one).
  - Gotchas: `import { T, type U }` mixing — a schema used as `.parse()` must
    be a value import even when the neighboring name is type-only
    (verbatimModuleSyntax). `exactOptionalPropertyTypes` forces conditional
    spreads when mapping optional provider fields (`usage.cost` etc.).
  - Context: `z.toJSONSchema(schema, {target: "draft-7"})` emits the subset
    OpenAI documents for `response_format: json_schema`; Zod's jitless config
    does not affect it.
---

## [2026-09-28 03:42] - Phase 1 Task 4: Pure budget and usage accounting
- **Implemented:** `src/llm/budget.ts` — `reserveBudget` (conservative
  max-cost reservation from token bounds × rates; refuses `budget_exceeded`
  past the cap, `pricing_required` for automatic w/o rates,
  `confirmation_required` for manual w/o rates; `unknownCostConfirmed` is a
  manual-only override and is ignored for automatic), `reconcileBudget`
  (reported > estimated > unknown provenance; settles reservation, emits the
  usage row to persist), `releaseBudget`, `monthlyBudgetSnapshot` (UTC-month
  filtering, active reservations only, `unknownCostRequests` surfaced).
- **Files changed:** `src/llm/budget.ts`, `tests/unit/llm-budget.test.ts`
- **Commit:** (see below)
- **Learnings:**
  - Patterns: reservations snapshot their pricing so reconcile needs only
    the reservation + actual usage; callers persist rows, functions stay
    pure (even `now` is a parameter — no hidden `new Date()`).
  - Gotchas: UTC month membership must be derived from the parsed Date
    (`getUTCFullYear/Month`), not string slicing — ISO timestamps with
    offsets (`+02:00`) can straddle boundaries. "Reliable pricing" resolves
    to numeric rates (configured or provider-fetched e.g. OpenRouter
    `/models`); post-hoc reported cost alone cannot bound a reservation.
  - Context: unknown-cost reservations have `reservedUsd: null` and never
    count toward the cap — they exist only via the manual override.
---

## [2026-09-28 03:52] - Phase 2 Task 1: Dexie and LLM configuration persistence
- **Implemented:** Dexie v4 (`llmUsage` ++id,providerId,recordedAt +
  `llmReservations` id,providerId,status); `LlmUsageRecord` schema
  (providerId/feature/configuredModel/model/tokens/costUsd?/estimatedCostUsd?/
  recordedAt — provenance derivable, never stored); `LlmProviderRecord` schema
  (strict — extra fields like a raw key fail closed); `src/llm/settings.ts`
  read/save/delete/active-pointer on metadata rows (`llmProvider:<id>`,
  `llmActiveProvider`); delete-all now also releases dynamically granted
  origins via `permissions.getAll` (registry fallback when absent).
- **Files changed:** `src/db/database.ts`, `src/schemas/usage.ts`,
  `src/schemas/llm.ts`, `src/llm/settings.ts`, `src/security/delete-all.ts`,
  `tests/unit/database-v4.test.ts`, `tests/unit/llm-settings.test.ts`,
  `tests/unit/delete-all.test.ts`
- **Commit:** (see below)
- **Learnings:**
  - Patterns: LLM settings live in the shared `metadata` table under
    namespaced keys (`llmProvider:<providerId>`, `llmActiveProvider`) — no
    dedicated table needed; readers validate rows through
    `LlmProviderRecord.safeParse` so hostile/malformed rows fail to null.
    `deleteLlmProvider` sweeps the provider's reservation rows in one tx,
    then deletes its `credential:<providerId>` envelope via credentials.ts.
  - Gotchas: static `OPTIONAL_HOST_ORIGINS` can't name dynamic custom origins
    — `permissions.getAll().origins` enumerates every granted host
    permission; union it with the registry, keep `contains` before `remove`.
  - Context: usage rows carry `costUsd` (reported) XOR `estimatedCostUsd`
    (local estimate) XOR neither (unknown) — provenance is derivable, so
    it's deliberately NOT a stored column.
---
### Phase 2 Task 2 — LLM consent scopes, permissions, disclosures
- **Outcome:** Success — 6 new scopes (`llm_test`, `llm_explain`,
  `llm_escalate`, `llm_restructure`, `llm_summary`, `jev_summary_verify`),
  `CONSENT_VERSION` 2→3 (all earlier grants re-disclosed), consent API
  generalized to origin-based (`*AtOrigin`) with preset wrappers delegating,
  `ConsentRecord.origin` widened to canonical https OR canonical loopback
  http (port included in origin), `wxt.config.ts` optional hosts now
  presets + `https://*/*` capability + 3 loopback patterns, all five store
  docs updated, consent snapshot extended to v3 + LLM disclosure/store-doc
  assertions, new `manifest.test.ts` pins the host list.
- **Files changed:** `src/schemas/provider.ts`, `src/consent/records.ts`,
  `src/consent/disclosure.ts`, `src/schemas/llm.ts` (export LOOPBACK_HOSTS),
  `wxt.config.ts`, `store/permissions.md`, `store/privacy-policy.md`,
  `store/privacy-practices.md`, `store/listing.md`, `store/reviewer-notes.md`,
  `tests/unit/consent.test.ts`, `tests/unit/consent-snapshot.test.ts`,
  `tests/unit/manifest.test.ts` (new)
- **Learnings:**
  - Patterns: `ConsentScope` enum derives from `CONSENT_SCOPES` tuple —
    appending six scopes automatically widened every consumer;
    `LLM_SCOPE_DISCLOSURES` is `satisfies Record<LlmConsentScope, …>` so a
    missing scope fails to compile; the §13.12 snapshot now unions all
    per-scope `fields` (deduped — labels repeat across scopes).
  - Gotchas: `grantConsent` must stay `async` — `resolvePreset` throws
    synchronously, and a non-async delegating wrapper turns a rejection into
    a sync throw (broke "rejects unknown preset" tests); `export { X }` +
    `import { X }` both needed when re-exporting AND consuming the same
    binding.
  - Context: Chrome host patterns can't express ports — loopback grants are
    host-scoped; the Phase-3 gate enforces the full origin (host+port)
    itself. `check-manifest.mjs` diffs `store/permissions.md` rows against
    the built manifest — doc rows and `wxt.config.ts` must change together.
---
## Phase 2 Task 3 — LLM egress gate, client, scripted server (2026-09-28)

- **Intent:** `sendLlmConsented` (src/net/llm-send.ts) enforces gate order
  (registered scope → provider → destination → closed request → consent →
  exact permission → credential → budget reservation → fetch);
  `createLlmClient` (src/llm/client.ts) wire-parses responses, settles
  usage on every path, maps capability failures; scripted in-memory
  OpenAI server for tests.
- **Files changed:** `src/net/llm-send.ts` (new), `src/llm/client.ts` (new),
  `src/schemas/llm.ts` (`monthlyBudgetUsd` on LlmProviderRecord),
  `src/net/send.ts` (registry `satisfies` narrowed to Jev scopes —
  widening `ConsentScope` made full-union exhaustiveness fail),
  `tests/mock-servers/openai.ts`, `tests/unit/llm-gate.test.ts`,
  `tests/unit/llm-client.test.ts` (new).
- **Learnings:**
  - Gotchas: widening a `satisfies Record<UnionType, …>` key set turns the
    check exhaustive — the Jev SCOPES registry needed its key type pinned
    to the two Jev scopes; `unknownCostConfirmed` is a `LlmSendOptions`
    field, not input — a stray input key is silently ignored (strict
    object would reject; interfaces don't); `await p.catch(f) as T` on
    `Promise<unknown>` still yields `unknown` — wrap the whole await in
    parens before casting; Dexie's "Target cannot be null or undefined"
    assertion was a test-helper bug (`fetch.requests` on the bare fetch
    fn instead of the server object), not a schema problem.
  - Patterns: `settleLlmUsage` runs inside `db.transaction('rw', …)` so
    reservation settle + llmUsage row are atomic; idempotent via
    `status !== "active"` early-return; the sent-log row is appended only
    after fetch resolves so blocked requests never log.
---

## Phase 2 Task 4 — Worker-owned LLM provider protocol (2026-09-28)

- **Intent:** `handleLlmProviderMessage` (src/messages/llm-provider.ts) owns
  `LLM_CONFIGURE`/`LLM_PROVIDER_STATUS`/`LLM_TEST`/`LLM_REVOKE`/
  `LLM_BUDGET_SNAPSHOT` from the Options page only; wired into
  `background.ts` between the decisions dispatcher and the terminal Jev
  provider handler (returns `undefined` for foreign types).
- **Files changed:** `src/messages/llm-provider.ts` (new),
  `src/entrypoints/background.ts`, `tests/unit/llm-provider-messages.test.ts`
  (new).
- **Learnings:**
  - Patterns: configure order is record → credential → consent (consent
    last; unwind deletes record, credential, and the llm_test grant on any
    partial failure); `enabled` = record + `llm_test` consent at the exact
    origin + host permission — credential absence deliberately NOT folded
    in so a missing key surfaces as the gate's `no_key` instead of silent
    disable (mirrors the Jev `readStatus`); revoke is consent-first via
    `revokeConsentsAtOrigin` (all scopes at the origin) then permission →
    record/reservations → optional credential delete.
  - Test seam: `LLM_TEST` discovers the structured-output tier by probing
    json_schema → json_object → prompt_only through the real gated client —
    `LlmCapabilityError` advances the tier probe, any other error ends it;
    the test ping is a fixed synthetic request (max_tokens 16, temperature
    0) under `llm_test` scope with `kind:"manual"` +
    `unknownCostConfirmed:true` (the enable click is the confirmation).
  - Gotchas: `vi.spyOn(chrome.storage.local, "set")` fails typecheck in
    tests since `chrome` isn't declared there — keep a holder object whose
    method the stub delegates to and spy on the holder;
    `satisfies readonly StructuredOutputTier[]` pins the probe order to
    the tier enum.
---

### Phase 2 Task 5 — Options provider/budget UI + CostConfirmationDialog
  - Enable click calls `chrome.permissions.request` synchronously BEFORE any
    await — the user-gesture token dies across microtask boundaries, so the
    first permission request must be the literal first statement after
    validation that does not await (URL validation errors return early
    without touching permissions).
  - `noUncheckedIndexedAccess` turns index reads into `T | undefined` even
    right after an assignment — capture the value in a const; in tests the
    worker double must return the same object shape the real protocol
    produces or the parsed-union check fails typecheck.
  - `no-case-declarations` lint fires on bare `const` inside `case` — wrap
    the case body in `{}`.
  - Button-name regexes must be anchored: `/send|confirm/i` also matches
    "Don't send"; use `/^send anyway$/i`.
  - Disclosure wants concrete credential transport naming — the verbatim
    `credentialUse` string plus an explicit bullet naming the
    `Authorization`/`api-key` header keeps the copy honest per auth mode.
---
### Phase 2 gate — stale pins
  - Schema bumps and optional_host_permissions changes invalidate older
    migration/scaffold assertions: full-suite gate caught database.test,
    database-v2/v3 and scaffold still pinning v3/11-tables/two patterns.
    When the spec widens a contract, update every pin in the same commit
    wave — do not leave half the suite asserting the old world.
---
### Phase 3 Task 1 — Explanation service
  - `installBookmarksFake` stubs the WHOLE `chrome` global (`{bookmarks:
    fake}`) — compose it: install the fake first, then re-stub chrome with
    `{bookmarks: fake, storage, permissions}`; ordering matters.
  - Blocklist includes the private-use TLD `example` — fixture URLs like
    `https://a.example/` are silently unsendable; use public-looking hosts
    (`a-site.com`) in tests that exercise the egress path.
  - Gate codes are `no_consent`/`no_permission`/`no_key` — not
    `consent_required`; `confirmation_required` applies only to
    `kind:"manual"` requests without `unknownCostConfirmed:true`.
  - `record.provider.model` is optional for presets — always resolve the
    effective model via `resolveLlmDestination(provider).model`.
  - `LlmCapabilityError`/`TokenUsage` live in `structured.ts`/`wire.ts`,
    not `client.ts`/`schemas/llm.ts`.
---
### Phase 3 Task 2 — Escalation router
  - Custom provider ids derive from the FULL baseUrl (`custom:<baseUrl>`,
    path included — `custom:https://llm.example.com/v1`); the gate rejects a
    record whose providerId doesn't match its resolved destination.
  - `RequestKind` is `"manual" | "automatic"` — not `"auto"`.
  - `maybeEscalateDecision` swallows every failure into `null` (ordinary
    review fallback) — keep the try/catch total, and keep `escalation`/`rationale`
    writes advisory: status stays whatever the policy decided.
  - `AnalyzeBookmarkResult` is a discriminated union on `sent` — tests need a
    `if (!result.sent) throw` narrowing guard before touching `.decisions`.
---
### Phase 3 Task 3 — Feature messages
  - `TokenUsage` fields are `promptTokens`/`completionTokens`/`reportedCostUsd`
    — not input/output; map at reply boundaries to the page-facing
    `inputTokens`/`outputTokens`/`costUsd` shape.
  - Unpriced manual LLM calls correctly refuse with `confirmation_required`
    FIRST — the contract is: page shows CostConfirmationDialog, resends the
    same intent with `unknownCostConfirmed:true`. Test both legs.
  - Disabling escalation must keep the stored providerId (re-enable is one
    click); write `{enabled:false}` only when none was ever stored.
---
### Phase 3 Task 4 — Review + escalation settings UI
  - Unsure/escalated rows were invisible — `listPending()` returns status
    "pending" only. `listReviewable()` (pending + unsure, createdAt order)
    backs App/badge/ReviewView; the popup still uses `listPending`.
  - Sidepanel can't read provider status (options-trusted protocol) — the
    `confirmation_required` reply carries `destinationOrigin` so
    CostConfirmationDialog names the egress origin without a second round
    trip. Other failure replies omit it (exactOptionalPropertyTypes).
  - Escalation settings split reads: `LLM_PROVIDER_STATUS` supplies the
    egress origin (consent lookup key) + cap; `LLM_ESCALATION_STATUS` the
    enabled flag. Consent is a direct Dexie `grantConsentAtOrigin` at the
    origin — re-read live via `useLiveQuery` keyed on llmOrigin.
  - Component tests: `findByRole` (not `getByRole`) for anything behind the
    async provider-status load; mock LLM replies need casting through the
    stub worker's reply union (`asWorkerReply`).
---
### Phase 4 Task 1 — Readability extractor
  - WXT unlisted scripts are plain `entrypoints/*.ts` files exporting
    `defineUnlistedScript` from `wxt/utils/define-unlisted-script` — the
    `.content.ts` suffix forces manifest registration and fails the build;
    the emitted asset lands at `.output/chrome-mv3/<name>.js` (root, not
    `content-scripts/`).
  - `extractActivePage` order: tabs.get → incognito/refused-URL checks →
    executeScript → Zod → caps. `chrome.scripting` never runs for a page
    that can't receive it; Readability returns `null` → `empty` refusal.
  - `@mozilla/readability` 0.6 types mark `article.excerpt`/`siteName`/
    `byline` as `string | null` — narrow all three before assignment.
  - jsdom types aren't installed; unit tests use
    `document.implementation.createHTMLDocument` (vitest env is jsdom).
---
### Phase 4 Task 2 — Summary persistence + Jev verification contract
  - Task factories return `QuestionSet{questionSetVersion, decision, state}`
    — `questionSetVersion` lives on the wrapper, not the Decision. Generic
    field maps need `type` aliases (index signature), not `interface`.
  - `choice(question, options)` is positional, not object-arg.
  - `SystemOneRequest.state` is `Text` (string|record|array of json) — the
    state object goes on the wire verbatim, so the scope guard strict-parses
    `request.state` directly.
  - `jev_summary_verify` rides `sendConsented` (the Jev gate), NOT
    `sendLlmConsented`; register it in send.ts SCOPES with its own guard
    (strict SummaryVerificationState + bookmark.url blocklist + model pin).
  - Meta repo lazy-row rule: any new data field must join `MetaFields`,
    `isEmptyMeta`, `commitMeta`, `putMeta`, `patchMeta` merge, and the
    `rewriteTagRows` emptiness check — the optional field compiles silently
    without it.
---
- `summarizeActiveBookmark(input)` is total: extract → bookmark URL match
  (`cleanUrl` both sides) → separate `llm_summary` + `jev_summary_verify`
  consent checks (`hasConsentAtOrigin`, origins resolved from the provider
  record / typesafe preset) → `summarizePage` → `verifySummaryRun` →
  `setBookmarkSummary` ONLY on `supported`. Every failure is a typed
  `SummarizeOutcome` (extract|match|consent|summarize|verify|persist).
- `ScriptResult` has NO `url` field (strict object) — the extract URL is the
  tab's own `tab.url`; test script results must not include `url`.
- `llmUsage` rows carry `feature` (the consent scope), not `scope`.
- `hasConsent(scope, preset)` takes a PresetId — use `hasConsentAtOrigin`
  for resolved-origin checks.
- `createJevClient` defaults `transport = sendConsented`; tests inject a
  `jevTransport` seam on `SummarizeInput` rather than stubbing the preset URL.
- Unpriced preset providers gate with `confirmation_required` unless
  `unknownCostConfirmed: true` — same as Explain.
- Stale manifest pins: adding `scripting` to wxt.config permissions needs the
  same constant added in scaffold.test.ts + manifest.test.ts.
- `src/messages/summaries.ts` owns `LLM_SUMMARIZE` (tabId+bookmarkId+
  unknownCostConfirmed) and `LLM_SUMMARY_READ` — chained after
  llm-features in background.ts. `SummarizeOutcome` maps stage→wire code;
  `confirmation_required` reattaches `destinationOrigin` for the cost dialog.
- The Jev verify send needs a stored `typesafe` provider key
  (`saveProviderKey`) in tests — `sendConsented` rejects `no_key` otherwise.
- Component tests need manual `afterEach(cleanup())` + `vi.unstubAllGlobals()`
  — vitest has no auto-cleanup here; without it `getByRole` sees stale dialogs.
- `chrome.tabs.query` in the click handler must be a lazy slice (`declare const
  chrome` partial) — tests stub `runtime.sendMessage` only.
- `buildLibrarySynopsis(tree, metas, limits)`: deterministic pre-order walk,
  sorted folder paths + count maps + top-domains + capped representative
  titles; sensitive/blocklisted/unclean URLs skipped, URLs/notes/ids never
  enter the synopsis. `metas` accepts Map or array.
- `ReadonlyMap | readonly T[]` unions narrow via `instanceof Map` + explicit
  `else` — `Array.isArray` alone doesn't split a ReadonlyMap union.
- react-hooks/set-state-in-effect: reset dialog phase during RENDER via the
  adjust-state-on-prop-change pattern (prevOpen state + conditional
  setState), not inside useEffect.
- `@testing-library/user-event` is NOT installed — use `fireEvent`.
- No jest-dom matchers — assert `el.textContent`/`.toContain`, not
  toHaveTextContent/toBeInTheDocument.
- `Job.restructure` (v4 job schema, optional): `{proposal, assignments[]}` —
  the vetted proposal travels on the row so a resume never re-egresses the
  LLM call; `mergeRestructureAssignments` merges by bookmarkId (last wins).
  `jobChecks("restructure")` → `[]`; the runner drives an injected
  JobAnalyzeFn — `createRestructureAssigner` adapts `assignProposedFolder`.
- Provider records' `providerId` MUST equal `resolveLlmDestination`'s id:
  `preset:<preset>` or `custom:<baseUrl>` — an arbitrary id fails the gate's
  `invalid_provider` destination check.
- `makeOpenAiServer({completion})` takes a `(body) => completion` callback,
  not a payload; `requests[].body` is already parsed JSON.
- `.example` is an intranet TLD → `isSensitiveUrl` blocks it in tests; use
  real-looking domains (a-site.io). `accounts.mybank.com` is NOT builtin —
  `chase.com` is.
- Credential tests need a `chrome.storage.local` shim (get/set/remove over a
  Map) AND `permissions.contains` — both stubbed via `vi.stubGlobal`.
- `ASSIGNMENT_CONFIDENCE_THRESHOLD = 0.5`: below it (or `none`/unknown key)
  → `{proposedPath: null, confidence: null}` = unresolved.

## Phase 5 Task 3 — preview/apply/undo

- `buildRestructureDiff(tree, plan)` walks the live tree once (id→{node,parent
  path}) and returns rows in stable bookmarkId order; unresolved =
  `proposedPath===null`, stale = absent from the live tree.
- `applyRestructurePlan(jobId)` revalidates against the live tree at apply
  time, creates folders parents-first (reusing existing same-path folders),
  snapshots every moved bookmark's pre-move position BEFORE mutating, and on
  mid-apply failure replays moves in reverse + removes created folders.
- `UndoKind` gained `"restructure"`; `UndoSnapshot`/`UndoSnapshotInput` gained
  `createdFolderIds` (parents-first). `runUndoLatest` restores moves then
  removes each created folder iff still a folder and empty.
- `Array.isArray` does NOT narrow a `ReadonlyMap | readonly T[]` union in the
  false branch — use `"get" in metas` (in-narrowing) instead.

## Phase 5 Task 4 — protocol + view

- `handleRestructureMessage(message, sender, deps)` owns RESTARTURE_*
  types (START/STATUS/PAUSE/RESUME/CANCEL/CONFIRM/UNDO); injected
  `deps.runJob` = `runPersistedJob` (which now dispatches
  `createRestructureAssigner` for `kind === "restructure"`).
- START replies `confirmation_required` + `destinationOrigin` so the view
  resends once with `unknownCostConfirmed: true` via CostConfirmationDialog.
- Job table has no `kind` index — latest-restructure lookup is a filtered
  `toArray()` scan sorted by `createdAt`.
- Side-panel chrome stub must late-bind `sendMessage` (`(m) => sendMessage(m)`)
  or per-test mock swaps silently keep the beforeEach instance.
- The shell toast's Undo calls `undoLatest` — `undoable: true` alone wires
  restructure undo; no custom callback needed.
- Job status is spelled `canceled` (single l).


## Phase 6 Task 1 — e2e LLM suite

- Feature consent scopes (`llm_restructure`, `llm_summary`, `llm_explain`,
  `jev_summary_verify`) were NEVER granted anywhere before this task —
  every Phase 3–5 feature would have failed `no_consent` in production.
  Fixed by writing each scope's origin-scoped grant at its affirmative
  click (the click IS the consent trigger, mirroring `llm_test` at
  enable and `llm_escalate` at the Options toggle), then re-checking
  `hasConsentAtOrigin` before the gated send. The four old-semantics
  unit tests ("refuses without the grant") now assert the grant is
  written and the flow proceeds to the next gate.
- `escalationStatus()` resolved `providerConfigured`/`monthlyBudgetUsd`
  only from a STORED providerId, but the only writer of that field was
  the toggle the status gates — a first-time deadlock that made the
  escalation toggle unreachable. It now falls back to the active
  provider record, matching `setEscalation`'s own default.
- Playwright realities, documented in the spec header:
  `chrome.permissions.request` never resolves (install-time host grant
  workaround in `launchLlmExtension`); install-time host permissions
  are not removable (`permissions.remove` fails — revoke test accepts
  either notice and asserts post-revoke refusal); a parked routed
  fetch aborts on `context.close()` and the runner's failure write can
  race `paused` — `release()` before close.
- `routeFakeDecisions` `autoRelease: N` counts REQUESTS, not batches —
  batch 1 of a 7-bookmark job is 5 calls.
- `routeFakeOpenAi` takes an optional `origin` — a custom provider's
  wire is on its own origin, not api.openai.com.
- `LLM_ESCALATION_SET`'s consent lives in the Options UI (disclosure
  checkbox → "Allow second opinions" → `grantConsentAtOrigin`), not the
  message; the toggle is a controlled checkbox that only re-checks after
  the SET roundtrip — use `click()` + polled `toBeChecked`, not
  `check()`.
- `.test` and `example` are in the built-in unsendable-TLD list — the
  summarize fixture uses a normal `.io` host.
- `LLM_SUMMARIZE` needs a real navigable tab: `context.newPage()` +
  `context.route` fixture HTML + `chrome.tabs.query` for the tabId;
  `chrome.scripting` is covered by the install-time host grant for the
  fixture origin.
