# Track Learnings: phase0_foundation_20260925

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

- No application code or test suite exists yet. Follow the architecture in
  `PROJECT_PLAN.md` and update this file as concrete patterns emerge.
- The Beads workspace already exists. Do not reinitialize it or automatically
  push/sync code or Beads data.
- `conductor/workflow.md` requires test-first behavior changes, verification
  of scaffold/doc artifacts, local per-task commits, and git notes.
- Parallel workers own only their annotated implementation paths. The
  coordinator serializes updates to shared plan/learnings files and Beads.

---

<!-- Learnings from implementation will be appended below. -->

## [2026-09-25 16:06] - Phase 1 Task 1: Scaffold the WXT extension, linting, and test runners
- **Implemented:** WXT MV3 scaffold (background, popup, sidepanel, options) with React + Tailwind v4, strict TS, ESLint flat config with gated `fetch`/`globalThis.fetch` restrictions (`src/net/**` exception), Vitest unit contract, and a Playwright persistent-context extension smoke test.
- **Files changed:** `package.json`, `package-lock.json`, `wxt.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `src/entrypoints/background.ts`, `src/entrypoints/{popup,sidepanel,options}/{index.html,main.tsx}`, `src/ui/styles.css`, `tests/unit/scaffold.test.ts`, `tests/e2e/shell.spec.ts`, `.gitignore`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** f9950a3
- **Learnings:**
  - WXT 0.21.4 works with `srcDir: "src"`; `sidepanel/` entrypoint emits `sidepanel.html` + `side_panel` manifest key automatically. Root `tsconfig.json` extends the generated `.wxt/tsconfig.json` but must add `"jsx": "react-jsx"` itself — the react module does not set it.
  - `config.manifest` in `wxt.config.ts` is typed `UserManifest | Promise | Fn`; cast it to a narrow shape in unit tests before asserting fields.
  - Google Chrome 154 (branded stable) silently ignores `--load-extension`; Playwright extension tests must use `channel: "chromium"` (Playwright's bundled Chromium 153) — service worker starts and pages render headed on the real X display. `npx playwright install chromium` required.
  - `eslint-plugin-react` 7.x caps at ESLint `^9.7` — pinned `eslint@^9`. In `eslint-plugin-react-hooks` v7 use `configs.flat["recommended-latest"]` (the non-`flat` one is legacy format). `tseslint.configs.recommended` already disables `no-undef`.
  - `eslint .` lints everything including `.agents/` helper scripts — ignore `.agents/`, `.codex/`, `.superpowers/`, `.beads/`, `conductor/` in the flat config.
  - `no-restricted-globals` covers bare `fetch`; `no-restricted-properties` covers `globalThis.fetch`/`self.fetch`/`window.fetch`; a `src/net/**` override disables both.
  - Tailwind v4 needs no config file: `@tailwindcss/vite` plugin in `wxt.config.ts` `vite()` + `@import "tailwindcss"` in `src/ui/styles.css`.
  - Pinned versions: vitest 5, typescript 6.0.3, zod 4.6.5, dexie 4.4.6, react 19.3, @playwright/test 1.63, jsdom 30, fake-indexeddb 6.2.5.
---

## [2026-09-25 16:33] - Phase 1 Task 2: Add base Zod schemas and versioned Dexie storage
- **Implemented:** `src/schemas/z.ts` centralizes `z.config({ jitless: true })` (MV3 CSP-safe) and re-exports `z`; `bookmark.ts`/`decision.ts` carry the PROJECT_PLAN.md §7 shapes verbatim (discriminated `kind` union of 7 decision kinds, `health` default, `schemaVersion` literal); `provider.ts` adds `PresetId`, `PRESET_MODELS` allowlists, `ProviderSettings` (per-preset model check via `superRefine`, masked `keySuffix`), and `ConsentRecord` (`scope: "jev_test"`, canonical-HTTPS-origin `origin`, positive `consentVersion`). `src/db/database.ts` is a `BookmarksManagerDB` Dexie subclass at version 1 with tables `metadata` (`key`), `decisions` (`id,status,createdAt`), `consents` (`[scope+origin],acceptedAt`), `sentLog` (`++id,sentAt`), `keyMaterials` (`id`), plus row interfaces `MetadataEntry`, `SentLogEntry`, `KeyMaterialEntry`.
- **Files changed:** `src/schemas/{z,bookmark,decision,provider}.ts`, `src/db/database.ts`, `tests/unit/schemas.test.ts`, `tests/unit/database.test.ts`, `tests/fixtures/base-records.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** 6a1d6e1
- **Learnings:**
  - Zod 4.6.5: `.refine`/`.check` still run after a failed base check on the same schema (unlike Zod 3) — `new URL(value)` inside a refine after `z.url()` threw `TypeError` on bad input; wrap refines in try/catch. `z.config()` with no args returns the live config, so `z.config().jitless === true` is directly assertable.
  - `jev-latest` exists in both preset allowlists — cross-preset rejection tests must use preset-exclusive models (typesafe-only: `jev-preview`, `jev-1.13.0`; openrouter-only: `jev-1.13`, `typesafe/jev-1.13`).
  - fake-indexeddb 6.2.5 uses native `structuredClone` on insert/retrieve, and Node 22's `structuredClone` handles `CryptoKey` — a non-extractable AES-GCM key round-trips through Dexie+fake-indexeddb and stays usable (encrypt/decrypt verified, `exportKey` correctly rejects). Phase 2's CryptoKey-in-IndexedDB design is viable.
  - Dexie `add`/`put` writes a generated inbound key back onto the caller's object — reusing a fixture across `sentLog` adds smuggles in the previous auto-incremented `id` and throws `ConstraintError`. Always add fresh object copies.
  - `node:crypto`'s `webcrypto.CryptoKey` type is not assignable to DOM `CryptoKey` (Node's `KeyUsage` union is wider, e.g. `"decapsulateBits"`) — cast once in tests; runtime objects clone identically. Keep `KeyMaterialEntry.key` DOM-typed for extension code.
  - Under `verbatimModuleSyntax` + `noUncheckedIndexedAccess`, typing shared fixtures with `satisfies z.input<typeof Schema>` keeps them honest while letting `.default()` fields stay absent.
---

## [2026-09-25 16:57] - Phase 1 Task 3: Add store skeleton and CI compliance baseline
- **Implemented:** Five truthful `store/` docs for the current slice (permissions inventory, privacy policy + dashboard practices drafts, listing draft, reviewer notes — publisher identity/contact/policy URL/icons/screenshots marked as release prerequisites); `scripts/check-manifest.mjs` comparing generated manifest permission fields to parsed doc rows; `scripts/check-bundle.mjs` scanning emitted `.js`/`.html` for `eval(`, `new Function`, and remote `<script src>`; GitHub Actions CI running lint → typecheck → unit → build → both compliance checks → headed Playwright smoke under `xvfb-run`.
- **Files changed:** `store/{permissions,privacy-policy,privacy-practices,listing,reviewer-notes}.md`, `scripts/{check-manifest,check-bundle}.mjs`, `.github/workflows/ci.yml`, `tests/unit/compliance-scripts.test.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** aa4a4bd
- **Learnings:**
  - Testing `.mjs` CLI scripts from Vitest without typecheck friction: have each script guard its `main()` behind `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, accept argv/env path overrides, and drive it from tests with `spawnSync(process.execPath, [script, ...args])` — no `.mjs` import means `tsc` never sees the script (root tsconfig `include: ../**/*` would otherwise need `allowJs`), and exit code + stderr are directly assertable.
  - Permission-table parsing heuristic that holds: a markdown row is a permission row only when its second cell is exactly `required`/`optional` and its first cell is backtick-quoted; names containing `://` (or `<all_urls>`) are host patterns, everything else is a permission name. WXT omits `host_permissions`/`optional_permissions` keys entirely when empty — diff with `?? []`.
  - Bundle-scan regexes that avoid false positives: `\beval\s*\(` (word boundary stops `retrieval(` matching), `\bnew\s+Function\s*\(`, and `<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i` for remote-or-protocol-relative script tags only — `./app.js` and `/assets/x.js` pass.
  - Headed Playwright extension tests (`headless: false` for MV3 persistent context) need `xvfb-run -a` in CI; `xvfb` via `apt-get install -y xvfb` after `npx playwright install --with-deps chromium` covers both system deps and the display.
  - Store docs for an unfinished slice: state the release scope explicitly ("current slice only"), mark publisher identity, contact email, hosted privacy-policy URL, icons, and screenshots as release prerequisites rather than inventing values, and keep the Limited Use statement verbatim in the policy draft.
