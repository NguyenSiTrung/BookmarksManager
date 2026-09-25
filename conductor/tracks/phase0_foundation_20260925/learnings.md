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
- **Commit:** 8844dce
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
