# Plan: Custom Jev provider

Track id: custom_jev_provider_20260929

- [x] 1. `ProviderSettings` → discriminated union (`preset` literal: presets
      unchanged, `custom` carries `baseUrl`+`model`); `JevProviderId` /
      `JEV_PROVIDER_IDS`; `src/jev/providers.ts` (`JevDestination`,
      `presetJevDestination`, `resolveJevDestination`);
      `src/jev/settings.ts` (`readJevProvider`, `resolveStoredJevDestination`,
      `readActiveJevProvider`).
- [x] 2. Gate: `sendConsented`/`sendConsentedTest` take `providerId`, resolve
      destination per call, `hasConsentAtOrigin`, loopback-http allowance,
      `readProviderKey(providerId)`. `keys.ts` + `client.ts` preset→providerId.
- [x] 3. `messages/provider.ts`: `JevProviderId` everywhere, `baseUrl` on
      ENABLE, origin/baseUrl on STATUS, custom enable (reconfigure sweeps old
      origin consent+permission), revoke, test via `testJevConnection`.
- [x] 4. Route callers: `background.ts` active provider via
      `readActiveJevProvider`; pipeline/duplicates/rerank/assign/runner
      `preset`→`providerId`; `summaries.ts` verify uses active provider.
- [x] 5. Options UI: custom provider card (baseUrl/model inputs, dynamic
      disclosure, `chrome.permissions.request` on computed pattern);
      `DecisionSettings` consent card for custom origin; `OptionsApp`
      connected-detection by scope; `disclosure.ts` custom disclosure.
- [x] 6. Tests: update renames; add schema/gate/messages custom coverage.
      Run gate: lint → typecheck → test -- --run → build → check:manifest →
      check:bundle → check:store → xvfb-run -a test:e2e.
- [x] 7. PROJECT_PLAN.md §8.1 status + store docs (check:store must pass).
