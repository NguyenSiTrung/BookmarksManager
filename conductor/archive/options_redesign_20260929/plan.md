<!-- Last refreshed: 2026-09-30 -->

# Options Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` (recommended) or `executing-plans` to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Options page into a guided four-panel settings surface
(Connections → Permissions → Activity → Data) with a distinctive visual
identity, without changing any behavior, message, consent record, or worker
call.

> Refresh reconciliation (2026-09-30): the mapped implementation/phase issues
> are closed and this track is archived. Its six manual-verification markers
> remain unchecked: recorded Chromium visual verification does not establish
> user acceptance for those individual checkpoints. Refresh does not approve
> them retroactively.

**Architecture:** Left icon rail with `hidden`-panel switching (all panels
mounted — form state preserved); a unified `Disclosure`/`Field`/`Switch`/
`Alert`/`StatusBadge`/`Chip`/`ProviderCard` component layer in options scope;
Geist Variable font vendored and scoped to `.options-root`; refined warm-neutral
+ teal-accent shadcn tokens scoped the same way.

**Tech Stack:** WXT MV3, TypeScript strict, React 19, Tailwind 4, radix-ui
1.6.7 umbrella (Switch available), Vitest 5 + Testing Library.

**Spec:** `conductor/archive/options_redesign_20260929/spec.md`

## Global Constraints

- Presentation only: no edits under `src/net`, `src/consent`, `src/messages`,
  `src/llm`, `src/jev`, `src/decisions`, `src/security`, `src/db`,
  `src/schemas`.
- Disclosure/consent copy and all consent-gating UI elements preserved verbatim.
- `chrome.permissions.request` stays synchronous inside click handlers.
- Panels switch via `hidden`, never unmount — form state survives navigation.
- Accessibility contract kept: one `h1`, `<main>`, `navigation` labeled
  "Options sections", `aria-current` on the active item, focus-visible rings.
- Palette/font scoped to `.options-root`; popup/sidepanel must not change.
- No new dependencies; icons are inline SVG; font is a vendored woff2.
- Per task: failing test → narrow red/green cycle → applicable gate → update
  this plan and `learnings.md` → local commit → `git notes add` → close the
  mapped Beads task. Never push, pull, fetch, or run `bd dolt push`.
- RTL conventions: `IS_REACT_ACT_ENVIRONMENT` + manual `cleanup()`;
  `findByRole`/`aria-label` over text regexes (disclosure copy repeats).

## Phase 1: Design system foundation
<!-- execution: parallel -->

- [x] Task 1: Vendor font + palette tokens
  <!-- files: src/entrypoints/options/fonts/, src/ui/styles.css, src/entrypoints/options/main.tsx -->
  - Download Geist Variable + Geist Mono Variable woff2 into
    `src/entrypoints/options/fonts/`; add `@font-face` (`font-display: swap`)
    and `.options-root` token overrides (warm neutrals, teal accent, tinted
    shadows, tabular-nums utility) in `src/ui/styles.css`; apply the class in
    `OptionsApp` root. Popup/sidepanel tokens untouched.
  - Verify: `build` succeeds; font lands in output assets; visual check.

- [x] Task 2: Icon set `src/ui/components/icons.tsx`
  <!-- files: src/ui/components/icons.tsx, tests/components/icons.test.tsx -->
  - Inline stroke SVG icon components (plug/connection, shield/permissions,
    pulse/activity, trash/data, check, x, warning, info, chevron-down, zap,
    key, external-link, plus). 2px stroke, `aria-hidden`, `size-4` default,
    `focusable="false"`. Unit test: renders svg, no accessible name.

- [x] Task 3: Options primitive components
  <!-- files: src/entrypoints/options/components.tsx, src/entrypoints/options/ui.ts, tests/components/options-primitives.test.tsx -->
  - `Switch` on `radix-ui` Switch (focus ring, disabled state); `Alert`
    (status/alert roles, icon, tinted inset); `Field` (label/hint/error);
    `StatusBadge` (dot+label); `Chip`; `ProviderCard` (selectable card with
    icon/name/description/status); `Disclosure` (collapsible verbatim
    disclosure renderer, open-when-unconfigured API).
  - Extend `ui.ts` recipes to the refined tokens; keep exported names used by
    existing components so interim renders still compile.
  - Tests: role/label/state coverage for each primitive; switch keyboard
    toggle; alert roles.

- [ ] Task: Conductor - User Manual Verification 'Phase 1' (Protocol in workflow.md)

## Phase 2: Panel navigation shell
<!-- execution: sequential -->

