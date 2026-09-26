# Codebase Patterns

Reusable patterns discovered during development. Read this before starting new work.

## Code Conventions

No application code exists yet.

## Architecture

The planned architecture is documented in `PROJECT_PLAN.md` and `conductor/tech-stack.md`; verify patterns against the implementation as it evolves.

## Gotchas

The repository has an existing Beads workspace. Do not reinitialize it or automatically sync it to the remote.

## Testing

The testing approach is planned in `conductor/workflow.md`; no test suite exists yet.

---

Last refreshed: 2026-09-25

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
