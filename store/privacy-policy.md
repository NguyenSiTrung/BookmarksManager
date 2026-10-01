# Privacy Policy — Bookmarks Manager

> This text is kept in the repo so the shipped policy stays in sync with the
> code. It is hosted at <https://nguyensitrung.github.io/BookmarksManager/privacy/>
> (the `site/` GitHub Pages source) and that URL is entered in the Chrome Web
> Store dashboard. Update this file, `site/privacy/index.html`, the in-product
> consent screens, and the dashboard entry in the same change whenever data
> handling changes.

**Version:** 1.0
**Effective date:** 2026-09-28
**Hosted URL:** <https://nguyensitrung.github.io/BookmarksManager/privacy/>

## Who publishes this extension

Bookmarks Manager is published by: **NguyenSiTrung**
(<https://github.com/NguyenSiTrung>).

Contact: **trungnsai95@gmail.com** — monitored; privacy questions and deletion
requests are answered there. Issues may also be filed at
<https://github.com/NguyenSiTrung/BookmarksManager/issues>.

## Summary

The developer does not collect, receive, or store any of your data. There are
no accounts, no analytics, no telemetry, no crash reporting, no remote code,
and no developer-operated servers.

Bookmark management works fully offline: there is no account, no sign-in, and
no API key required. Everything stays in your browser unless you explicitly
start a feature that sends data to a provider you chose. The optional AI
provider flow — disclosure, consent, host permission, encrypted key storage,
revocation, the Test connection, and the bookmark decisions flow — is off by
default and is the only code path that can ever make a network request. At a
fresh install the extension sends zero requests.

## How the extension handles your bookmarks

- Your native Chrome bookmarks remain the source of truth. The extension reads
  them through the `bookmarks` permission and writes only the changes you make
  (create, edit, move, delete, quick save, import).
- The extension stores only its **own** extra information — tags, category,
  and notes — in its local IndexedDB database, keyed by the Chrome bookmark id
  it belongs to. It never copies your bookmark tree to a server, and it never
  uploads a bookmark.
- **Undo snapshots** (for a delete, a bulk move, a duplicate merge, or a tag
  delete) are kept in the same local IndexedDB database, newest-first and
  capped at the 20 most recent, so the last operation can be reversed.
- **Site icons** are served by Chrome's own built-in `_favicon` renderer using
  the `favicon` permission. The extension requests no host access for icons and
  makes no request to any icon service.
- **Search** runs entirely on your device. The side-panel bar, the command
  palette (Ctrl+K / Command+K), the popup search box, and the `bm`
  address-bar keyword all query a local index built in memory from your
  bookmarks and their tags, notes, and categories. Search queries are never
  stored, logged, or sent anywhere — typing into any search surface produces
  no network request of any kind. The index itself is held in memory only:
  it is rebuilt when a surface opens (the omnibox builds a fresh one per
  session and discards it when you leave) and is never written to disk.
- **Import and export** are local file operations: you pick a file on your own
  device (JSON, Netscape HTML, or CSV) or download one. The file is read and
  written entirely in the browser — nothing is uploaded, and no server is
  involved.

## Data stored locally (never sent to the developer)

- Bookmark metadata — tags, category, and notes — in IndexedDB, one row per
  Chrome bookmark id, and tag definitions (name, color, description).
- Undo snapshots for reversible operations, in IndexedDB.
- Extension settings and preferences (for example the last folder a quick save
  used), in IndexedDB.
- The search index exists only in memory — it is not persisted, and search
  queries are never written to any storage surface.
- Provider records, written only if you set up the optional AI feature; they
  stay on the device:
  - Consent records: a versioned grant per provider origin and per scope —
    the synthetic `jev_test` scope and the bookmark-data `jev_decisions`
    scope — each recording the scope, the origin, the `consentVersion` you
    accepted, and when.
  - Provider settings: the provider preset, chosen model name, and a masked
    display hint — the last four characters of your API key (a fixed `****`
    placeholder for keys too short to mask safely), never the full key.
  - API key ciphertext: an AES-GCM encrypted envelope in
    `chrome.storage.local`; the encryption key is a non-extractable
    CryptoKey held in IndexedDB. Plaintext keys are never written anywhere.
  - A local "data sent" log holding metadata only — the time, the
    destination origin, the feature (the consent scope, `jev_test` or
    `jev_decisions`), and the top-level field names sent. It never stores
    request contents, headers, keys, or bookmark data.

## Data sent to third parties — only at your direction

The only features that can send data are the optional **Test connection**,
**bookmark decisions**, and the separately consented **LLM features** below.
All are off until you configure them, and send only inside actions you start.

This extension has no server of its own — the developer receives nothing;
every request goes only to the origin you configured.

### The synthetic Test connection (`jev_test`)

- **What is sent:** a fixed, synthetic test payload generated by the
  extension with exactly the top-level fields `model`, `state`, and
  `questions` — sample text, not your data — plus your API key in the
  `Authorization: Bearer` header. No bookmark titles, URLs, notes, tags,
  categories, page content, or browsing history are ever sent.
- **To whom:** exactly one provider origin that you picked —
  `https://api.typesafe.ai` (TypeSafe), `https://openrouter.ai` (OpenRouter),
  or the custom System One-compatible endpoint you configured.
  The corresponding optional host permission is requested only from a direct
  click on the provider's Enable button in Options, and is revocable at any
  time.
- **When:** only on an explicit Test connection click, after the in-product
  disclosure screen and an affirmative, unchecked consent checkbox — never
  on install, on page load, in the background, or when enabling a provider.
  Enabling only stores consent, the saved settings, and the encrypted key
  locally; nothing leaves the device until you click Test connection.

### Bookmark decisions (`jev_decisions`)

Beyond the synthetic test, an optional **bookmark-data** flow can send
bookmark metadata to the same provider for AI decisions (categorize, tag,
folder pre-select, near-duplicates, misfiled scan, and search re-rank). It is
a separate consent scope, `jev_decisions`, granted per provider, and it is off
until you enable it.

- **What is sent:** bookmark metadata only — the bookmark title, cleaned URL,
  domain, and folder path; tag names and descriptions; candidate folder
  paths; candidate bookmarks; the near-duplicate partner; and the Ask search
  query. Your notes are **never** sent under any scope. Page text is sent
  only under the `llm_summary` and `jev_summary_verify` scopes — a bounded
  excerpt — and only after you click Summarize on a saved page.
- **To whom:** exactly one provider origin you chose —
  `https://api.typesafe.ai` (TypeSafe), `https://openrouter.ai` (OpenRouter),
  or the custom endpoint you configured
  — whose own privacy policy governs what it receives
  (`https://typesafe.ai/legal/privacy-policy` and
  `https://openrouter.ai/privacy`; a custom endpoint is governed by its own
  policy — review it before enabling).
- **Why:** to categorize, tag, folder pre-select, run a near-duplicate check,
  run a misfiled scan, and search re-rank.
- **When:** only on a user-started action — saving a bookmark, clicking
  Analyze, starting a library scan, or running an Ask search — and only when
  you start them — never on install, on a timer, or in the background.
- **Links:** the provider's privacy policy above and this extension's privacy
  policy (https://nguyensitrung.github.io/BookmarksManager/privacy/).

### Optional LLM provider features (`llm_test`, `llm_explain`, `llm_escalate`, `llm_restructure`, `llm_summary`, `jev_summary_verify`)

You may optionally configure one OpenAI-compatible LLM provider — an OpenAI
or OpenRouter preset, or a custom HTTPS endpoint (HTTP only for a loopback
service such as `http://localhost:11434`). A custom HTTPS origin is granted
through the manifest's `https://*/*` optional host pattern: the broad
optional host pattern is capability only — it grants the exact configured
origin at runtime from your direct Enable click, never default access, and
it can be revoked like any other host grant. Each feature below is a separate
consent scope, granted per provider origin, and every request is re-checked
against the exact configured origin, the saved consent, the host permission,
and the closed request schema before it can leave the device. Your stored
provider credential goes in the request's authentication header only — never
inside the message body. Notes, the full page DOM, and credentials in the
message body are never sent under any scope.

- **LLM test connection** (`llm_test`) — sends `model`, `messages`, and
  `response_format` as a fixed synthetic request to check that your
  credentials and endpoint respond. Triggered only when you click
  "Test connection".
- **Decision explanations** (`llm_explain`) — sends the decision state, the
  question, the candidate labels, the Jev probabilities, and the selected
  answer to explain a review-queue decision in plain language. Triggered
  only when you click "Explain" on a pending decision.
- **Automatic second opinions** (`llm_escalate`) — sends the decision state,
  the question, the allowed options, the Jev probabilities, and the Jev
  answer for a second opinion on a low-confidence decision. Runs only inside
  a Save, Analyze, or library scan you started, within the spending ceiling
  you chose — a monthly cap, or an explicit "no cap"; it never applies
  changes by itself.
- **Restructure proposals** (`llm_restructure`) — sends folder paths,
  category counts, tag counts, domains, and representative titles (capped)
  to propose a folder structure. Proposals are plans for your review —
  nothing is applied automatically. Triggered only when you start
  "Restructure".
- **Page summaries** (`llm_summary`) — sends the page title, cleaned URL,
  headings, bounded page excerpt, and site name and meta description when
  present to summarize the current page. The page is extracted only after
  you click "Summarize" — never in the background and never in incognito.
- **Jev summary verification** (`jev_summary_verify`) — sends the saved
  bookmark title, cleaned URL, domain, headings, bounded page excerpt, and
  LLM-generated summary to your Jev provider to verify the summary is
  supported by the page. Only as part of a Summarize action you started;
  the page title, site name, and meta description are not added to this hop.

Both summary hops remove the URL's query string, fragment, and embedded
username/password before sending. The original URL stays local for admission
and matching. Notes, the extraction's byline, and the full page DOM are not
included in either summary payload; only a Jev-supported summary is saved,
not the excerpt.

Opening the Summarize dialog only reads the configured recipients and current
consent status. It displays both exact origins, their field lists, and the
consent version before **Agree and summarize** authorizes extraction and
sending. Closing it grants nothing. The worker rechecks the displayed
recipients/version against current configuration before granting consent;
a changed provider requires reviewing again. Unknown-cost confirmation is a
separate choice that retains the accepted recipient/version binding.

Each grant is tied to the exact configured origin (including the port for a
loopback endpoint). Revoking the provider deletes every consent scope at its
origin, removes the host permission, and deletes the stored credential.
LLM spending is metered: each request first reserves an estimated cost from
per-token prices — the built-in price for a preset's default model, or the
rates you enter for any other model. When no price is known, automatic
(unattended) requests refuse to run, and on-demand ones ask for an explicit
confirmation before sending. Nothing is sent on install, on a timer, or in
the background.

The consent is versioned — `consentVersion`, currently 4 — so a change to the
sent fields or recipients re-shows the disclosure before the next request.
Older grants remain stored as stale records and authorize no request until
the user reaccepts for that exact scope and origin; reacquiring one origin
does not refresh another origin's grant.
Revoking a provider deletes **every** consent grant for its origin —
`jev_test`, `jev_decisions`, and every `llm_*` scope — removes its host
permission, and offers to delete its key.

Requests to a provider are governed by that provider's own privacy policy and
retention terms. The in-product disclosure links to
`https://typesafe.ai/legal/privacy-policy` (TypeSafe) and
`https://openrouter.ai/privacy` (OpenRouter); both must be verified against
the providers' real policies before submission.

## API keys

Your API key is yours. It is transmitted only to the provider that issued
it, inside the `Authorization: Bearer` header, over HTTPS, with cookies and
credentials omitted and redirects refused. It is encrypted at rest on your
device (AES-GCM via WebCrypto; the encryption key is stored non-extractably
in IndexedDB) and is never logged, exported, or shown in full — only a masked
last-four hint (or the `****` placeholder for short keys) appears in Options
as a reminder.

## Your choices and deletion

- You can revoke a provider's consent and host permission at any time from
  Options, and choose whether the stored key is deleted too. Revoking removes
  every consent scope for that provider — both the synthetic `jev_test` grant
  and the bookmark-data `jev_decisions` grant — and the consent gate refuses
  contact with that provider afterwards.
- **Delete all extension data** in Options removes everything the extension
  stored for itself: its IndexedDB database (tags, categories, notes, undo
  snapshots, imported-file metadata, consent records, the sent log, and the
  provider key material), `chrome.storage.local` and `chrome.storage.session`,
  and it releases any granted optional host permissions. It **never** touches
  your native Chrome bookmarks — those are byte-identical before and after.
- Uninstalling the extension removes all locally stored data.
- There are no accounts and nothing to delete on the developer's side — the
  developer holds no data.

## Security

All remote requests must use HTTPS, pass through a single audited network
module, require a matching stored consent record at the current consent
version and a live Chrome host permission, and stay limited to the provider
origins listed above. The consent gate, encrypted key storage, the synthetic
Test connection, and the bookmark-data decision flow are all in place — the
build makes no remote requests except the synthetic test request on an
explicit Test connection click, a `jev_decisions` request on a user-started
save, Analyze, library scan, or Ask search, and the separately consented LLM
features above (including both Summarize hops). None send until you configure
a provider and start the corresponding action.

## Limited Use statement

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

In plain terms: this extension uses any data it handles only to provide its
single user-facing purpose (managing your bookmarks, with an optional provider
connection you control). It does not sell your data, does not use it for
advertising, does not use it to determine creditworthiness, and does not let
humans read it. Only the disclosed fields leave the device for the optional
provider features you start; native bookmark management remains local.

## Children

This extension is not directed at children under 13.

## Changes to this policy

Data-handling changes will be disclosed in the extension and will require
renewed consent before the changed feature can send data. The policy version
and effective date above are updated with each release.
