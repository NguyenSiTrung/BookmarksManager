# Reviewer notes — draft

> **Draft — release prerequisite.** Paste the relevant parts into the
> dashboard's test-instructions field at submission time. Keep it truthful to
> the shipped build.

## What this release is

A foundation release: the extension's popup, side panel, and options
surfaces and the local storage schema are in place, plus a working,
consent-gated Test connection for the Jev AI providers TypeSafe and
OpenRouter. Bookmark management features ship in later releases; the
`bookmarks` permission is deliberately absent.

## Testing without an API key

Everything in this build works with no account and no key:

1. Install the extension. It makes **zero network requests** on install or
   page load — verify in DevTools if desired.
2. Click the toolbar action to open the popup; open the side panel; open the
   options page from extension details. All three render without errors.
3. Permissions at install are only `storage` and `sidePanel` — no host
   access, no bookmarks access.
4. Until a provider is fully enabled, no request can be made: the Test
   connection button only appears once consent, host permission, settings,
   and a stored key are all in place.

## Testing the provider connection

The Test connection flow is shipped and functional; exercising it end to end
needs a real provider key:

- It requires your own TypeSafe or OpenRouter API key; no test key is
  bundled.
- Open the options page → "AI provider connection". The disclosure names the
  recipient and its literal origin, the exact synthetic fields (`model`,
  `state`, `questions`), the `Authorization` header, the purpose, the
  trigger, and links the provider's privacy policy.
- Check the unchecked consent box, choose a model, enter the key, and click
  Enable — Chrome's optional host-permission prompt for the single chosen
  origin appears from that same click. Denying it leaves the provider off
  and saves nothing.
- Once enabled, click **Test connection**: the worker sends exactly one POST
  of the fixed synthetic payload to the chosen origin's System One endpoint
  (`https://api.typesafe.ai/v1/systemone` or
  `https://openrouter.ai/api/v1/systemone`) over HTTPS with
  `Authorization: Bearer <key>` — cookies omitted, redirects refused.
  Success shows the returned model id and latency (plus the reported cost
  for OpenRouter); failures show a redacted code (`auth`, `incompatible`,
  `retry_later`, `invalid_response`, `http_error`, `gate`, `not_enabled`,
  `internal_error`) — never keys or response bodies.
- Revoking removes consent and the host permission (with an option to delete
  the stored key) and stops all further requests — the gate re-checks
  consent and permission before every send.
- _A temporary low-credit test key can be supplied at submission time and
  revoked after review — decide at release._

## Compliance checks in this repo

- `npm run check:manifest` — asserts the generated manifest's permissions and
  host patterns exactly match `store/permissions.md`.
- `npm run check:bundle` — asserts the emitted bundle contains no `eval(`,
  no `new Function`, and no remote `<script src>` tags; all code is bundled
  by WXT and only minified, never obfuscated.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, build,
  both checks above, and a headed Chromium smoke test that loads the
  extension and renders all three surfaces.

## Notes

- Consent records carry a `consentVersion` field under the `jev_test` scope
  (`CONSENT_SCOPE`, `src/schemas/provider.ts`; currently version 1); the
  design increases the version and re-shows the disclosure whenever sent
  fields or recipients change, and stale-version grants fail the gate.
- API keys are stored encrypted at rest — an AES-GCM ciphertext envelope in
  `chrome.storage.local` with the non-extractable CryptoKey held in
  IndexedDB — and are never logged, exported, or shown in full; Options
  displays only a masked last-four hint.
- A local data-sent log records metadata only for each request — time,
  destination origin, feature `jev_test`, and the top-level field names
  (`model`, `state`, `questions`) — never request contents, headers, keys,
  or bookmark data.