---

## [2026-09-25 10:25] - Phase 1 Task 4: Manual verification (user-approved) + Revision 1
- **Implemented:** Phase 1 verified by user; P1T3 review fix verified and closed; spec/plan revised to waive remaining manual gates — no code changes.
- **Files changed:** plan.md, spec.md, revisions.md (new, Revision 1), implement_state.json, handoff_20260925_100900.md (addendum)
- **Learnings:**
  - Context: User approved Phase 1 ("manual ok") and waived manual
    verification gates for the rest of the track — phase-end tasks are now
    automated evidence checkpoints (Revision 1, see `revisions.md`).
  - Gotcha: a "canceled" subagent dispatch may still complete — verify git log
    before assuming work was discarded (happened with the P1T3 fix, 4e355eb).
---

## [2026-09-25 10:49] - Phase 2 Task 1: Implement service-worker-only encrypted provider keys
- **Implemented:** `src/security/keys.ts` — worker-only `saveProviderKey`/`readProviderKey`/`deleteProviderKey` plus `ProviderKeyError` (`code: "reconnect"`). Non-extractable AES-GCM 256 `CryptoKey` per preset in Dexie `keyMaterials` under `provider:<preset>`; ciphertext envelope `{v: 1, iv, ct}` (base64, fresh 12-byte IV per save, validated by a jitless `KeyEnvelope` schema) in `chrome.storage.local` under `providerKey:<preset>`. `read` returns `null` only when no ciphertext exists; malformed envelopes, decrypt failures, and missing/unusable CryptoKeys throw `ProviderKeyError` with no key material in messages. `keySuffix` persistence intentionally left to the Options flow task.
- **Files changed:** `src/security/keys.ts`, `tests/unit/keys.test.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Learnings:**
  - `chrome` is not a global value binding: `@types/chrome` declares `namespace chrome`, `Window.chrome`, and `var browser`, but no `var chrome`. WXT's `wxt/browser` just exports `globalThis.chrome` captured at module eval — too early for `vi.stubGlobal` in tests. Declaring a minimal `declare const chrome: { storage: { local: ... } }` inside the module keeps runtime access lazy and stub-friendly.
  - TS ESNext lib types `Uint8Array` generically: `Uint8Array<ArrayBufferLike>` is not a `BufferSource` for `subtle.decrypt` — annotate `Uint8Array<ArrayBuffer>` on decode helpers.
  - jsdom's `crypto` has `getRandomValues` but no `subtle`; `vi.stubGlobal("crypto", webcrypto)` in `beforeEach` supplies Node's WebCrypto — works because `keys.ts` touches `crypto` only at call time.
  - In-memory `chrome.storage.local` stub pattern: keep `store` + `writes` (structured-clone snapshots of every `set`) so `JSON.stringify(writes)` plaintext assertions cover everything ever written.
---

## [2026-09-25 11:03] - Phase 2 Task 2: Define preset destinations and versioned consent records
- **Implemented:** `src/net/presets.ts` exports `PRESETS` — a deeply frozen registry (runtime `Object.freeze` + `as const`) keyed by `PresetId` with `origin`, full System One `url`, Chrome `permissionPattern`, and `models` shared from `PRESET_MODELS`: TypeSafe `https://api.typesafe.ai/v1/systemone` under `https://api.typesafe.ai/*`, OpenRouter `https://openrouter.ai/api/v1/systemone` under `https://openrouter.ai/*`. `resolvePreset` runs `PresetId.parse` so untrusted ids throw a ZodError instead of `undefined`-indexing. `src/consent/records.ts` exports `CONSENT_VERSION = 1` plus `grantTestConsent` (Dexie `put` upsert over `[scope+origin]`, refreshes `acceptedAt`), `revokeTestConsent` (`delete` by compound key), and `hasTestConsent` (explicit scope + origin + `consentVersion === CONSENT_VERSION` comparison — stale versions fail).
- **Files changed:** `src/consent/records.ts`, `src/net/presets.ts`, `tests/unit/consent.test.ts`, `tests/unit/presets.test.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** feat(consent): Define preset grants
- **Learnings:**
  - `Object.freeze({...} as const) satisfies Readonly<Record<PresetId, PresetDestination>>` layers runtime immutability on top of type-level readonly. Freezing `PRESET_MODELS.<preset>` inside `presets.ts` mutates the shared schema constant — safe here because its declared type is already `readonly`, and it lets tests assert `Object.isFrozen` on `models` (frozen arrays throw on `push` in strict mode).
  - Casting a readonly tuple to mutable for a strict-mode-throw test needs `as unknown as string[]` — `readonly [...]` is *not* comparable to `string[]` under `as` (TS2352). Readonly object *properties* cast to mutable with a plain `as` just fine.
  - `PresetId` doubles as a runtime guard: `PresetId.parse(preset)` inside `resolvePreset` makes "unknown preset rejects" testable even though the parameter is typed `PresetId` — all three consent entry points reject `"anthropic"` and leave zero rows.
  - For an inbound compound key like `consents: "[scope+origin]"`, `db.consents.put` is the upsert — unlike `add`, re-granting refreshes `acceptedAt` with no `ConstraintError`. Tests seed stale-version or foreign-scope rows by `put`ing object literals cast `as ConsentRecord` (widened `scope: string` keeps the cast comparable — no `as unknown` needed).
  - Compound-key `get([scope, origin])` can only return rows whose key-path fields match the query, so the extra scope/origin equality checks in `hasTestConsent` are belt-and-suspenders; the load-bearing check is `consentVersion === CONSENT_VERSION` for stale grants.
---

## [2026-09-25 11:22] - Phase 2 Task 3: Enforce versioned consent and permission in the network gate
- **Implemented:** `src/net/send.ts` — the sole consented egress point. `sendConsentedTest(preset, model)` gates in order: `resolvePreset` (ZodError on unknown id) → model in the preset allowlist → `https:` URL whose `origin` equals the registry origin → `hasTestConsent` (versioned `jev_test` grant) → `chrome.permissions.contains({ origins: [permissionPattern] })` (fail-closed on API errors) → `readProviderKey` (`null` → `no_key`; `ProviderKeyError` propagates unwrapped). Only then `fetch(url, { method: "POST", credentials: "omit", redirect: "error", headers: exactly { Authorization: Bearer, Content-Type: application/json }, body: fixed synthetic JSON })`. `NetworkGateError` carries `code` ∈ `unlisted_model | https_only | unlisted_origin | no_consent | no_permission | no_key | transport`; messages hold preset/model names only — never keys, bodies, or responses. Raw `Response` returned for any HTTP status; `opaqueredirect` responses rejected as `transport`. A `sentLog` row (`sentAt` ISO, `destination` = origin, `feature` = `"jev_test"`, `fieldNames` = `["model","state","questions"]`) is written only after `fetch` resolves.
- **Files changed:** `src/net/send.ts`, `tests/unit/network-gate.test.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** feat(net): Gate provider requests on consent
- **Learnings:**
  - To exercise the registry self-checks (`https_only`/`unlisted_origin`) that frozen `PRESETS` can never fail on its own, use `vi.resetModules()` + `vi.doMock("../../src/net/presets", factory)` + a dynamic `await import("../../src/net/send")` — the doMock registration covers both `./presets` and `../net/presets` specifiers in the re-imported graph, and the hoisted `vi.mock` for `security/keys` still applies (its fresh `readProviderKey` vi.fn is a different object, only fine because the URL checks fail before key access).
  - Mocking `readProviderKey` via `vi.mock(path, async (importOriginal) => ({ ...actual, readProviderKey: vi.fn() }))` keeps `ProviderKeyError` real for propagation assertions while removing the CryptoKey/webcrypto setup the gate doesn't need.
  - jsdom under Vitest keeps Node's undici `Response`/`fetch` globals — `new Response(body, { status })` works directly in tests, and `response.type` is `"default"` (never `"opaqueredirect"`), so redirect-refusal is asserted on `redirect: "error"` in init plus a synthetic opaqueredirect response.
  - A shared "expect gate block" helper asserting `fetchSpy` never called breaks down for transport and post-revocation cases where fetch *was* legitimately invoked earlier — assert call *counts* (`toHaveBeenCalledTimes`) or inline the assertions there instead.
  - `fieldNames: Object.keys(request)` over an `as const` literal yields `["model","state","questions"]` in insertion order — records exactly what was sent rather than a parallel constant.
