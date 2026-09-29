# Chrome Web Store "Privacy practices" — draft answers

> **Draft.** These are the answers to give in the
> Chrome Web Store developer dashboard's privacy tab at submission time.
> Google sets the checkbox labels and they can change: map this inventory to
> the current labels then. Keep this file in the same change as any code that
> alters data flow — a mismatch between dashboard answers, the privacy policy,
> and actual behavior can suspend all of the publisher's items.
>
> This version describes the **shipped core manager**: bookmark management
> (quick save, side panel, fully local search with the `bm` address-bar
> keyword, tags, categories, notes, drag and drop, import and export,
> duplicate detection, `_favicon` icons, delete all data), plus the optional,
> consent-gated Jev provider flow — the synthetic test connection and the
> bookmark-data `jev_decisions` flow. Every local feature works with no
> account and no key.

## Single purpose

> Manage, search, save, and organize your Chrome bookmarks from the side
> panel. The extension keeps your native bookmarks as the source of truth and
> adds local tags, categories, and notes on top; quick save from the popup, a
> keyboard shortcut, or the right-click menu; fully on-device search across
> the side panel, a command palette, the popup, and the `bm` address-bar
> keyword; drag and drop; and local import/export and duplicate detection.
> An optional connection to an AI provider you configure with your own
> API key: a synthetic test sends a fixed payload and never your bookmarks,
> and the separate, off-by-default bookmark-data consent sends bookmark
> metadata only — never notes or page text — on a user-started action.
> A second, fully optional OpenAI-compatible LLM provider you configure
> (preset or custom HTTPS origin, loopback HTTP allowed) can explain
> decisions, give budget-capped second opinions, propose folder structures,
> and summarize pages — each behind its own consent scope and an
> explicit user action.

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
- `scripting` — Inject the bundled Readability extractor into the active tab
  only after an explicit Summarize action, so page text can be summarized
  with consent; there are no static content scripts and no extraction on
  navigation, install, timers, or scans.
- `sidePanel` — Show the Bookmarks Manager UI in Chrome's side panel.
- `storage` — Store encrypted provider API-key envelopes in
  chrome.storage.local; plaintext keys are never persisted.
- `https://api.typesafe.ai/*` (optional) — Jev provider connection (Test
  connection and bookmark decisions) to the TypeSafe provider, started by the
  user.
- `https://openrouter.ai/*` (optional) — Jev provider connection (Test
  connection and bookmark decisions) to the OpenRouter provider, started by
  the user.
- `https://*/*` (optional) — capability only: lets the user grant the exact
  origin of a custom OpenAI-compatible LLM provider or a custom
  System One-compatible Jev endpoint at runtime, from a direct click; no
  request can fire without a per-scope consent record and the exact-origin
  permission check.
- `http://localhost/*` (optional) — optional LLM or custom Jev provider on
  a loopback endpoint (e.g. a local model server), granted per exact
  origin.
- `http://127.0.0.1/*` (optional) — same, via the IPv4 loopback literal.
- `http://[::1]/*` (optional) — same, via the IPv6 loopback literal.

(The first two optional patterns back the consent-gated Jev provider flow —
the synthetic Test connection and the bookmark-data `jev_decisions` flow.
`https://*/*` is capability only, not default access: it grants the exact
custom origin at runtime from a direct click, and the egress gate re-checks
the exact origin, its consent scope, and the request schema before any send.
The three loopback literals cover local LLM or Jev servers — Chrome patterns cannot
express ports, so the gate enforces the port itself. The extension requests
no host access at install time and reads no page content on any site.)

## Remote code

**No, the extension does not use remote code.** All JavaScript and HTML are
bundled at build time by WXT; `npm run check:bundle` scans the emitted bundle
for `eval(`, `new Function`, and remote `<script src>` tags and fails the
build on any hit.

## Data usage

Conservative declaration — under-declaring is the risky direction:

This extension has no server of its own — the developer receives nothing;
every request goes only to the origin you configured.

- **Authentication information: yes, only if you set up the optional AI
  provider.** The user's own API key is stored encrypted on the device and sent
  only to the provider that issued it, in the `Authorization: Bearer` header,
  when the user runs a Test connection or starts a bookmark decision — never
  on install, page load, in the background, or on enable. Users who never
  configure a provider store and send no key.
- **Bookmark data stays on the device by default.** Titles, URLs, folder
  structure, tags, categories, and notes are read from and written to Chrome's
  own bookmarks and the extension's local IndexedDB. They are never
  transmitted anywhere unless you enable the optional `jev_decisions`
  bookmark-data flow described below. Imports and exports are local file reads
  and downloads.
