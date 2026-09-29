# Track Learnings: options_redesign_20260929

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

- RTL/Vitest: `globals: false` — set `IS_REACT_ACT_ENVIRONMENT`, call
  `cleanup()` manually; `findByRole`/`aria-label` over text regexes because
  disclosure copy repeats across surfaces.
- react-hooks eslint bans setState in effects — the existing components use
  `queueMicrotask` subscription boundaries and render-phase adjustment; keep
  that style when restructuring.
- Lazy `declare const chrome` slices throw SYNCHRONOUSLY when absent — all
  worker-call boundaries already wrapped; preserve the wrappers.
- Consent/stale-read discipline: `useLiveQuery` emissions may arrive tagged
  for a stale preset (DecisionSettings `ConsentRead` pattern) — preserve the
  preset-tagged read when moving consent UI between panels.
- `chrome.permissions.request` must stay synchronous inside the click
  handler — never move it behind an await or a helper that defers it.
- ESLint bans `fetch` outside `src/net/**`; icons are inline SVG (see
  `src/ui/components/settings-icon.tsx` precedent) — no icon dependency.

---

<!-- Learnings from implementation will be appended below -->
