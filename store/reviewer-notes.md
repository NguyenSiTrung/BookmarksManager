# Reviewer notes — draft

> **Draft.** Paste the relevant parts into the
> dashboard's test-instructions field at submission time. Keep it truthful to
> the shipped build.

## What this release is

The offline core manager, plus the optional provider connection from the
previous slice:

- A quick-save popup, a keyboard shortcut, and right-click "Save page" /
  "Save link" items.
- A side panel with a folder tree, a virtualized list/grid, and views for all,
  recently saved, untagged, duplicates, tags, and categories.
- Fully local search across title, URL, domain, tags, and notes — with a
  filter syntax (`tag:`, `folder:`, `is:duplicate`, `before:`, negation,
  quotes) and autocomplete — available from the side-panel search bar, a
  Ctrl+K / Command+K command palette (jump targets, commands, per-result
  actions), the popup's search box, and the `bm` address-bar keyword.
- Tags, categories, and notes stored locally; undo for delete, bulk move,
  duplicate merge, and tag delete.
- Drag-and-drop moves and reorders.
- Local import and export (JSON, Netscape HTML, CSV) and local duplicate
  detection with keep-one merge.
- Site icons through Chrome's built-in `_favicon` renderer.
- "Delete all extension data".
- An optional, consent-gated Jev provider flow: a synthetic Test connection
  for TypeSafe and OpenRouter, plus a separate per-provider bookmark-data
  consent (`jev_decisions`) for categorize, tag, folder pre-select,
  near-duplicate, misfiled-scan, and Ask search decisions.

Not in this release: the link checker, cloud sync, and accounts.

## Testing without an API key

Everything except the provider Test connection works with no account and no
key. Suggested walkthrough:

1. Install the extension. It makes **zero network requests** on install or
   page load. This is asserted automatically by `tests/e2e/shell.spec.ts`,
   which loads the extension in a fresh Chromium profile, exercises the
   popup, side panel, and options surfaces, and fails if the page or the
   service worker emits a single request outside the browser's own internal
   schemes (`chrome-extension:`, `chrome:`, `devtools:`, `data:`, `blob:`,
   `about:`) — so `ws://`, `wss://`, `ftp://` and anything else would fail it
   too (before the context is closed). `tests/e2e/core-manager.spec.ts`
   repeats the same assertion while exercising the core features end to end,
   including a context-menu save driven inside the service worker and the
   browser-resolved keyboard shortcut. `tests/e2e/search.spec.ts` asserts the
   same zero-egress invariant while driving every search surface — the
   side-panel bar (including a live update mid-query), the command palette,
   and the popup search — so search traffic provably never leaves the device.
   (The `bm` omnibox path is unit-tested: the browser's address bar cannot be
   driven by automation.)
2. Permissions at install are the required set only — `activeTab`,
   `bookmarks`, `contextMenus`, `favicon`, `scripting`, `storage`,
   `sidePanel`. There is no host access and no page-content access at
   install. (`scripting` backs the on-demand Readability extractor — injected
   only after an explicit Summarize click; there are no static content
   scripts.)
3. **Quick save from the popup:** click the toolbar action. The form is
   prefilled with the active tab's title and URL; add tags, a category, notes,
   and pick a folder, then Save. Re-opening the popup defaults to the folder
   you last used. Saving a URL that already exists shows "Already saved in
   <folder>" with an "Edit that bookmark" button that opens the side panel on
   that bookmark.
4. **Quick save from the keyboard:** press Ctrl+Shift+Y (Command+Shift+Y on
   macOS), or rebind it at `chrome://extensions/shortcuts`, to open the same
   popup.
5. **Quick save from the context menu:** right-click a page → "Save page to
   Bookmarks Manager", or right-click a link → "Save link to Bookmarks
   Manager". The item saves into the last-used folder and the toolbar shows a
   brief "✓".
6. **Side panel:** open it from the toolbar action's "Open manager" button or
   the browser's side-panel picker. Browse the folder tree and the views;
   select one or many bookmarks; edit title/URL/tags/category/notes; move with
   "Move to…"; delete (with an undo toast); reorder by dragging, including a
   keyboard-accessible drag mode; create, rename, and delete folders.
7. **Search:** type in the side-panel search bar (or press `/` to focus it).
   Results update live and support the filter syntax — try
   `tag:<name>`, `folder:<name>`, `is:duplicate`, `is:untagged`, or a quoted
   phrase; inline suggestions complete keys and values, and inline warnings
   explain a malformed filter. Escape clears the query and restores the
   previous view. Press Ctrl+K (Command+K on macOS) for the command palette:
   bookmarks, views, folders, tags, categories, and commands in one list;
   Enter on a bookmark opens it, and each row's "⋯" menu offers Reveal in
   folder, Edit, and Copy URL. The quick-save popup also has a search box —
   typing swaps the save form for the top ten results, Enter opens in a new
   tab, Ctrl+Enter (Command+Enter) in the current tab. In the address bar,
   type `bm` then Space/Tab to search bookmarks from the omnibox; up to eight
   suggestions appear and Enter opens the top hit. All of this runs on the
   device — the e2e suite proves zero requests during search, and no query is
   ever stored.
