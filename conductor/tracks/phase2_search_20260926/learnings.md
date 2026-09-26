# Track Learnings: phase2_search_20260926

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list: `conductor/patterns.md`. The ones most relevant to search:

- Import `z` only from `src/schemas/z.ts` (jitless, MV3 CSP); `check:bundle` must stay green after adding `minisearch`.
- Lazy `declare const chrome` slices throw synchronously when a surface is absent or partial — wrap every caller boundary (omnibox registration, tabs calls) and test absent AND partial surfaces. Registration is all-or-nothing with cleanup.
- Handlers are total: return `{ok:true,…} | {ok:false,code,message}` unions; never leak exception `cause` objects.
- `src/entrypoints/sidepanel/views.ts` is pure; drop slots are only meaningful in tree-ordered views (`all`/`folder`) — a `search` view must keep them off.
- dnd-kit keyboard events bubble into app key handlers — guard `/` and Ctrl/Cmd+K handlers with `if (event.defaultPrevented) return;` and skip when focus is in a text field.
- Cross-surface state needs live subscriptions, not mount-time reads (an already-open panel never remounts).
- RTL conventions (`globals: false`): set `IS_REACT_ACT_ENVIRONMENT`, call `cleanup()` manually, prefer `findByRole`; `waitFor` async outcomes before asserting "nothing changed".
- Egress assertions filter OUT internal schemes (`chrome-extension:`, `chrome:`, `data:`, `blob:`, `about:`) and run after `context.close()`.
- Playwright e2e uses `channel: "chromium"`; headed under `xvfb-run -a`.
- Any new manifest key needs a manifest test and matching `store/` docs in the same change.

---

<!-- Learnings from implementation will be appended below -->