- **Search queries are never stored or sent.** All search — the side-panel
  bar, command palette, popup, and `bm` omnibox keyword — runs against an
  in-memory local index; typing produces zero network requests. Only an
  explicit Ask search, under `jev_decisions` consent, sends its query.
- **Bookmark decisions (`jev_decisions`), only if enabled:** the separate
  bookmark-data consent scope sends bookmark metadata to the chosen provider
  to categorize, tag, folder pre-select, run a near-duplicate check, run a
  misfiled scan, and search re-rank. What is sent is metadata only — the
  bookmark title, cleaned URL, domain, and folder path; tag names and
  descriptions; candidate folder paths; candidate bookmarks; the
  near-duplicate partner; and the Ask search query. Your notes are **never**
  sent under any scope; page text leaves the device only under the
  `llm_summary` / `jev_summary_verify` scopes (a bounded excerpt, after an
  explicit Summarize click) described below. It runs only on a user-started action —
  saving a bookmark, clicking Analyze, starting a library scan, or running an
  Ask search — and only when you start them — never on install, on a timer, or
  in the background. To whom: exactly one provider origin you chose —
  `https://api.typesafe.ai` (TypeSafe), `https://openrouter.ai` (OpenRouter),
  or the custom System One-compatible endpoint you configured.
  Links: the provider's privacy policy (`https://typesafe.ai/legal/privacy-policy`
  or `https://openrouter.ai/privacy`; a custom endpoint is governed by its
  own policy) and this extension's privacy policy
  (https://nguyensitrung.github.io/BookmarksManager/privacy/). The
  consent is versioned (`consentVersion`, currently 3); revoking a provider
  deletes every consent grant for its origin — `jev_test`, `jev_decisions`,
  and every `llm_*` scope — removes its host permission, and offers to delete
  its key.
- **Optional LLM provider features, only if you configure one.** An
  OpenAI-compatible provider you choose — preset (OpenAI or OpenRouter) or a
  custom HTTPS origin (HTTP only for a loopback service). Each feature is a
  separate consent scope granted per exact origin; your stored provider
  credential goes in the request's authentication header only — never inside
  the message body. Notes, the full page DOM, and credentials in the message
  body are never sent under any scope:
  - LLM test connection (`llm_test`): `model`, `messages`,
    `response_format` — a fixed synthetic request, only when you click
    "Test connection".
  - Decision explanations (`llm_explain`): decision state, question,
    candidate labels, Jev probabilities, selected answer — only when you
    click "Explain" on a pending decision.
  - Automatic second opinions (`llm_escalate`): decision state, question,
    allowed options, Jev probabilities, Jev answer — only inside a Save,
    Analyze, or library scan you started, within the spending ceiling you
    chose (a monthly cap or an explicit "no cap"); never applies changes.
  - Restructure proposals (`llm_restructure`): folder paths, category
    counts, tag counts, domains, representative titles (capped) — only when
    you start "Restructure"; proposals are review-only.
  - Page summaries (`llm_summary`): page title, site name, headings, bounded
    page excerpt — extracted and sent only after you click "Summarize",
    never in the background or incognito.
  - Jev summary verification (`jev_summary_verify`): page title, bounded
    page excerpt, LLM-generated summary — sent to your Jev provider only as
    part of a Summarize action you started.
- **Everything else: not collected.** The only other transmission is the test
  connection's fixed synthetic payload (`model`, `state`, `questions`), which
  contains no user data.
- **Web history: only if `jev_decisions` is enabled.** Bookmark titles and
  cleaned URLs are the Web history category, and the `jev_decisions` flow
  sends them to the user-chosen AI provider when AI features are on — the
  bookmark title, cleaned URL, domain, and folder path; tag names and
  descriptions; candidate folder paths; candidate bookmarks; the
  near-duplicate partner; and the Ask search query. Nothing is sent until you
  enable `jev_decisions` and start a save, Analyze, library scan, or Ask
  search.
- Not collected: personally identifiable information, health information,
  financial and payment information, personal communications, location, user
  activity. (No click or keystroke monitoring. Website content — a bounded
  page excerpt — leaves the device only under the optional `llm_summary` /
  `jev_summary_verify` scopes after an explicit Summarize click; no
  bookmark, tag, or note leaves it outside the `jev_decisions` and `llm_*`
  flows above.)

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

<https://nguyensitrung.github.io/BookmarksManager/privacy/> — the hosted copy
of `store/privacy-policy.md`.
