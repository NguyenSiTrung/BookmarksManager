# Spec: Custom Jev (System One-compatible) provider

Status: delivered
Track id: custom_jev_provider_20260929

## User request

Other providers also serve the Jev model over the same System One protocol
(e.g. a gateway fronting TypeSafe). The extension should support a custom
provider with a user-supplied base URL and model id — not a custom
OpenAI-compatible provider (that already exists in the LLM layer), and not
limited to the curated TypeSafe/OpenRouter presets. PROJECT_PLAN.md §8.1
already reserved this for 1.1.

## Scope

- One custom Jev provider slot (`providerId: "custom"`), alongside the two
  presets. Settings row `metadata["custom"]` =
  `{preset: "custom", baseUrl, model, keySuffix}` where `baseUrl` reuses the
  `LlmBaseUrl` canonical-URL rules (https required; http only on loopback).
- Egress destination resolves to `POST <baseUrl>/systemone` with
  `Authorization: Bearer <key>` — the same wire protocol and
  `<api-root>/systemone` convention the presets use.
- The `sendConsented` gate generalizes `preset` → `providerId`: presets
  resolve through the frozen registry, `custom` resolves from the stored
  settings row (fail-closed). Consent, host permission, model pin, and key
  material are all checked per call, keyed by resolved origin / provider id.
- Options gains a third provider card (base URL + model id + key) with the
  standard enable/test/revoke flow and per-origin `jev_decisions` consent.
- Decisions pipeline, summaries verification, re-rank, duplicates, jobs all
  run against the resolved active provider (`summaries.ts` also drops its
  hardcoded `typesafe` origin — fixing openrouter-only users).
- Consent version, manifest, and delete-all are unchanged (dynamic origins
  already covered by `https://*/*` optional host permission and
  `permissions.getAll()`).

## Non-goals

- Multiple custom provider slots (one, like each preset).
- Any change to the OpenAI-compatible LLM custom provider.