8. **Import a file:** side panel → "Import…" → choose a `.json`, `.html`/`.htm`,
   or `.csv` file from your device. A preview shows folder/bookmark/duplicate/
   invalid counts before anything is written; confirm to import into a new
   "Imported <date>" folder under Other bookmarks, then delete that folder in
   one click if you want to undo it.
9. **Export:** side panel → "Export…" → choose a format (JSON, Netscape HTML,
   CSV) and scope (whole library or current folder). The file downloads
   locally; no upload occurs, and exports contain no API keys.
10. **Duplicates:** open the "Duplicates" view. Groups are labeled exact or
   normalized (tracking parameters and trivial URL differences are ignored).
   Use "Keep this one" to merge a group, then undo from the toast.
11. **Delete all extension data:** Options → "Delete all extension data" →
    confirm. The dialog lists exactly what is removed and states that native
    bookmarks are untouched. After confirming, open the browser's native
    bookmark manager: your bookmarks are all still there, unchanged. The
    extension is back to its first-run state (reload the Options page). If
    another Bookmarks Manager window was still holding the local database
    open, the dialog says so instead of claiming a clean wipe, and names any
    host permission it could not release so you can revoke it at
    `chrome://extensions`.

## Testing the provider connection

The Test connection flow is shipped and functional; exercising it end to end
needs a real provider key:

- It requires your own TypeSafe or OpenRouter API key; no test key is
  bundled.
- Open the options page → "AI provider connection". The disclosure names the
  recipient and its literal origin, the exact synthetic fields (`model`,
  `state`, `questions`), the `Authorization` header, the purpose, the
  trigger, and links the provider's privacy policy; each preset also shows a
  short provider-specific data-handling note, and moving model aliases
  (`jev-latest`, `jev-preview`) show an inline warning that confidence
  thresholds tuned on one model version may not carry over.
- Check the unchecked consent box, choose a model, enter the key, and click
  Enable — Chrome's optional host-permission prompt for the single chosen
  origin appears from that same click. Denying it leaves the provider off
  and saves nothing.
- Once enabled, click **Test connection**: the worker sends exactly one POST
  of the fixed synthetic payload to the chosen origin's System One endpoint
  (`https://api.typesafe.ai/v1/systemone`,
  `https://openrouter.ai/api/v1/systemone`, or `<baseUrl>/systemone` for a
  configured custom endpoint) over HTTPS with
  `Authorization: Bearer <key>` — cookies omitted, redirects refused.
  Success shows the returned model id and latency (plus the reported cost
  for OpenRouter); failures show a redacted code (`auth`, `incompatible`,
  `retry_later`, `timeout`, `invalid_response`, `http_error`, the consent
  gate's own refusal codes such as `no_key`/`no_consent`/`no_permission`/
  `unlisted_model`/`unregistered_scope`/`request_not_allowed`, `reconnect`
  for an unreadable stored key, `not_enabled`, `internal_error`) — never
  keys or response bodies.
- Until consent, host permission, and a stored key are all in place the Test
  connection button is not available and no request can be made — the gate
  re-checks consent and permission before every send.
- Revoking removes consent and the host permission (with an option to delete
  the stored key) and stops all further requests. Revoking deletes every
  consent scope the provider holds — the synthetic `jev_test` grant and the
  bookmark-data `jev_decisions` grant.
- A temporary low-credit test key may be supplied in the dashboard's test
  instructions at submission time and revoked after review.

## Testing the optional LLM provider

The LLM provider flow is consent-gated per feature scope and is exercisable
without a paid account by pointing a custom provider at a local model server.

**About the broad `https://*/*` optional pattern in the manifest:** it is a
capability pattern, not default access — the extension requests no host
access at install time, and the pattern exists so Chrome can grant the
*exact* custom origin the user configures, at runtime, from a direct Enable
click. The single egress gate then re-checks the exact origin (scheme, host,
and port — loopback ports included), the per-scope consent record, and the
closed request schema before any request can leave; revoking removes the
grant, the permission, and the key.

- Open the options page → "LLM provider". Choose a preset (OpenAI or
  OpenRouter) or a custom base URL. Custom remote endpoints must be HTTPS;
  plain HTTP is accepted only for loopback (`http://localhost`,
  `http://127.0.0.1`, `http://[::1]`), and redirects, URL credentials, and
  arbitrary headers are refused.
- Check the unchecked consent box for the feature scope and click Enable —
  Chrome's optional host-permission prompt for the exact configured origin
  appears from that click (e.g. `http://localhost:11434` for a local model,
  or the preset origin). Denying it leaves the provider off.
- **Test connection** (`llm_test`) sends a fixed synthetic chat request —
  `model`, `messages`, `response_format` — and nothing else; the credential
  travels in the authentication header only.
- Feature scopes `llm_explain`, `llm_escalate`, `llm_restructure`,
  `llm_summary`, and `jev_summary_verify` each show their own disclosure
  naming the exact fields sent, the user action that triggers them, and the
  credential path; a request can leave the device only while its scope's
  grant and the exact-origin permission are both in place.
