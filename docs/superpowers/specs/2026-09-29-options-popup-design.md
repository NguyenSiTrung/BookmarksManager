# Options and popup polish — design

Date: 2026-09-29
Status: draft for review
Scope: sub-project 4 of the UI redesign: the Options page and the quick-save
popup. The four items deferred by the shell/theme spec ("collapsed
disclosures, deduplicated consent text, disabled-button style, popup search
placement") plus two small defects found in this sub-project's survey.

## Background

A capture survey of the popup (380 px, its fixed width) and every Options
panel (400 and 1280 px, no provider configured) found:

- Both Connections cards open with a ~300 px expanded seven-bullet
  disclosure ("What enabling TypeSafe means", "What enabling an LLM provider
  means"); the Permissions panel opens with a ~580 px expanded
  bookmark-analysis disclosure. The panels land as walls of small grey text.
- The same facts — Recipient / What is sent / Why / When / Never sent — are
  hand-rolled as prose bullets at four sites (`ProviderSetup`,
  `LlmProviderSetup`, `DecisionSettings` bookmark analysis, `DecisionSettings`
  second opinions), with per-site phrasing drift. Inside the
  bookmark-analysis disclosure "What is sent: bookmark metadata only — no
  notes and no page text" duplicates "Never sent, under any scope: notes and
  page text".
- Disabled primary buttons use `disabled:pointer-events-none
  disabled:opacity-50`: half-opacity teal still reads as enabled (in review
  the popup's disabled Save button was read as "appears enabled"), the
  pointer cursor never becomes `not-allowed`, and no tooltip is possible.
  The `Switch` component already models the better pattern — a disabled
  control carries an inline reason.
- The popup's search field sits as a wide filled row between the header and
  the save form, though the popup's primary job is quick-save
  (PROJECT_PLAN §3); it competes with the page card and leaves the popup
  feeling sparse below the Save button.
- Two incidental defects: in Permissions the "Block a host" input's border
  touches the built-in blocklist disclosure directly below it (no vertical
  separation); the popup header title truncates ("Bookmarks Man…") at 380 px.

Nothing today enforces reading a disclosure: the consent checkboxes are
independent of disclosure state and every `<details>` can be collapsed by
hand. The force-open-until-consented behavior is presentation, not a gate.

## Decisions

- **Consent disclosures collapse by default, gated by a read signal.** Each
  consent site renders its disclosure folded; the "I have read…" checkbox
  stays disabled until that disclosure has been opened once, with an inline
  reason. This keeps the consent posture honest (the checkbox's claim is
  never hollow) while removing the text walls. It mirrors the existing
  `Switch` philosophy: a gated control never looks silently frozen.
- **Popup search moves into an expanding header control.** The header gains
  a search icon button; the search row appears under the header only while
  active. The save form becomes the first content under the header; search
  stays one click away in the place people look for it. Bottom placement was
  rejected (unusual for search, hurts discoverability); removing search was
  rejected (PROJECT_PLAN §5.1 Phase 3 feature).

## Part 1 — Consent disclosure read gates

Sites (the only ones whose consent checkbox pairs with a disclosure):

1. `ProviderSetup` — TypeSafe/OpenRouter/custom Jev card.
2. `LlmProviderSetup` — OpenAI-compatible provider card.
3. `DecisionSettings` — "Bookmark analysis consent".
4. `DecisionSettings` — "Automatic second opinions".

Behavior at every site:

- `Disclosure` defaults to closed (`open={false}`) — including while
  unconsented. The existing open-while-unconfigured `open` props are
  removed. Once consent is granted the disclosure stays folded, one click
  away, exactly as today.
- The site tracks `openedOnce` from `Disclosure`'s existing `onOpenChange`.
  The consent checkbox is disabled until `openedOnce` is true, and a
  one-line reason renders next to/below it: "Open the disclosure above
  first." The reason disappears once the gate is satisfied.
- `openedOnce` resets when the disclosure's subject changes: switching
  provider preset (TypeSafe ↔ OpenRouter ↔ custom) in `ProviderSetup` and
  `DecisionSettings`, switching provider kind in `LlmProviderSetup`, or the
  escalation origin changing. Revoking consent also resets `openedOnce`, so
  re-consenting re-arms the gate.
- `Disclosure` itself stays a dumb controlled `<details>`; all gate state
  lives at the call sites. The blocklist disclosures need no gate (no
  consent checkbox).

This is a read signal, not enforcement — identical in strength to today's
force-open, which is equally unenforced.

## Part 2 — `ConsentFacts`: one rendering of the consent facts

New component in `src/entrypoints/options/components.tsx`:

```tsx
export function ConsentFacts(props: {
  recipientName: string;
  origin: string;
  sent: string[];
  neverSent?: string[];
  why?: string;
  when?: string;
  children?: ReactNode; // per-site extras
}): ReactElement
```

- Renders a compact definition list — Recipient (name at origin, "the only
  destination this consent covers" where applicable), Sent (chip row),
  Never sent (chip row), Why, When — omitting absent rows. `children`
  carries site extras (credential handling, data note, policy links).
- All four sites from Part 1 replace their hand-rolled `<ul>`s with
  `ConsentFacts`; the facts themselves come verbatim from
  `src/consent/disclosure.ts` (and the per-scope constants it exports).
  Presentation changes; the disclosed substance does not.
- The in-disclosure duplication is merged: the sent row lists what goes;
  the never-sent row states it once ("notes and page text" style chips),
  and "no notes and no page text" phrasing is dropped from the sent row.
- The second-opinions disclosure uses the same component with its
  `LLM_SCOPE_DISCLOSURES` facts.

## Part 3 — Disabled-button treatment

- `ui.ts` button recipes (`primaryButtonClass`, `dangerButtonClass`,
  `secondaryButtonClass`, `ghostDangerButtonClass`, `smallButtonClass`) and
  the popup's inline Save-button classes replace
  `disabled:pointer-events-none disabled:opacity-50` with
  `disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none
  disabled:saturate-50`. Dropping `pointer-events-none` is what makes the
  `not-allowed` cursor (and future tooltips) work.
- Every gated primary action carries an adjacent one-line reason while
  disabled. Most sites already have helper text ("Consent alone sends
  nothing…"); the new read gates add their own (Part 1). Audit result: the
  `LlmBudget` and `DeleteAllData` buttons are disabled only transiently
  while `busy` (self-explanatory in-flight states) and the blocklist Add
  sits beside an empty input — none of these need a reason line.
- The popup Save button uses the same disabled classes. Its busy label
  ("Saving…") and `aria-busy` are unchanged.

## Part 4 — Popup header search

- Header layout: logo, full title (`flex-1`), then an icon cluster:
  `[search] [open manager] [settings]`. "Open manager" and settings become
  icon-only buttons with `aria-label` + `title` tooltips (their accessible
  names are unchanged, so tests keep working); the search icon button is
  `aria-label="Search bookmarks"`, `aria-expanded` reflecting the row.
- Clicking the icon opens a search row directly under the header (the slot
  the field occupies today). The row stays mounted while open or while the
  query is non-empty; closing with a live query clears it.
- The input auto-focuses when the row opens. Escape on an empty query, or
  the row's × after the query is already clear, closes the row and returns
  focus to the search icon. `Search.tsx`'s combobox/listbox semantics,
  result rendering and keyboard handling are unchanged apart from the new
  close hook (`onClose` prop).
- The popup opens with search closed. Save-form state is untouched by
  opening/closing search (query and form state both live in `App`).

## Part 5 — Incidental fixes

- Permissions blocklist: vertical separation between the "Block a host"
  input row and the built-in blocklist disclosure below it (margin, no
  border collision).
- Popup header: with the icon cluster the full "Bookmarks Manager" title
  must not truncate at 380 px (icon-only actions free the needed width);
  verified in the capture pass.

## Testing

- Component tests, per site with a gate: checkbox disabled until the
  disclosure summary is clicked once; reason line appears then disappears;
  gate resets on provider/preset change; consent-granted state renders no
  checkbox and a folded disclosure.
- `ConsentFacts` component tests: every provided row renders; absent rows
  are omitted; children render; each fact appears exactly once (regression
  for the merged never-sent duplication).
- Button recipe tests: disabled classes are `cursor-not-allowed` etc., not
  `pointer-events-none` (assert on the rendered class string).
- Popup tests: search row absent until the icon is clicked; opens with
  focus in the input; Escape on empty query closes and returns focus to the
  icon; results flow unchanged once open (existing `popup-search.test.tsx`
  behaviors carried over with the row pre-opened by the harness).
- Existing options/popup tests: update only assertions that depend on the
  changed presentation (default-open disclosures, prose bullet text,
  "Open manager" visible text). Behavioral assertions stay.
- E2E helpers (`helpers/llm.ts` `enableCustom`/`enableOpenAi`,
  `helpers/provider.ts` `enableTypesafe`, `helpers/decisions.ts`
  `grantDecisionsConsent`): click the disclosure summary before checking
  the agree box. Keeps `llm.spec.ts`, `decisions.spec.ts` and the
  provider/decisions suites green.
- Manual capture pass: popup at 380; Options panels at 400 and 1280, light
  and dark; disclosure closed and opened states. Gates: lint, typecheck,
  build, `check:*`, unit, components, e2e gate trio.

## Rollout

Six tasks, one commit each, following the repo's commit-per-task rule and
never pushing:

1. Disabled-button recipes + popup Save button.
2. `ConsentFacts` component + the four sites' dedup.
3. Disclosure read gates (all four sites) + e2e helper updates.
4. Popup header search + icon-only header actions.
5. Incidental fixes (blocklist spacing; header title width check).
6. Capture pass, full gates, store-asset check, bd closeout, report.

## Out of scope

- Any change to the consent facts themselves, consent storage, scopes or
  the egress gate.
- Activity/Data panel sparseness and empty-state contrast (noted in the
  survey; separate polish if wanted).
- Side panel, dialogs, and store assets (none depict Options or the popup).
