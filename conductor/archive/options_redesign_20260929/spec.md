# Options Page Redesign — Guided Panels

## Overview

Redesign and restructure the extension Options page (`src/entrypoints/options/`)
from a single scrolling column of loosely-related cards into a guided,
panel-based settings surface with a distinctive visual identity.

The current page has a real UX defect that styling alone cannot fix: consent is
scattered across three surfaces (provider enable, decisions consent, escalation
consent) and the relationship between the two provider systems (Jev presets vs
optional LLM provider) is invisible. The redesign introduces a left navigation
rail with four focused panels — Connections → Permissions → Activity → Data —
matching the user's mental model: *where data can go → what may be sent → what
was sent → remove it all*.

All behavior is preserved: every worker message, Dexie read/write, consent
record, `chrome.permissions.request` gesture call, disclosure string, and gate
stays byte-identical. This track changes presentation and component structure
only — it touches no module under `src/net`, `src/consent`, `src/messages`,
`src/llm`, `src/jev`, `src/decisions`, `src/security`, or `src/db`.

## Functional Requirements

### FR1 — Panel navigation

1. Replace scroll-spy section navigation with a left rail containing the
   extension icon/wordmark, four nav items (Connections, Permissions, Activity,
   Data) with icon + label + status indicator, and the extension version pinned
   at the bottom.
2. Nav switches the visible panel; all four panels stay mounted (HTML `hidden`
   attribute) so in-progress form state — typed API keys, unchecked consent
   boxes — is never lost, preserving today's guarantee.
3. Keep `role="navigation"` with `aria-label="Options sections"`, a `<main>`
   content region, and a single `h1` — the accessibility contract asserted by
   `tests/components/options-app.test.tsx`.
4. Active nav item uses `aria-current`; panels map to `#hash` deep links so
   load-and-restore and programmatic jumps keep working.
5. On narrow viewports the rail collapses to a horizontal top bar of the same
   four items.

### FR2 — Connections panel

1. A setup checklist strip at top shows three steps — *Connect a provider*,
   *Allow bookmark analysis*, *Choose automations* — each rendered done /
   current / pending from live status, clickable to the relevant panel.
2. Two unified connection cards (Jev preset provider; LLM provider). Each card:
   - header row: provider icon, name, status badge (Active / Not set up);
   - provider picker rendered as selectable cards with icon, name, one-line
     description, and per-item status — not bare radios;
   - the verbatim disclosure text inside a `details` element, expanded while
     unconfigured and collapsed once the provider is active;
   - enabled state: an info strip (model · key suffix · origin as code chips)
     plus an action row (Test connection secondary, Revoke ghost-danger);
   - setup state: labeled form fields with hints and validation messages
     rendered inline at the field, not only as a footer error.
3. All existing enable / revoke / test flows, permission requests, consent
   checkboxes, model selects (including moving-alias warnings), custom-endpoint
   fields, pricing fields, and budget-cap input are preserved verbatim in
   behavior and copy.
4. The monthly budget panel (`LlmBudget`) renders inside the LLM card as a
   stat row (month, requests, tokens, reported/estimated cost, cap, remaining)
   with tabular-nums, not a definition-list dump.
5. `PrivacyDraft` remains bundled and collapsed by default, moved into the
   Connections panel footer.

### FR3 — Permissions panel

1. One place to answer "what may be sent", containing:
   - **Bookmark analysis consent** — per-Jev-preset consent picker + verbatim
     disclosure + allow/revoke (moved from `DecisionSettings`);
   - **Automations** — the two auto-apply kinds (`add_tags`, `set_category`)
     as Radix Switch toggles with one-line explanations and the existing
     confidence-threshold note;
   - **Second opinions** — escalation consent + enable toggle; gated states
     render the switch disabled with the blocking reason inline (no provider,
     no consent, no monthly cap, provider gone);
   - **Never send these sites** — user blocklist as removable chips + add
     field with inline validation error + the collapsed built-in list.
2. Consent scopes, preset keying, `hasConsent`/`grantConsent`/`revokeConsent`
   calls, worker messages (`GET_SETTINGS`, `SET_SETTINGS`, `SET_BLOCKLIST`,
   `LLM_ESCALATION_*`), and all disclosure constants are unchanged.

