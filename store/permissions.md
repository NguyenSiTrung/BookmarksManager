# Permission inventory

This file is the source of truth for the permissions the extension declares.
`npm run check:manifest` (see `scripts/check-manifest.mjs`) parses the tables
below and fails if the generated `.output/chrome-mv3/manifest.json` disagrees.
Update this file and `wxt.config.ts` in the same change whenever permissions
change.

Row format: `` | `name` | required | justification | `` for install-time
entries and `` | `name` | optional | justification | `` for runtime-optional
entries.
Host match patterns (anything containing `://`, or `<all_urls>`) map to the
manifest's `host_permissions` / `optional_host_permissions`; plain names map to
`permissions` / `optional_permissions`.

## Required permissions

| Permission | Level | Justification |
|---|---|---|
| `activeTab` | required | Read the current tab's title and URL for the quick-save popup when the user opens it; the grant is scoped to that one user action and expires when the tab navigates |
| `bookmarks` | required | Read the native bookmark tree for the side-panel manager UI and write user-initiated create/update/move/remove plus quick-save |
| `contextMenus` | required | Add the right-click "Save page to Bookmarks Manager" and "Save link to Bookmarks Manager" items that quick-save into the last-used folder |
| `favicon` | required | Serve cached page favicons via Chrome's built-in `chrome-extension://<id>/_favicon/?pageUrl=...&size=...` renderer so the manager UI can show site icons without host access or any network request |
| `scripting` | required | Inject the bundled Readability extractor into the active tab only after an explicit Summarize action, so page text can be summarized with consent (spec FR9); there are no static content scripts and no extraction on navigation, install, timers, or scans |
| `sidePanel` | required | Show the Bookmarks Manager UI in Chrome's side panel |
| `storage` | required | Store encrypted provider API-key envelopes in chrome.storage.local; plaintext keys are never persisted |

## Optional host permissions

Runtime-only grants. The shipped Options provider flow requests each pattern
from a direct click on the provider's Enable button — after the user checks
an unchecked consent checkbox — and Chrome shows its permission prompt from
that same click. Grants remain removable at any time from Chrome's extension
settings or from the provider's Revoke action in Options.

| Pattern | Level | Used for |
|---|---|---|
| `https://api.typesafe.ai/*` | optional | Jev provider connection (Test connection and bookmark decisions) to the TypeSafe provider, started by the user |
| `https://openrouter.ai/*` | optional | Jev provider connection (Test connection and bookmark decisions) to the OpenRouter provider, started by the user |
| `https://*/*` | optional | Capability only — lets the user grant the exact origin of a custom OpenAI-compatible LLM provider or a custom System One-compatible Jev endpoint at runtime from a direct click; the egress gate re-checks the exact origin and a per-scope consent record before any request can fire |
| `http://localhost/*` | optional | Optional LLM or custom Jev provider on a loopback endpoint (e.g. a local model server); Chrome patterns cannot express ports, so the gate enforces the full origin (host + port) itself |
| `http://127.0.0.1/*` | optional | Same loopback provider endpoint via the IPv4 literal |
| `http://[::1]/*` | optional | Same loopback provider endpoint via the IPv6 literal |

_The first two patterns back the shipped, consent-gated Jev provider flow — the
synthetic Test connection and the bookmark-data `jev_decisions` flow. The
remaining four back the optional LLM provider and custom Jev endpoints:
`https://*/*` is a capability pattern, not default access — it grants the
exact configured origin at runtime from a direct click, and the loopback
patterns cover local model servers. Every grant is scoped to the exact configured origin
(scheme + host + port), requires its own consent record, keeps credentials
in the authentication header only, refuses redirects and URL credentials,
and revokes cleanly with the provider. Any change here must update the
manifest in the same change._

## Declared but empty

- `host_permissions`: none — the extension requests no host access at install
  time.
- `optional_permissions`: none.

## Not requested in this release

`alarms`,
`history`, `tabs`, `cookies`, `webRequest`, `offscreen`, `unlimitedStorage`,
`<all_urls>`, and the broad `http://*/*` wildcard. None of them ship in this
release — the opt-in link checker that would need the `http://*/*` pattern
stays out of 1.0. Each future permission must be added only
together with the feature that uses it, in the same change that updates this
table, and with a justification — the Chrome Web Store's minimum-permission
rule applies to optional permissions too.