---

## [2026-09-25 11:42] - Phase 2 Task 4: Build the Options consent, permission, and revocation flow
- **Implemented:** `src/messages/provider.ts` — `ProviderMessage` Zod discriminated union (`ENABLE_PROVIDER`/`REVOKE_PROVIDER`/`PROVIDER_STATUS`) plus `ProviderStatus`/`ProviderMessageResult` result schemas and a total `handleProviderMessage(message, sender)` that returns `{ok:true,status}` or `{ok:false,code,message}` — never throws. Sender trust is `sender.url === chrome.runtime.getURL("options.html")` (WXT emits `options.html`). Enable re-checks the model allowlist and `chrome.permissions.contains` in the worker (never trusting the page), computes `keySuffix` = last 4 chars in the worker, then writes `metadata` settings → `saveProviderKey` → `grantTestConsent`; any persistence failure runs a best-effort unwind (consent row + key + settings) so nothing appears enabled without consent. Revoke removes consent first (a failed delete halts the whole revoke), then `chrome.permissions.remove` (post-check via `contains` so an already-absent grant counts as released), then settings, then the key only when `deleteKey` was chosen; post-consent failures still return `revoke_failed` with consent already gone so the gate blocks. `background.ts` wires the handler via `onMessage` + `return true` (channel stays open for the async `sendResponse`). `src/consent/disclosure.ts` holds the §13.5 copy as typed constants (origins sourced from `PRESETS` so they can't drift). `ProviderSetup.tsx` calls `chrome.permissions.request` synchronously in the Enable click (user gesture), validates outbound + inbound messages with the shared schemas, and drops the raw key on success. `PrivacyDraft.tsx` bundles `store/privacy-policy.md` via `?raw` — zero network. `store/privacy-policy.md` updated only where the flow is now real (consent screen, permission prompt, key protection, revocation); the Test connection send stays hedged.
- **Files changed:** `src/consent/disclosure.ts`, `src/messages/provider.ts`, `src/entrypoints/options/{ProviderSetup,PrivacyDraft,main}.tsx`, `src/entrypoints/background.ts`, `store/privacy-policy.md`, `tests/components/provider-setup.test.tsx`, `tests/unit/provider-messages.test.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** feat(consent): Add provider permission flow
- **Learnings:**
  - `z.discriminatedUnion` in Zod 4 works on a boolean literal discriminator (`z.literal(true/false)` on `ok`) — a typed `{ok:true,status}|{ok:false,code,message}` result channel needs no error-throwing protocol. Zod `.parse` also doubles as the outbound message validator on the page.
  - RTL under Vitest with `globals: false`: its auto `beforeAll`/`afterEach` setup never registers, so set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually. `@testing-library/jest-dom` is NOT installed — assert DOM state with `.disabled`/`.checked`/`.textContent`/`toBeTruthy()`, not jest-dom matchers.
  - `getByText` matches only direct text-node children per element but still throws on multiple matches — phrases repeated across the disclosure (`TypeSafe`, the origin) need `getAllByText`; prefer `findByRole` with `aria-label`/`role="group"` over text regexes that can hit unrelated bundled copy (the privacy `<pre>` contains the word "enabled").
  - `react-hooks` v7 `set-state-in-effect` rejects synchronous setState in an effect body *and* synchronously-called functions that set state — wrap the kickoff in `queueMicrotask` (the subscription idiom) and keep resets in the change handler. A `useRef` reentrancy flag covers what `busy` state can't (a double click in one batch reads stale state).
  - To force a real Dexie write failure mid-flow without mocking consent helpers, `vi.spyOn(db.consents, "put").mockRejectedValueOnce(...)` works — `mockRestore` afterwards keeps the rest of the suite on the real table.
  - `import "*.md?raw"` from an entrypoint resolves repo-root files outside `srcDir` fine (Vite `vite/client` types + WXT bundling); the emitted options chunk contains the text and no `fetch`.
---

## [2026-09-25 12:30] - Phase 2 Task 5: Automated phase verification 'Protected Keys, Consent, and Network Gate' *(manual gate waived — Revision 1)*
- **Implemented:** Automated evidence checkpoint — no code changes. Full local
  gate run on the completed Phase 2 tree.
- **Evidence:**
  - `npm run lint` — clean (eslint flat config, fetch-restriction rules intact).
  - `npm run typecheck` — `wxt prepare && tsc --noEmit` clean.
  - `npm run test -- --run` — **194/194** unit+component tests pass (schemas, database, keys, consent, presets, network-gate, provider-messages, provider-setup components, compliance scripts, scaffold).
  - `npm run build` — WXT build clean; manifest permissions `["storage","sidePanel"]`, optional hosts exactly the two Jev origins.
  - `npm run check:manifest` — OK, generated manifest matches `store/permissions.md`.
  - `npm run check:bundle` — OK, no `eval(`/`new Function`/remote `<script src>` in the bundle.
  - `xvfb-run -a npm run test:e2e` — 1/1 headed Chromium extension-load smoke passes.
  - `rg 'fetch\(' src` — sole call is `src/net/send.ts:172`.
- **Files changed:** plan.md, learnings.md, implement_state.json (checkpoint only).
- **Learnings:**
  - Context: Phase 2 delivered worker-only AES-GCM key storage (keys.ts), the frozen preset registry + versioned consent records, the single egress gate (send.ts), and the Options enable/revoke flow with a total worker message handler. Per-task subagent reviews ran; one Important fix (short-key keySuffix leak) landed and was re-verified.
  - Environment gotcha: `npm ci` does not install Playwright browsers — a fresh env needs `npx playwright install chromium` before `test:e2e` works.
  - Pattern worth elevating: lazy module-scoped `declare const chrome: {<slice>}` keeps `vi.stubGlobal("chrome", ...)` working and gives each module exactly the API surface it needs (keys.ts used it for storage.local, send.ts for permissions, provider.ts for permissions+runtime).
---

## [2026-09-25 12:31] - Phase 3 Task 1: Validate Jev wire data and implement the synthetic connection test
- **Implemented:** `src/jev/wire.ts` — the PROJECT_PLAN.md §8.2 wire schemas verbatim (jitless `z` via `src/schemas/z.ts`): the `Text` union (`string | Record<string, json> | json[]`), `NoulQuestion` (optional `{true,false}` criteria), `ChoiceQuestion` (required criteria map refined to 2–255 keys), `ScoreQuestion` (criteria array 2–10), the `Question` and `Answer` discriminated unions (`noul` 0–1, `choice` + probabilities/confidence, `score` + legend/probabilities/confidence), `SystemOneRequest` (`model`/`state`/`questions`), and `SystemOneResponse` (`model`, `answers`, int `usage` with optional `cost`, optional OpenRouter `id`/`provider`) — plus `makeSyntheticRequest(model)` returning the fixed `jev_test` payload. `src/jev/connection.ts` — `testJevConnection(preset, model)` delegates transport to `sendConsentedTest`, throws `JevConnectionError` (`auth`/`incompatible`/`retry_later`/`invalid_response`/`http_error`/`gate`), maps 401→auth, 422→incompatible, 429/529→retry_later, other non-2xx→http_error (status number only, body never read), JSON/schema/missing-or-wrong-type `test` answer→invalid_response, `NetworkGateError`→`gate` (message preserved); success returns `{model: response's versioned id, latencyMs around the gate call, cost when usage.cost is present}`. `src/net/send.ts` now imports the factory and runs `SystemOneRequest.parse` on it before `fetch` — every other gate behavior (check order, headers, audit `fieldNames` `["model","state","questions"]` derived from the parsed request) is unchanged.
- **Files changed:** `src/jev/wire.ts`, `src/jev/connection.ts`, `src/net/send.ts`, `tests/unit/jev-wire.test.ts`, `tests/unit/jev-connection.test.ts`, `tests/fixtures/jev-responses.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** feat(jev): Add synthetic connection test
- **Learnings:**
  - The §8.2 "missing or mismatched answer" failure is deliberately *not* schema-level: `SystemOneResponse` parses `{answers: {unrelated: ...}}` and a `choice`-typed `test` answer fine — the client-level `answers["test"].type === "noul"` check is what fails (Pydantic AI's `UnexpectedModelBehavior` analogue). Fixtures must therefore include schema-valid-but-mismatched bodies, and tests should assert both layers separately.
  - For HTTP error mapping, never `await response.json()` on non-2xx — checking `response.status` before reading the body structurally guarantees no response content can leak into `JevConnectionError` messages; only the status number is interpolated.
  - `vi.mock("../../src/net/send", async (importOriginal) => ({...actual, sendConsentedTest: vi.fn()}))` keeps `NetworkGateError` real so `instanceof` propagation to `code: "gate"` is asserted against the genuine class — same house pattern as mocking `readProviderKey`.
  - Zod v4 object `.parse` emits keys in schema-definition order (`model`, `state`, `questions`), so `Object.keys(parsedRequest)` keeps the audit `fieldNames` honest after the factory move — a schema-authored body can't smuggle extra top-level fields past the sent log either (strip-mode drops them at parse).
  - jsdom/Vitest keeps undici `Response`: `new Response("not json", {status: 200}).json()` rejects with a real `SyntaxError` — malformed-JSON coverage needs no stub.
---

---

## [2026-09-25 13:05] - Phase 3 Task 2: Wire Test connection into Options and cover failure states
- **Implemented:** `src/messages/provider.ts` — `TEST_PROVIDER` joins the `ProviderMessage` discriminated union as `z.object({ type: z.literal("TEST_PROVIDER"), preset: PresetId })` (preset only — a `model` key smuggled into a message is stripped by Zod and ignored; the stored `ProviderSettings.model` is always tested). `ProviderErrorCode` gains `not_enabled` plus the six `JevConnectionError` codes (`auth`/`incompatible`/`retry_later`/`invalid_response`/`http_error`/`gate`). New `ProviderTestResult` schema (`{model, latencyMs, cost?}`); `ProviderMessageResult` is now a `z.union` of three shapes because `z.discriminatedUnion("ok")` rejects duplicate `true` discriminator values and non-object options — status replies keep `{ok:true,status}`, test replies carry `{ok:true,code:"test_ok",result}`. `testProvider` re-runs `readStatus` and refuses `{ok:false,code:"not_enabled"}` when `enabled` is false BEFORE `testJevConnection` is invoked — missing settings, revoked consent, or a permission dropped outside the app never touch transport. Failures map `JevConnectionError` code/message verbatim (already redacted), stray `NetworkGateError` → `gate` with its message, everything else (`ProviderKeyError`, non-Error rejections) → static `internal_error`. `ProviderSetup.tsx` renders a Test connection button inside the enabled panel only; one `TEST_PROVIDER` sendMessage per click (`busy`/`inFlight` guard collapses double clicks and blocks revoke mid-test); success shows returned model + rounded latency + `$cost` when present; failure shows `(code): message` verbatim via `role="alert"`. Stale replies for a switched-away preset are dropped via the `currentPreset` ref. `background.ts` doc comment notes TEST_PROVIDER is the only egress-producing variant (no code change needed — the adapter is message-agnostic).
- **Files changed:** `src/messages/provider.ts`, `src/entrypoints/background.ts`, `src/entrypoints/options/ProviderSetup.tsx`, `tests/unit/connection-message.test.ts`, `tests/components/test-connection.test.tsx`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** feat(options): Test configured Jev providers
- **Learnings:**
  - Zod 4 `z.discriminatedUnion` requires each option to be an object with a *unique* discriminator literal — two `ok: z.literal(true)` options throw `Duplicate discriminator value "true"`, and a `z.union` option throws `Invalid discriminated union option`. Two success wire shapes sharing `ok: true` therefore need a plain `z.union`; readers narrow with `"status" in data` / `"result" in data` (the `in` check is what discriminates the ok:true variants at type level).
  - When a union loses its discriminator-based narrowing, reorder UI checks to `!result.data.ok` FIRST (failure branch) then `"status" in result.data` — checking `data.ok` first leaves `.status`/`.message` ambiguous to tsc across the remaining union members.
  - A button whose accessible name flips while busy ("Test connection" → "Testing…") breaks `getByRole({name})` re-query — capture the element handle before `fireEvent.click` (the DOM node persists across React re-renders) or query by the busy name explicitly.
  - Vitest `it.each` tuples keep literal types only when the array itself is typed — declare `const cases: [ProviderErrorCode, string][] = [...]` rather than relying on inference, which widens `code` to `string` and fails assignment to the enum-typed message result.
  - `vi.mock("../../src/jev/connection", async (importOriginal) => ({...actual, testJevConnection: vi.fn()}))` isolates the message layer from transport while keeping `JevConnectionError` real for verbatim code/message mapping assertions — the "one synthetic request" contract is then just `toHaveBeenCalledTimes(1)` on the mock plus `fetch` never being touched.
---

## [2026-09-25 14:53] - Phase 3 Task 3: Harden CI and browser privacy checks
- **Implemented:** `check-bundle.mjs` now matches the whole file text instead of scanning line-by-line — `/g` patterns iterate every `matchAll` occurrence, `\s` spans newlines, so `eval\n(`, `new\nFunction(`, and `<script ... src="https://...">` tags wrapped over lines are all caught; violations report file:line of the match start (offset→line via a lineStarts binary search) and the snippet flattens the entire matched span so remote URLs stay visible. `check-manifest.mjs` needed no logic change — its exact `required`/`optional` level check already ignores "not requested" rows — the header contract now documents that explicitly and the fixture doc gained a "Not requested" section (a `| \`bookmarks\` | not requested |` row plus prose backticked names) so the guard is exercised, not assumed. The e2e smoke records every `^https?://` request on the persistent context across service-worker start plus all three surfaces, quietens via `networkidle`, and asserts zero outbound URLs AFTER `context.close()` so teardown traffic is observed too; `E2E_HEADLESS=1` opts into headless and a top-level `existsSync(extensionDir)` fails fast with a build hint. CI gained `push: branches: [main]` and `timeout-minutes: 20`; job order was already install→lint→typecheck→unit→build→check:manifest→check:bundle→e2e under xvfb.
- **Files changed:** `scripts/check-bundle.mjs`, `scripts/check-manifest.mjs`, `.github/workflows/ci.yml`, `tests/unit/compliance-scripts.test.ts`, `tests/e2e/shell.spec.ts`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** chore(ci): Guard extension bundle and traffic
- **Learnings:**
  - Line-based banned-construct scanning is trivially evadable by wrapping the construct over two lines — `eval(` split as `eval\n(` misses on both lines, and a `<script` tag's `src=` on a later line never sees `<script`. Match the joined file text with `/g` + `matchAll`, then map the match index back to a line for reporting; `[^>]*` in the script-tag pattern already spans newlines, so whole-file matching can't cross a `>` tag boundary anyway.
  - When the required output is "name the offender" (e.g. the remote URL), the match itself can end before it — `src="https://` is the regex's end, not the host. Snippet the full span of lines the match covers, not just `match[0]`, or the report names nothing actionable.
  - `String.prototype.matchAll` internally clones the regex, so module-level `/g` patterns stay reusable across files with no `lastIndex` bookkeeping.
  - Playwright `context.on("request")` sees page- and service-worker-issued requests on the persistent context; asserting zero `^https?://` URLs passes cleanly under xvfb — Playwright's launch flags suppress Chromium background networking, so no noise filtering beyond non-http(s) schemes is needed. Assert AFTER `context.close()` to also cover unload/teardown requests.
  - A negative fixture that can't fail is worse than none: the inherited `bookmarks` test passed only because the permission was entirely absent from the fixture doc, not because a "not requested" row was ignored — the fixture needs the informational row (and a prose-name line) actually present to probe the parser's level check.

## [2026-09-25 15:10] - Phase 3 Task 4: Align store disclosures with the completed test flow
- **Implemented:** All five `store/` docs now describe the shipped `jev_test` flow instead of hedging it as "being built". `permissions.md`: the `storage` justification now names its actual sole use — encrypted provider key envelopes in `chrome.storage.local` (IndexedDB holds settings/consent/key material and needs no permission) — and the optional-host preamble describes the real Enable-click → `chrome.permissions.request` path; the table rows themselves already matched the manifest and were left untouched. `privacy-policy.md`: summary/data-sent/API-keys/security sections switched from future tense to the implemented flow — `model`/`state`/`questions` synthetic payload, `Authorization: Bearer`, cookies omitted/redirects refused, metadata-only sent log, versioned `jev_test` consent, masked last-four suffix with `****` placeholder for short keys; Limited Use statement kept verbatim; publisher identity/contact/hosted URL stay release prerequisites; provider privacy links stay flagged for verification. `privacy-practices.md`: single-purpose and data-usage answers now declare the key transmission on Test click (authentication info: yes) and everything else not collected. `listing.md`: short/full description rewritten as a foundation release that does not manage, search, or tag bookmarks yet, with the provider test described as it ships. `reviewer-notes.md`: real test instructions (disclosure → unchecked consent → Enable click → permission prompt → one synthetic POST per Test click → revoke) plus the redacted error-code list and the sent-log/key-storage facts.
- **Files changed:** `store/{permissions,privacy-policy,privacy-practices,listing,reviewer-notes}.md`, `conductor/tracks/phase0_foundation_20260925/plan.md`, `conductor/tracks/phase0_foundation_20260925/learnings.md`
- **Commit:** docs(store): Align provider test disclosures
- **Learnings:**
  - Justification drift check that paid off: `chrome.storage.local` is written by exactly one module (`keys.ts`, ciphertext envelopes only) — settings, consent records, sentLog, and CryptoKeys all live in IndexedDB, which needs no `storage` permission. A justification naming "settings and consent records" quietly misattributed the permission's real use; grep the actual API calls before trusting inherited wording.
  - Spot-check contract for docs-vs-disclosure agreement: recipient names (TypeSafe/OpenRouter), literal origins (`https://api.typesafe.ai`, `https://openrouter.ai`), fields (`model`, `state`, `questions`), `Authorization` header, and trigger ("only when you click Test connection — never on install, page load, background, or enable") must match `src/consent/disclosure.ts` constants nearly verbatim.
  - Keep hedges only where behavior is genuinely unreal: provider privacy-policy URLs unverified (flagged), publisher identity/contact/hosted policy URL (release prerequisites — never invented). Everything else must describe shipped behavior.
---

## [2026-09-25 15:25] - Phase 3 Task 5: Automated phase verification 'Synthetic Jev Test and Compliance Checks' *(manual gate waived — Revision 1)*
- **Implemented:** Automated evidence checkpoint — no code changes. Full local
  gate run on the completed Phase 3 tree (track's final phase).
- **Evidence:**
  - `npm run lint` — clean.
  - `npm run typecheck` — `wxt prepare && tsc --noEmit` clean.
  - `npm run test -- --run` — **289/289** unit+component tests pass (14 files).
  - `npm run build` — clean; manifest still `["storage","sidePanel"]` + the two optional Jev origins.
  - `npm run check:manifest` — OK, matches `store/permissions.md`.
  - `npm run check:bundle` — OK, whole-file scan: no `eval(`/`new Function`/remote `<script src>`.
  - `xvfb-run -a npm run test:e2e` — headed Chromium smoke passes AND asserts zero http(s) requests on a fresh install (3/4 runs green; one 30s timeout was a cold-profile service-worker start flake).
  - `rg 'fetch\(' src` — sole call remains `src/net/send.ts`.
  - Mock TypeSafe/OpenRouter test coverage exists via `tests/unit/jev-wire.test.ts`, `jev-connection.test.ts`, and `tests/fixtures/jev-responses.ts` — no real-key automated test (spec-compliant).
- **Files changed:** plan.md, learnings.md, implement_state.json (checkpoint only).
- **Learnings:**
  - Context: Phase 3 delivered §8.2 wire schemas + `makeSyntheticRequest`, `testJevConnection` with coded redacted errors, `TEST_PROVIDER` wiring to a click-only Options button, hardened line-split-proof bundle scanning, and truthful store disclosures.
  - Gotcha: the e2e zero-request assertion can flake once on a cold profile (service-worker start >30s); subsequent runs settle ~2s. If it recurs in CI, consider `test.setTimeout` for that spec — deferred to final review triage.
  - Pattern worth elevating: total handler returning `{ok:true,...}|{ok:false,code,message}` over a Zod union beats thrown-error protocols for `runtime.onMessage` — every failure is typed and testable.
---
