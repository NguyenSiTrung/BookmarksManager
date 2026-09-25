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
