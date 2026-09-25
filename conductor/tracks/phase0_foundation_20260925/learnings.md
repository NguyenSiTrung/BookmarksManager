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