- **Summarize** (`llm_summary`) sends the page title, cleaned URL, headings,
  bounded page excerpt, and site name and meta description when present to
  the configured LLM origin. **Jev summary verification**
  (`jev_summary_verify`) sends the saved bookmark title, cleaned URL,
  domain, headings, bounded page excerpt, and LLM-generated summary to the
  enabled Jev origin; no page title, site name, or meta description is added.
  Both hops strip URL query strings, fragments, and embedded
  usernames/passwords; the original URL remains local for admission/matching.
  Notes, the extraction's byline, and the full page DOM are not sent. Only a
  Jev-supported summary is saved locally; the excerpt is not persisted.
  Opening the dialog only preflights consent status. Verify both exact
  recipients, field lists, and the version before clicking **Agree and
  summarize**. Closing it grants nothing and performs no extraction/send.
  The worker rechecks the displayed recipients/version before new grants;
  a provider change requires reviewing again. Unknown-cost confirmation is
  separate and resends with the same accepted binding.
- The monthly budget caps LLM spending; when reliable pricing is configured
  each request reserves an estimated cost, and the second-opinion flow never
  applies a change by itself.
- Revoking the provider deletes every consent scope at its origin, removes
  the host permission, and deletes the stored credential — verified by
  `tests/unit/llm-settings.test.ts` and `tests/unit/consent.test.ts`.

## Testing bookmark decisions

The bookmark-data flow is shipped behind a separate, per-provider
`jev_decisions` consent; exercising it end to end needs a real provider key:

- Open the options page → the provider's decisions consent screen. The
  disclosure names the exact fields sent — the bookmark title, cleaned URL,
  domain, and folder path; tag names and descriptions; candidate folder
  paths; candidate bookmarks; the near-duplicate partner; and the Ask search
  query — and states plainly that notes are never sent and page text is
  never sent under `jev_decisions` (the separate Summarize scopes above are
  the bounded-page-text exception). It
  names the recipient and its literal origin
  (`https://api.typesafe.ai`, `https://openrouter.ai`, or the configured
  custom origin), the purpose
  (categorize, tag, folder pre-select, near-duplicate check, misfiled scan,
  search re-rank), the triggers (focusing Tags or clicking Suggest in the
  popup, clicking Analyze, starting a library scan, clicking Resume, running
  an Ask search — user-started only, never on install, on a timer, or in the
  background; interrupted jobs pause on cold startup until you click Resume),
  and links the provider's
  privacy policy and this extension's privacy policy.
- The agree checkbox starts unchecked and Enable is a separate action. The
  consent is versioned (`consentVersion`, currently 4); older records stay
  stored but stale and authorize no request until reacquired for the exact
  scope and origin. Reaccepting one origin does not refresh another origin.
- Once consented, a decision request is sent only on a user-started action
  and only to the chosen origin's System One endpoint over HTTPS with
  `Authorization: Bearer <key>` — cookies omitted, redirects refused. Only the
  disclosed metadata fields are sent; notes and page text are never included.
  Every request is re-checked by the single network gate (registered scope,
  current consent, live host permission, and stored key) before it leaves.
- Revoking the provider deletes every `jev_decisions` grant for its origin,
  removes its host permission, and offers to delete the stored key.

## Compliance checks in this repo

- `npm run check:manifest` — asserts the generated manifest's permissions and
  host patterns exactly match `store/permissions.md`.
- `npm run check:bundle` — asserts the emitted bundle contains no `eval(`,
  no `new Function`, and no remote `<script src>` tags; all code is bundled
  by WXT and only minified, never obfuscated.
- `tests/e2e/shell.spec.ts` — loads the built extension in a fresh profile and
  fails if any request outside the browser's own internal schemes is emitted
  before teardown, proving the zero-egress claim for a fresh install;
  `tests/e2e/core-manager.spec.ts` asserts the same thing across the whole
  feature walkthrough.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, build,
  both checks above, and a headed Chromium smoke test that loads the
  extension and renders all three surfaces.

## Notes

- Consent records carry a `consentVersion` field per `(scope, origin)` —
  the synthetic `jev_test`, bookmark-data `jev_decisions`, every `llm_*`,
  and `jev_summary_verify` scopes (`src/schemas/provider.ts`). The shared
  current version is 4, owned by `src/consent/records.ts`, not the schema.
  Sent-field or recipient changes require renewed consent; historical rows
  remain stored as stale grants and fail the gate until reacquired.
- API keys are stored encrypted at rest — an AES-GCM ciphertext envelope in
  `chrome.storage.local` with the non-extractable CryptoKey held in
  IndexedDB — and are never logged, exported, or shown in full; Options
  displays only a masked last-four hint.
- A local data-sent log records metadata only for each request — time,
  destination origin, feature (the consent scope, `jev_test` or
  `jev_decisions`), and the top-level field names sent — never request
  contents, headers, keys, or bookmark data.
- Bookmark metadata (tags, category, notes) and undo snapshots live only in
  the extension's IndexedDB, keyed by Chrome bookmark id; the native bookmark
  tree is the source of truth and "Delete all extension data" never touches
  it.