### FR4 — Activity panel

1. Usage totals render as stat cards: requests, input/output tokens, reported
   cost, estimated/unpriced count — `tabular-nums`, real empty state with
   icon.
2. The sent log renders structured rows: monospaced timestamp, destination
   chip, feature tag, muted field-name list. Retention-cap disclosure and
   Clear action preserved.
3. `useLiveQuery` sources and `clearSentLog()` unchanged.

### FR5 — Data panel

1. Danger zone card + existing delete-all dialog, unchanged logic; visual pass
   only (destructive accent, warning icon, preserved item list and notices).

## Non-Functional Requirements

### NFR1 — Visual system

1. **Typography:** Geist Variable (`woff2`, vendored under
   `src/entrypoints/options/fonts/`, ~57KB) applied to the options root only;
   `@font-face` declared in `src/ui/styles.css` — other surfaces never load it.
   `font-display: swap`; system-ui fallback chain. Code/chip text keeps the
   existing mono stack.
2. **Palette:** keep the shadcn token architecture; introduce a refined
   warm-neutral palette with a single deep-teal accent, scoped under an
   `.options-root` class so popup/sidepanel tokens are untouched. Dark mode
   continues to follow `prefers-color-scheme` via the existing media-query
   token block.
3. **Icons:** new `src/ui/components/icons.tsx` — a small set of inline
   stroke SVGs (consistent 2px stroke, `aria-hidden`, sized via `size-*`), no
   new dependency.
4. **Depth:** tinted shadows matching surface hue; borders only where they
   carry hierarchy; subtle surface difference between rail and content.
5. **Motion:** 150–250ms transitions on interactive elements; switch/navigation
   transitions respect `prefers-reduced-motion`; scroll-behavior rule retained.

### NFR2 — Component primitives

1. `Switch` built on `radix-ui` Switch (umbrella already installed) with
   visible focus ring and disabled-with-reason support.
2. `Alert`/`Notice` component: icon + tinted inset, `role="status"` for
   success/info and `role="alert"` for errors — replaces bare colored `<p>`
   lines in every panel.
3. `Field` wrapper: label + control + hint + error slot, eliminating the
   ~15 repeated label/input blocks across the two provider forms.
4. `StatusBadge` (dot + label), `Chip` (blocklist entries, info strips),
   `ProviderCard` (radio-like selectable card with icon/description/status).
5. Disclosure rendering unified in one `Disclosure` component shared by all
   three consent surfaces.

### NFR3 — Constraints

1. No new runtime dependencies. `radix-ui` (Switch), `clsx`,
   `tailwind-merge`, `dexie-react-hooks` are already installed.
2. No `fetch`, no remote assets, no new permissions, no CSP/CWV changes —
   font is bundled; icons are inline SVG.
3. Every consent-gating element stays: disclosure text verbatim, explicit
   consent checkbox before enable, permission request inside a direct user
   gesture, per-scope consent surfaces.
4. TypeScript strict (`verbatimModuleSyntax`, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`), existing ESLint rules, `cn()` for class
   composition.

## Acceptance Criteria

- [ ] Options page renders four-panel guided layout with left rail nav; all
      panels mounted; `#hash` deep links work; `h1`/`main`/`navigation`
      contract intact.
- [ ] Setup checklist reflects live provider/consent/automation state.
- [ ] Every prior flow works unchanged: enable/revoke/test for both provider
      systems, per-preset analysis consent, auto-apply toggles, escalation
      consent + toggle, blocklist add/remove, budget snapshot, sent log
      render + clear, delete-all dialog.
- [ ] All disclosure/consent copy byte-identical to current strings.
- [ ] Geist loads on the options page only; palette scoped to `.options-root`;
      dark mode verified; light mode verified.
- [ ] Options component tests updated and green; `lint`, `typecheck`,
      `test -- --run`, `build` green. No `chrome.*` behavior change → no e2e
      changes needed.
- [ ] No new dependencies; bundle check green; font binary committed.

## Out of Scope

- Popup, sidepanel, and any other surface's visuals.
- Any logic change to workers, gates, consent records, schemas, or Dexie.
- New settings or features.
- Persisting the active panel across sessions (nice-to-have only if trivial).
- Public-store asset updates (the options page is not in store screenshots).
