# Store listing — draft

> **Draft — release prerequisite.** Copy for the Chrome Web Store listing.
> Fields marked _release prerequisite_ must be filled with real values before
> submission; none are invented here. Store rules followed: no "Chrome"/
> "Google" endorsement implications, no third-party logos, no keyword lists,
> no unverifiable claims.

## Name

Bookmarks Manager

## Short description (draft)

The foundation of a side-panel bookmarks manager, plus an optional,
consent-gated connection test for your own AI provider key. Bookmark
management features arrive in a later release.

## Full description (draft)

Bookmarks Manager puts its surfaces in Chrome's side panel, plus a popup and
an options page.

This is an early foundation release. It does not manage, search, or tag your
bookmarks yet — it ships the surfaces and storage those features will build
on, plus one working optional feature:

- Popup, side panel, and options surfaces.
- Local storage for your settings and consent records — nothing is sent
  anywhere by default, and the extension makes no network requests on
  install, on page load, or in the background.
- An optional connection test for the Jev AI providers TypeSafe and
  OpenRouter, using your own API key: a clear disclosure naming the
  recipient, an unchecked consent checkbox, Chrome's host-permission prompt,
  encrypted on-device key storage, and a Test connection button that sends
  one fixed synthetic payload — never your bookmarks — only when you click
  it. Revoke consent and access at any time from Options.

AI features are entirely optional and require an API key from a supported
provider. The extension requests no access to your browsing history, tabs, or
bookmarks in this release.

## Category

Productivity _(suggested — confirm against current dashboard categories)_

## Language

English

## URLs — all release prerequisites

- Homepage: _release prerequisite_
- Support (email or issue tracker): _release prerequisite_
- Privacy policy: _release prerequisite — must be the hosted URL of
  `store/privacy-policy.md`_

## Assets — all release prerequisites

- Icon: 128×128 px (plus 16, 32, and 48 px inside the package)
- At least one screenshot of the real UI at 1280×800 or 640×400
- Small promo tile: 440×280 px

## Content notes for reviewers of this copy

- AI features are described as optional and key-based; the listing names
  providers once, in context, rather than as a keyword list.
- The copy deliberately calls this a foundation release — it must not
  promise bookmark management, search, tagging, or AI categorization, none
  of which ship in this slice.
- No claims like "100% private" or "best" — only checkable statements.
- As features land in later releases, extend the feature list and re-check it
  against `store/permissions.md` and the privacy policy in the same change.
