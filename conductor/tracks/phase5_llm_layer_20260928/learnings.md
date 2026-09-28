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