- [x] Task 1: Rail + panel shell in `OptionsApp`
  <!-- files: src/entrypoints/options/OptionsApp.tsx, tests/components/options-app.test.tsx -->
  - Left rail (wordmark, 4 nav items with icons + status dots, version
    footer); mobile top-bar collapse; `hidden`-panel switching with hash deep
    links and `#hash` initial restore; `aria-current`; single `h1` + `<main>`.
  - Setup checklist strip component (done/current/pending from props —
    wiring lands in Phase 3).
  - Update `options-app.test.tsx` to nav-switching semantics (panel switch
    reveals the right region; headings contract).

- [ ] Task: Conductor - User Manual Verification 'Phase 2' (Protocol in workflow.md)

## Phase 3: Connections panel
<!-- execution: parallel -->

- [x] Task 1: Jev provider card redesign (`ProviderSetup`)
  <!-- files: src/entrypoints/options/ProviderSetup.tsx, tests/components/provider-setup.test.tsx -->
  - Unified card: icon + name + StatusBadge header; `ProviderCard` preset
    picker with descriptions; `Disclosure` wrapping the verbatim disclosure
    (expanded unconfigured / collapsed when active); enabled state = info
    strip (model, key suffix, origin chips) + secondary Test + ghost-danger
    Revoke; setup form via `Field` components with inline validation;
    `Alert` for notices/errors. Logic/message layer untouched.

- [x] Task 2: LLM provider card redesign (`LlmProviderSetup` + `LlmBudget`)
  <!-- files: src/entrypoints/options/LlmProviderSetup.tsx, src/entrypoints/options/LlmBudget.tsx, tests/components/options-llm-provider.test.tsx -->
  - Same unified card treatment: preset cards (OpenAI / OpenRouter / Custom),
    collapsible `Disclosure`, `Field`-based form (base URL, auth, pricing,
    model, key, budget cap), info strip + Test/Revoke when enabled.
  - `LlmBudget` → stat row with tabular-nums.
  - Update `options-llm-provider.test.tsx` + `options-llm-settings.test.tsx`
    selectors to new semantics.

- [x] Task 3: Setup checklist wiring + PrivacyDraft placement
  <!-- files: src/entrypoints/options/OptionsApp.tsx, src/entrypoints/options/PrivacyDraft.tsx -->
  - Wire checklist to provider status + decisions consent reads
    (`useLiveQuery` against consents, mirroring DecisionSettings' stale-read
    discipline); step links switch panels. `PrivacyDraft` into Connections
    footer.

- [ ] Task: Conductor - User Manual Verification 'Phase 3' (Protocol in workflow.md)

## Phase 4: Permissions panel
<!-- execution: sequential -->

- [x] Task 1: Restructure `DecisionSettings` into Permissions
  <!-- files: src/entrypoints/options/DecisionSettings.tsx, tests/components/options-decisions.test.tsx -->
  - Four sub-cards: Bookmark analysis consent (per-preset picker + verbatim
    disclosure + allow/revoke), Automations (Radix Switches + threshold note),
    Second opinions (consent + toggle, disabled-with-reason inline), Never
    send these sites (chip list + add field + collapsed built-in list).
  - All worker messages, Dexie consent calls, blocklist logic identical.
    Update `options-decisions.test.tsx` (633 lines) to new semantics.

- [ ] Task: Conductor - User Manual Verification 'Phase 4' (Protocol in workflow.md)

## Phase 5: Activity + Data panels
<!-- execution: parallel -->

- [x] Task 1: `SentLog` → stat cards + structured log rows
  <!-- files: src/entrypoints/options/SentLog.tsx, tests/components/sent-log.test.tsx -->
  - Stat cards (requests, tokens in/out, reported cost, unpriced count) with
    tabular-nums; log rows: mono timestamp, destination chip, feature tag,
    muted fields; icon empty state; retention-cap note + Clear preserved.

- [x] Task 2: `DeleteAllData` visual pass
  <!-- files: src/entrypoints/options/DeleteAllData.tsx, tests/components/delete-all.test.tsx -->
  - Danger card restyle (destructive accent, warning icon), dialog pass.
    Behavior identical.

- [ ] Task: Conductor - User Manual Verification 'Phase 5' (Protocol in workflow.md)

## Phase 6: Gate + visual verification
<!-- execution: sequential -->

- [x] Task 1: Full gate + Chromium visual pass
  - `lint` → `typecheck` → `test -- --run` → `build` → `check:manifest` →
    `check:bundle`. Open built `options.html` in Chromium; screenshot light +
    dark, all four panels, enabled and unconfigured states; fix visual
    defects found.

- [ ] Task: Conductor - User Manual Verification 'Phase 6' (Protocol in workflow.md)
