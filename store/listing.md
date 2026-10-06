# Store listing — draft

> **Draft.** Copy for the Chrome Web Store listing, pasted into the dashboard
> at submission time. Store rules followed: no "Chrome"/"Google" endorsement
> implications, no third-party logos, no keyword lists, no unverifiable
> claims.

## Name

Bookmarks Manager

## Short description

Fast, offline bookmarks manager in the side panel: search, save, tag,
organize, import, de-duplicate. No account, no tracking.

> This text is the manifest `description` in `wxt.config.ts` (126 chars). The
> Chrome Web Store derives the listing summary from the package, so the two
> must stay identical; Chrome caps the field at 132 characters.

## Full description

Bookmarks Manager puts a faster, more organized manager for your bookmarks in
the browser's side panel, plus a quick-save popup and an options page.

It works entirely on your device. There is no account, no sign-in, and no API
key required, and it makes no network requests on install, on page load, or in
the background. Your native bookmarks stay the source of truth.

What you can do:

- **Quick save** the current page from the popup, a keyboard shortcut
  (Ctrl+Shift+Y / Command+Shift+Y), or the right-click menu — with tags,
  notes, a category, and a folder. The last folder you used is remembered.
- **Search** instantly, entirely on your device. A fuzzy index covers title,
  URL, domain, tags, and notes, with a filter syntax (`tag:`, `folder:`,
  `is:duplicate`, `before:`, negation, quoted phrases) and inline
  autocomplete. Search from the side-panel bar, a command palette
  (Ctrl+K / Command+K), the popup's search box, or the address bar with the
  `bm` keyword. Search queries are never stored or sent anywhere.
- **Browse and manage** from the side panel: a folder tree, a virtualized
  list or grid, and views for all, recently saved, untagged, duplicates,
  tags, and categories.
- **Organize** with color-coded tags (many per bookmark), one category per
  bookmark, and notes.
- **Drag and drop** bookmarks and folders to move and reorder them, with a
  keyboard-accessible drag mode.
- **Undo** a delete, a bulk move, a duplicate merge, or a tag delete — the
  last operations are reversible.
- **Jump anywhere** from the command palette: bookmarks, views, folders,
  tags, and categories, plus commands like Import, Export, Tag manager, New
  folder, Undo, and per-result actions (open, reveal in folder, edit, copy
  URL).
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

There is also an optional, off-by-default AI connection for the Jev providers —
TypeSafe, OpenRouter, or a custom System One-compatible endpoint you configure
(HTTPS; loopback HTTP allowed) — using your own API key: a clear disclosure naming the
recipient, an unchecked consent checkbox, the browser's host-permission
prompt, encrypted on-device key storage, and revoke-at-any-time control. A
synthetic Test connection sends one fixed payload — never your bookmarks — only
when you click it. A separate, off-by-default bookmark-data consent lets the
providers categorize, tag, pre-select a folder, check for near-duplicates,
scan for misfiled bookmarks, and re-rank an "Ask" search. It sends bookmark
metadata only — title, cleaned URL, domain, folder path, tag names and
descriptions, candidate folder paths, candidate bookmarks, the near-duplicate
partner, and the Ask query — and only on a user-started action (saving a
bookmark, clicking Analyze, starting a library scan, or running an Ask
search); never on install, on a timer, or in the background. Your notes are
never sent; a bounded page excerpt leaves the device only under the opt-in
Summarize scopes. AI features are entirely optional; every feature above
works without a key.

Optionally, you can also configure one OpenAI-compatible LLM provider — a
preset (OpenAI, OpenRouter) or a custom HTTPS endpoint, with HTTP allowed
only for a loopback service — for features the local model cannot do. A
custom endpoint is granted through the broad `https://*/*` optional host
pattern, which is capability only: the browser grants the exact origin you
configure, at runtime, from your own click — never default access — and the
extension re-checks that exact origin, its consent record, and the request
schema before any request can leave the device:
plain-language explanations of review decisions, budget-capped second
opinions on low-confidence calls, folder-restructure proposals for your
review (never applied automatically), and opt-in page summaries verified by
Jev. Each feature has its own consent scope tied to the exact origin you
configured, its disclosed field list, and an explicit user action; your
stored credential travels in the authentication header only, spending is
metered against a monthly budget you set, and revoking the provider removes
every grant, the host permission, and the key.

