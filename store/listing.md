# Store listing — draft

> **Draft — release prerequisite.** Copy for the Chrome Web Store listing.
> Fields marked _release prerequisite_ must be filled with real values before
> submission; none are invented here. Store rules followed: no "Chrome"/
> "Google" endorsement implications, no third-party logos, no keyword lists,
> no unverifiable claims.

## Name

Bookmarks Manager

## Short description (draft)

A fast, offline bookmarks manager in the side panel: save, tag, organize,
import, and de-duplicate your bookmarks. No account, no sign-in, no tracking.

## Full description (draft)

Bookmarks Manager puts a faster, more organized manager for your bookmarks in
the browser's side panel, plus a quick-save popup and an options page.

It works entirely on your device. There is no account, no sign-in, and no API
key required, and it makes no network requests on install, on page load, or in
the background. Your native bookmarks stay the source of truth.

What you can do:

- **Quick save** the current page from the popup, a keyboard shortcut
  (Ctrl+Shift+Y / Command+Shift+Y), or the right-click menu — with tags,
  notes, a category, and a folder. The last folder you used is remembered.
- **Browse and manage** from the side panel: a folder tree, a virtualized
  list or grid, and views for all, recently saved, untagged, duplicates,
  tags, and categories.
- **Organize** with color-coded tags (many per bookmark), one category per
  bookmark, and notes.
- **Drag and drop** bookmarks and folders to move and reorder them, with a
  keyboard-accessible drag mode.
- **Undo** a delete, a bulk move, a duplicate merge, or a tag delete — the
  last operations are reversible.
- **Find duplicates** locally (exact and normalized URLs, ignoring tracking
  parameters) and merge a group while keeping one bookmark.
- **Import and export** your library as JSON, Netscape HTML, or CSV. These are
  local files on your device — nothing is uploaded, and exports never include
  API keys.
- **See site icons** through the browser's own built-in favicon renderer — no
  host access and no requests to icon services.
- **Delete all extension data** from the options page at any time. It removes
  only what the extension stored for itself; your native bookmarks are
  untouched.

There is also an optional, off-by-default connection test for the Jev AI
providers TypeSafe and OpenRouter, using your own API key: a clear disclosure
naming the recipient, an unchecked consent checkbox, the browser's
host-permission prompt, encrypted on-device key storage, and a Test connection
button that sends one fixed synthetic payload — never your bookmarks — only
when you click it. Revoke consent and access at any time from the options
page. AI features are entirely optional; every feature above works without a
key.

Not in this release: search and a command palette, the AI review queue, a
link checker, cloud sync, and accounts. The extension requests no access to
your browsing history or page content.

## What's new

Version 0.1 — first release.

- Offline core manager: side panel with folder tree, virtualized list/grid,
  and views for all, recently saved, untagged, duplicates, tags, and
  categories.
- Quick save from the popup, a keyboard shortcut, and the right-click menu.
- Tags, categories, and notes stored locally; undo for delete, move, merge,
  and tag delete.
- Local import/export as JSON, Netscape HTML, or CSV; local duplicate
  detection with keep-one merge.
- Site icons via the browser's built-in favicon renderer.
- "Delete all extension data" with a confirmation that names what is removed
  and states that native bookmarks are untouched.
- Optional, consent-gated connection test for the Jev AI providers.

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

- The listing leads with offline, local, and no-account, and only checkable
  statements — no "100% private" or "best" claims.
- The optional AI features are described as optional and key-based; the
  listing names providers once, in context, rather than as a keyword list.
- The "Not in this release" list is kept truthful: search, the command
  palette, the AI review queue, the link checker, and cloud sync are not
  shipped, so they must not be promised.
- As features land in later releases, extend the feature list and re-check it
  against `store/permissions.md` and the privacy policy in the same change.
