# Store listing — draft

> **Draft — release prerequisite.** Copy for the Chrome Web Store listing.
> Fields marked _release prerequisite_ must be filled with real values before
> submission; none are invented here. Store rules followed: no "Chrome"/
> "Google" endorsement implications, no third-party logos, no keyword lists,
> no unverifiable claims.

## Name

Bookmarks Manager

## Short description (draft)

Manage your bookmarks from Chrome's side panel. This early foundation
release ships the extension's surfaces and settings storage; an optional AI
provider connection test (using your own API key) is being built into it.

## Full description (draft)

Bookmarks Manager puts its surfaces in Chrome's side panel, plus a popup and
an options page.

This early release provides the extension's foundation:

- Popup, side panel, and options surfaces.
- Local storage foundations for your settings — nothing is sent anywhere by
  default, and the build makes no network requests at all.
- An optional connection test for the Jev AI providers TypeSafe and
  OpenRouter, using your own API key — being built for this release. The
  test will send a fixed synthetic payload — never your bookmarks — and run
  only when you click it, after a clear disclosure and consent screen.

AI features will be entirely optional and require an API key from a supported
provider. The extension requests no access to your browsing history, tabs, or
bookmarks in this release, and makes no network requests on install or on
page load.

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
- No claims like "100% private" or "best" — only checkable statements.
- As features land in later releases, extend the feature list and re-check it
  against `store/permissions.md` and the privacy policy in the same change.