Summarize sends the page title, cleaned URL, headings, and a bounded page
excerpt to your LLM provider, plus site name and meta description when
present (`llm_summary`). Jev verification sends the saved bookmark title,
cleaned URL, domain, headings, bounded page excerpt, and LLM-generated
summary (`jev_summary_verify`); it does not add the page title, site name,
or meta description. Both hops strip URL query strings, fragments, and
embedded usernames/passwords. Notes, the extraction's byline, and the full
page DOM are not sent. Only a Jev-supported summary is saved locally, not
the excerpt. Shared `consentVersion` is currently 4: older grants remain
stored but stale until you reaccept for the exact scope and origin; one
origin's reacceptance never refreshes another.
Opening Summarize only reads consent status and shows both exact recipients,
field lists, and the current version. **Agree and summarize** is the
affirmative send; closing grants nothing. The worker rechecks the displayed
recipients/version before granting consent. Changed providers require
reviewing again; unknown-cost confirmation is a separate choice and retains
the accepted binding.

Not in this release: a link checker, cloud sync, and accounts. The extension
requests no browsing-history permission or default access to page content.
Page extraction happens only after your explicit Summarize action.

## What's new

Version 1.0 — first public release.

- Offline core manager: side panel with folder tree, virtualized list/grid,
  and views for all, recently saved, untagged, duplicates, tags, and
  categories.
- Quick save from the popup, a keyboard shortcut, and the right-click menu.
- Tags, categories, and notes stored locally; undo for delete, move, merge,
  and tag delete.
- Local import/export as JSON, Netscape HTML, or CSV; local duplicate
  detection with keep-one merge.
- Local search everywhere: the side-panel bar, the Ctrl+K / Command+K
  command palette, the popup, and the `bm` omnibox keyword — fuzzy matching
  with filters, computed on-device, with queries never stored or sent.
- Site icons via the browser's built-in favicon renderer.
- "Delete all extension data" with a confirmation that names what is removed
  and states that native bookmarks are untouched.
- Optional, consent-gated Jev provider flow: a synthetic Test connection, and
  a separate bookmark-data consent for categorize, tag, folder pre-select,
  near-duplicate, misfiled-scan, and Ask search decisions (metadata only —
  never notes; page text only under the separate opt-in Summarize scopes).

## Category

Tools — the dashboard groups options under a PRODUCTIVITY header
(Communication, Developer Tools, Education, Tools, Workflow & Planning);
the header itself is not selectable, so 1.0.0 ships as **Tools**.

## Language

English

## URLs

- Homepage: <https://nguyensitrung.github.io/BookmarksManager/>
- Support (issue tracker):
  <https://github.com/NguyenSiTrung/BookmarksManager/issues>
- Privacy policy: <https://nguyensitrung.github.io/BookmarksManager/privacy/>
  — the hosted copy of `store/privacy-policy.md`

## Assets

- Icon: `store/assets/icon-128.png` at 128×128 px (the package embeds 16,
  32, and 48 px variants)
- Five screenshots of the real UI at 1280×800 (synthetic demo library —
  regenerate with
  `UPDATE_STORE_ASSETS=1 xvfb-run -a npx playwright test tests/e2e/store-assets.spec.ts`),
  in listing order:
  1. `store/assets/screenshot-manager-1280x800.png` — side panel manager
     (folder tree, virtualized list, views)
  2. `store/assets/screenshot-search-1280x800.png` — command palette with
     live search results
  3. `store/assets/screenshot-duplicates-1280x800.png` — duplicates view
     with exact and normalized groups
  4. `store/assets/screenshot-popup-save-1280x800.png` — quick-save popup
     mid-save (tag, category, notes)
  5. `store/assets/screenshot-options-ai-1280x800.png` — options: the
     optional LLM provider disclosure (recipients, fields sent, fields never
     sent)
- Small promo tile: `store/assets/promo-440x280.png` at 440×280 px
- Marquee promo tile: `store/assets/marquee-1400x560.png` at 1400×560 px
  (optional featuring slot; no promotional video — out of scope for 1.0.0)

## Content notes for reviewers of this copy

- The listing leads with offline, local, and no-account, and only checkable
  statements — no "100% private" or "best" claims.
- The optional AI features are described as optional and key-based; the
  listing names providers once, in context, rather than as a keyword list.
- The "Not in this release" list is kept truthful: the link checker, cloud
  sync, and accounts are not shipped, so they must not be promised.
- As features land in later releases, extend the feature list and re-check it
  against `store/permissions.md` and the privacy policy in the same change.
