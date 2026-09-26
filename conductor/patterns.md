<!-- Last refreshed: 2026-09-26 -->

# Codebase Patterns

Reusable patterns discovered during development. Read this before starting new work.

## Code Conventions

- Strict TypeScript under `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; ESLint flat config via `npm run lint`.
- All Zod imports go through the jitless-configured `src/schemas/z.ts` — never import `zod` directly (MV3 CSP).
- `fetch` is ESLint-banned outside `src/net/**`; all provider traffic goes through the `src/net/send.ts` consent gate.
- `runtime.onMessage` handlers are total: return `{ok:true,…} | {ok:false,code,message}` Zod unions, never throw (see elevated patterns).

## Architecture

Phase 0 (`phase0_foundation_20260925`) delivered: MV3 WXT scaffold (background service worker + popup/sidepanel/options React surfaces), Zod schemas mirroring `PROJECT_PLAN.md` §7, Dexie v1 database, WebCrypto provider-key store, versioned consent records + disclosure strings, consent-gated network module, Jev `/v1/systemone` wire client with a synthetic connection test wired to Options, and store-compliance docs guarded by `check:manifest`/`check:bundle` in CI. Still planned (not installed): Zustand, TanStack Query, shadcn/ui, MiniSearch, `@mozilla/readability`.

## Gotchas

- The repository has an existing Beads workspace. Do not reinitialize it or automatically sync it to the remote.
- `bd` warns `beads.role not configured (GH#2950)` until `git config beads.role maintainer|contributor` is set — cosmetic, not blocking.
- `chrome.storage.local` is written by exactly one module (`src/security/keys.ts`, ciphertext envelopes); settings/consent/sentLog/CryptoKeys live in IndexedDB and need no `storage` permission — keep `store/permissions.md` justifications aligned with actual call sites.

## Testing

- Vitest 5 suites: `tests/unit` (12 files), `tests/components` (RTL, `globals: false` — set `IS_REACT_ACT_ENVIRONMENT` and call `cleanup()` manually), shared `tests/fixtures`.
- Playwright headed persistent-context smoke in `tests/e2e` (`channel: "chromium"`, not branded Chrome; `E2E_HEADLESS=1` to opt into headless).
- Full local gate mirrors CI: `lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` → `check:bundle` → `xvfb-run -a test:e2e`.

---

Last refreshed: 2026-09-26

---

## Elevated from track `phase0_foundation_20260925` (2026-09-25)

- **Message handlers are total, not throwing.** A `runtime.onMessage` handler returns `{ok:true,…} | {ok:false,code,message}` as a Zod union validated on both ends; every failure is typed, redacted, and testable. Never let handler exceptions leak `cause` objects that can embed response bodies (SyntaxError/ZodError do).
- **Fail-closed gates re-verify per call.** The network gate re-checks preset→model→https→origin→consent→host-permission→key on every send, and tests assert dependency-spy call counts to prove earlier failures short-circuit before later checks (and before the key store is even touched).
- **Mutation ordering for irreversible pairs.** Enable writes settings→key→consent (consent last, with an unwind on failure); revoke removes consent first so a later failure still blocks the gate.
- **WebCrypto key storage:** non-extractable AES-GCM-256 `CryptoKey` persists in IndexedDB via structured clone; ciphertext+12-byte IV envelope in `chrome.storage.local`. Assert plaintext-absence in storage-write tests, not just encryption correctness.
- **MV3 CSP + Zod:** single jitless import site `src/schemas/z.ts`; every schema file imports from there.
- **Bundle scanners must scan normalized whole-file content, not lines** — `eval\n(` and multi-line `<script src>` evade line-based regexes.
- **Testing `chrome.*` globals in Vitest:** a `declare const chrome` slice keeps `vi.stubGlobal` workable without fighting the DOM lib.
- **Playwright extension smoke:** persistent context + `waitForEvent("serviceworker")`; cold-profile SW registration can exceed 30s — set a spec-level timeout rather than weakening waits; `networkidle` settles ~2s on extension pages but is not the reliable signal.

_Last refreshed: 2026-09-25_

## Elevated at archive — track `phase0_foundation_20260925` (archived 2026-09-25)

- Zod 4 `.refine`/`.check` still run after a failed base check on the same schema — wrap throwing ops like `new URL()` inside refines in try/catch. (from: phase0_foundation_20260925)
- Dexie `add`/`put` writes a generated inbound key back onto the caller's object — reuse of a fixture smuggles in a stale `id` and throws `ConstraintError`. Always add fresh object copies. (from: phase0_foundation_20260925)
- Testing `.mjs` CLI scripts: guard `main()` behind `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, accept argv/env path overrides, drive tests via `spawnSync(process.execPath, [script, ...])` — `tsc` never sees the script and exit code/stderr assert directly. (from: phase0_foundation_20260925)
- `vi.mock(path, async (importOriginal) => ({ ...actual, dep: vi.fn() }))` stubs one export while keeping real error classes for `instanceof` propagation assertions. (from: phase0_foundation_20260925)
- `vi.resetModules()` + `vi.doMock(module, factory)` + a dynamic `await import` exercises defensive self-checks that frozen registries can never trip at runtime — the doMock covers both specifier spellings in the re-imported graph. (from: phase0_foundation_20260925)
- Never read a response body on non-2xx — check `response.status` first so provider content structurally cannot leak into error messages. (from: phase0_foundation_20260925)
- Zod: `z.discriminatedUnion` requires a unique discriminator literal per option — two `ok: z.literal(true)` success shapes need a plain `z.union` and `"key" in data` narrowing; `.parse` emits keys in schema-definition order, so `Object.keys(parsed)` makes audit `fieldNames` honest. (from: phase0_foundation_20260925)
- `chrome.permissions.request` requires a user gesture — call it synchronously in the click handler, not after an await. Trusted-page check: `sender.url === chrome.runtime.getURL("options.html")` — Chrome sets `sender.url`, not the sender. (from: phase0_foundation_20260925)
- A negative fixture that can't fail is worse than none — the fixture must actually contain the ignored case (e.g. a "not requested" permission row) to prove the guard ignores it rather than never sees it. (from: phase0_foundation_20260925)
- Doc-drift discipline: grep the actual API call sites before trusting permission justifications (`chrome.storage.local` may be written by one module only); store disclosures must match `consent/disclosure.ts` constants (origins, field names, headers, trigger wording) nearly verbatim. (from: phase0_foundation_20260925)
- A "canceled" subagent dispatch may still complete — verify `git log` for landed commits before assuming work was discarded or re-dispatching. (from: phase0_foundation_20260925)
- RTL/Vitest conventions (`globals: false`): set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually; prefer `findByRole`/`aria-label` over text regexes that collide with repeated disclosure copy; capture the button handle before its accessible name flips busy ("Testing…"); type `it.each` tuple arrays explicitly (`const cases: [Code, string][]`) or literals widen to `string`. (from: phase0_foundation_20260925)

## Elevated at refresh — track `phase0_foundation_20260925` (refreshed 2026-09-26)

- Playwright extension tests must use `channel: "chromium"` — branded Google Chrome silently ignores `--load-extension`, so the persistent context never loads the built extension. (from: phase0_foundation_20260925)
- WXT scaffold specifics: a `sidepanel/` entrypoint emits `sidepanel.html` + the `side_panel` manifest key automatically; root `tsconfig.json` extends `.wxt/tsconfig.json` but must set `"jsx": "react-jsx"` itself. (from: phase0_foundation_20260925)
- Zero-egress e2e assertion: record `context.on("request")` on the persistent context and assert zero `^https?://` URLs AFTER `context.close()` so unload/teardown traffic is observed too. (from: phase0_foundation_20260925)
- Type shared fixtures with `satisfies z.input<typeof Schema>` under `verbatimModuleSyntax` + `noUncheckedIndexedAccess` — keeps fixtures honest while `.default()` fields stay absent. (from: phase0_foundation_20260925)
- Node's `webcrypto.CryptoKey` type is not assignable to the DOM `CryptoKey` (Node's `KeyUsage` union is wider) — cast once in tests; runtime objects structured-clone identically. (from: phase0_foundation_20260925)
