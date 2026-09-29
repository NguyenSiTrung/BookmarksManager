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

## Implementation learnings (2026-09-29)

- `<details>` used as a named region: put `role="region"` + `aria-label` on
  the inner content div, not the `<details>` element — jsdom renders closed
  `<details>` content to text queries but the role belongs to the wrapper.
- `findByText` returns the innermost element owning the text node — when a
  test asserts `role`/`id`/`aria-describedby` linkage on a warning, put those
  attributes on the element that directly wraps the text, not its parent.
- `chrome.runtime.getManifest()` throws (ReferenceError) under jsdom — guard
  it behind try/catch and render nothing when absent.
- `fieldNames`/cost-total style assertions: splitting a run-on sentence into
  stat tiles breaks `findByText(/600 input tokens/)` — update tests to query
  the labelled `dl` (`aria-label`) and assert tile values.
- `radix-ui` umbrella's `Switch` renders `button[role=switch]` with
  `aria-checked` — tests must use `getByRole("switch")` + `aria-checked`,
  not checkbox/`.checked`.
- `@font-face` urls in `styles.css` resolve through Vite into `.output`
  assets automatically when the woff2 sits under `src/` — no manifest or
  `web_accessible_resources` entry needed for extension pages.
