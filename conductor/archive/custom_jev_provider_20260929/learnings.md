# Track Learnings: custom_jev_provider_20260929

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

- Consent is per-origin and durable (`hasConsentAtOrigin`/`grantConsentAtOrigin`
  in `src/consent/records.ts`) — the LLM layer's proven model. Jev preset
  wrappers (`grantConsent(scope, preset)`) still exist for callers that only
  ever address preset origins.
- `LlmBaseUrl` canonical-URL rules (https required; http only for
  `LOOPBACK_HOSTS`) were reused verbatim for the custom Jev base URL.
- `declare const chrome` slices throw synchronously when absent — all
  worker-call boundaries already wrapped.
- `chrome.permissions.request` must stay synchronous inside the click
  handler — never move it behind an await or a helper that defers it.
- ESLint bans `fetch` outside `src/net/**`.

## Implementation learnings (2026-09-29)

- The single egress gate is destination-agnostic if you resolve the
  destination per call: presets resolve from the frozen registry (no stored
  row needed — this is why preset gate tests pass without seeding settings),
  while `custom` resolves ONLY from a stored `ProviderSettings` row through
  `ProviderSettings.safeParse` (fail-closed → `unlisted_origin`). No message
  field or consent record can redirect a preset's destination.
- `z.discriminatedUnion` on `preset`: the custom variant needs its own
  strictObject; a stray `baseUrl` on a preset ENABLE is ignored because the
  worker builds `settingsInput` per variant, not from the raw message.
- Consent re-check keys off the RESOLVED origin on every send, so rewriting
  the stored row to a new origin requires fresh consent — but the old
  origin's grant persists by design (same as the LLM layer). `revokeProvider`
  resolves the destination from the stored row BEFORE deleting it so the
  old origin's consent/permission can be swept.
- `OptionsApp` "connected" detection went origin-agnostic: any consent row at
  scope `jev_test`/`llm_test` at the current version — no preset lookup.
- `DecisionSettings` needed a `PROVIDER_STATUS {preset:"custom"}` probe on
  mount to learn whether a custom origin is configured; the consent card
  renders only when an origin resolves. Guard `consentOrigin === null`
  BEFORE setting `inFlight`/`busy` — placing the guard after wedges the
  button busy forever.
- The protocol-discipline component test allowlists message types the UI may
  send; the mount-time status probe required adding `PROVIDER_STATUS` there.
- `getByLabelText(/model/i)` matches the custom card's "Model ID" text too —
  exact-match `/^model$/i` for the preset `<select>`.
- `noUncheckedIndexedAccess`: `Record<string, ProviderStatus>[id]` is
  `ProviderStatus | undefined` — the test worker needs `?? DISABLED` where
  `Record<PresetId, _>` (finite union) did not.
- `npm run typecheck` runs `wxt prepare` first — required to generate
  `.wxt/tsconfig.json`; bare `npx tsc` fails without it.
- `check:store` compares `manifest.json` optional origins to
  `store/permissions.md` rows — update the doc prose carefully, but the
  pattern set itself never changed for this feature (the pre-existing broad
  `https://*/*` capability + loopback literals already cover custom Jev).
