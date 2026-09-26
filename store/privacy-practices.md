# Chrome Web Store "Privacy practices" — draft answers

> **Draft — release prerequisite.** These are the answers to give in the
> Chrome Web Store developer dashboard's privacy tab at submission time.
> Google sets the checkbox labels and they can change: map this inventory to
> the current labels then. Keep this file in the same change as any code that
> alters data flow — a mismatch between dashboard answers, the privacy policy,
> and actual behavior can suspend all of the publisher's items.
>
> This version describes the **shipped core manager**: bookmark management
> (quick save, side panel, fully local search with the `bm` address-bar
> keyword, tags, categories, notes, drag and drop, import and export,
> duplicate detection, `_favicon` icons, delete all data), plus the
> optional, consent-gated synthetic Jev test-connection flow. Every local
> feature works with no account and no key.

## Single purpose

> Manage, search, save, and organize your Chrome bookmarks from the side
> panel. The extension keeps your native bookmarks as the source of truth and
> adds local tags, categories, and notes on top; quick save from the popup, a
> keyboard shortcut, or the right-click menu; fully on-device search across
> the side panel, a command palette, the popup, and the `bm` address-bar
> keyword; drag and drop; and local import/export and duplicate detection.
> An optional connection test for an AI provider you configure with your own
> API key sends only a fixed synthetic payload — never your bookmarks.

## Permission justifications

Use the justification column of `store/permissions.md` verbatim; CI
(`npm run check:manifest`) keeps that table equal to the generated manifest.

- `activeTab` — Read the current tab's title and URL for the quick-save popup
  when the user opens it; the grant is scoped to that one user action and
  expires when the tab navigates.
- `bookmarks` — Read the native bookmark tree for the side-panel manager UI and
  write user-initiated create/update/move/remove plus quick-save.
- `contextMenus` — Add the right-click "Save page to Bookmarks Manager" and
  "Save link to Bookmarks Manager" items that quick-save into the last-used
  folder.
- `favicon` — Serve cached page favicons via Chrome's built-in
  `chrome-extension://<id>/_favicon/?pageUrl=...&size=...` renderer so the
  manager UI can show site icons without host access or any network request.
- `sidePanel` — Show the Bookmarks Manager UI in Chrome's side panel.
- `storage` — Store encrypted provider API-key envelopes in
  chrome.storage.local; plaintext keys are never persisted.
- `https://api.typesafe.ai/*` (optional) — Jev test connection to the TypeSafe
  provider, started by the user.
- `https://openrouter.ai/*` (optional) — Jev test connection to the OpenRouter
  provider, started by the user.

(The two optional patterns back the shipped, consent-gated Test connection —
the only feature that produces network traffic, and only on an explicit Test
connection click. The extension requests no host access at install time and
reads no page content on any site.)

## Remote code

**No, the extension does not use remote code.** All JavaScript and HTML are
bundled at build time by WXT; `npm run check:bundle` scans the emitted bundle
for `eval(`, `new Function`, and remote `<script src>` tags and fails the
build on any hit.

## Data usage

Conservative declaration — under-declaring is the risky direction:

- **Authentication information: yes, only if you set up the optional AI
  provider.** The user's own API key is stored encrypted on the device and sent
  only to the provider that issued it, in the `Authorization: Bearer` header,
  when the user runs a Test connection — never on install, page load, in the
  background, or on enable. Users who never configure a provider store and send
  no key.
- **Bookmark data stays on the device.** Titles, URLs, folder structure, tags,
  categories, and notes are read from and written to Chrome's own bookmarks and
  the extension's local IndexedDB. They are never transmitted anywhere. Imports
  and exports are local file reads and downloads.
- **Search queries are never stored or sent.** All search — the side-panel
  bar, command palette, popup, and `bm` omnibox keyword — runs against an
  in-memory local index; typing produces zero network requests.
- **Everything else: not collected.** The only other transmission is the test
  connection's fixed synthetic payload (`model`, `state`, `questions`), which
  contains no user data.
- Not collected: personally identifiable information, health information,
  financial and payment information, personal communications, location, web
  history, user activity, website content. (No click or keystroke monitoring;
  no bookmark, tag, note, or page content leaves the device.)

Before any future feature sends bookmark, page, or activity data, update this
declaration, `store/privacy-policy.md`, and the in-product consent screen in
the same change.

## Certifications (Limited Use)

Tick all three:

- Data is not sold to third parties.
- Data is not used or transferred for purposes unrelated to the extension's
  single purpose.
- Data is not used or transferred to determine creditworthiness or for
  lending purposes.

## Privacy policy URL

_release prerequisite — the hosted URL from `store/privacy-policy.md` once
the policy is published._
