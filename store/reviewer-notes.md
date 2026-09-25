# Reviewer notes — draft

> **Draft — release prerequisite.** Paste the relevant parts into the
> dashboard's test-instructions field at submission time. Keep it truthful to
> the shipped build.

## What this release is

A foundation release: the extension's popup, side panel, and options
surfaces and the local storage schema are in place, and an optional,
consent-gated Test connection for the Jev AI providers TypeSafe and
OpenRouter is being built for this release (not yet functional). Bookmark
management features ship in later releases; the `bookmarks` permission is
deliberately absent.

## Testing without an API key

Everything in this build works with no account and no key:

1. Install the extension. It makes **zero network requests** on install or
   page load — verify in DevTools if desired.
2. Click the toolbar action to open the popup; open the side panel; open the
   options page from extension details. All three render without errors.
3. Permissions at install are only `storage` and `sidePanel` — no host
   access, no bookmarks access.

## Testing the provider connection

_The Test connection flow is under construction for this foundation release —
there is nothing to exercise yet. Once it ships it will work as follows:_

- It will require your own TypeSafe or OpenRouter API key; no test key is
  bundled.
- Enabling a provider will show a disclosure stating exactly what is sent (a
  fixed synthetic payload plus the `Authorization` header), to which origin,
  and will ask for affirmative consent — an unchecked checkbox plus an
  explicit enable action — with Chrome's optional host-permission prompt
  appearing from that same click.
- The request will go only to the chosen provider origin
  (`https://api.typesafe.ai/*` or `https://openrouter.ai/*`) over HTTPS, and
  revoking consent or the host permission will stop all further requests.
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
  (`CONSENT_SCOPE`, `src/schemas/provider.ts`); the design increases the
  version and re-shows the disclosure whenever sent fields or recipients
  change.
- API keys are being built to be stored encrypted at rest and will never be
  logged or exported.
