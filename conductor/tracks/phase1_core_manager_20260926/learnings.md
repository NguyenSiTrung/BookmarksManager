# Track Learnings: phase1_core_manager_20260926

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list: `conductor/patterns.md` (35 entries, elevated from `phase0_foundation_20260925`). The ones most relevant to this track:

- Import `z` only from `src/schemas/z.ts` (jitless, MV3 CSP); never from `zod` directly.
- `fetch` is ESLint-banned outside `src/net/**`; Phase 1 features must not need it at all.
- `runtime.onMessage` handlers are total: return `{ok:true,…} | {ok:false,code,message}` Zod unions, never throw or leak `cause` objects.
- Testing `chrome.*` in Vitest: a `declare const chrome` slice keeps `vi.stubGlobal` workable without fighting the DOM lib.
- Dexie `add`/`put` writes a generated inbound key back onto the caller's object; always write fresh object copies.
- Zod 4 `.refine`/`.check` still run after a failed base check; wrap throwing ops like `new URL()` in try/catch inside refines.
- Type shared fixtures with `satisfies z.input<typeof Schema>`; keeps `.default()` fields absent.
- `chrome.permissions.request` needs a user gesture: call it synchronously in the click handler.
- Keep `store/permissions.md` justifications aligned with actual call sites (grep before trusting docs); `check:manifest` compares it to the generated manifest.
- RTL with `globals: false`: set `globalThis.IS_REACT_ACT_ENVIRONMENT = true` and call `cleanup()` manually; prefer `findByRole`/`aria-label` queries.
- Playwright: `channel: "chromium"` (branded Chrome ignores `--load-extension`), persistent context + `waitForEvent("serviceworker")`, zero-egress assertions after `context.close()`.
- Bundle scanners scan normalized whole-file content, not lines.

---

<!-- Learnings from implementation will be appended below -->
