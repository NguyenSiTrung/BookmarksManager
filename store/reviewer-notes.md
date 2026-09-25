# Reviewer notes — draft

> **Draft — release prerequisite.** Paste the relevant parts into the
> dashboard's test-instructions field at submission time. Keep it truthful to
> the shipped build.

## What this release is

A foundation release: the extension's popup, side panel, and options
surfaces, local settings storage, and an optional, consent-gated Test
connection for the Jev AI providers TypeSafe and OpenRouter. Bookmark
management features ship in later releases; the `bookmarks` permission is
deliberately absent.

## Testing without an API key

Everything except the provider test works with no account and no key:

1. Install the extension. It makes **zero network requests** on install or
   page load — verify in DevTools if desired.
2. Click the toolbar action to open the popup; open the side panel; open the
   options page from extension details. All three render without errors.
3. Permissions at install are only `storage` and `sidePanel` — no host
   access, no bookmarks access.

## Testing the provider connection

- The Test connection flow requires your own TypeSafe or OpenRouter API key;
  no test key is bundled.
- Enabling a provider shows a disclosure stating exactly what is sent (a
  fixed synthetic payload plus the `Authorization` header), to which origin,
  and asks for affirmative consent — an unchecked checkbox plus an explicit
  enable action. Chrome's optional host-permission prompt appears from that
  same click.
- The request goes only to the chosen provider origin
  (`https://api.typesafe.ai/*` or `https://openrouter.ai/*`) over HTTPS.
  Revoking consent or the host permission stops all further requests.
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

- Consent is versioned (`CONSENT_VERSION`): if sent fields or recipients
  ever change, the disclosure is shown again before the next request.
- API keys are stored encrypted at rest and never logged or exported.
