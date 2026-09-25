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
| `sidePanel` | required | Show the Bookmarks Manager UI in Chrome's side panel |
| `storage` | required | Store extension settings and consent records locally on this device |

## Optional host permissions

Runtime-only grants. The flow that requests them is being built for this
release; when it ships, each request fires only from a direct user action,
and grants remain removable at any time from Chrome's extension settings.

| Pattern | Level | Used for |
|---|---|---|
| `https://api.typesafe.ai/*` | optional | Jev test connection to the TypeSafe provider, started by the user |
| `https://openrouter.ai/*` | optional | Jev test connection to the OpenRouter provider, started by the user |

_The provider flow that uses these two patterns is under construction in this
release; the patterns are declared now so the consent-gated request has a
fixed, narrow target. Any change here must update the manifest in the same
change._

## Declared but empty

- `host_permissions`: none — the extension requests no host access at install
  time.
- `optional_permissions`: none.

## Not requested in this slice

`bookmarks`, `activeTab`, `scripting`, `contextMenus`, `favicon`, `alarms`,
`history`, `tabs`, `cookies`, `webRequest`, `offscreen`, `unlimitedStorage`,
`<all_urls>`, and broad wildcard patterns such as `https://*/*` or `http://*/*`.
None of them ship in this release. Each future permission must be added only
together with the feature that uses it, in the same change that updates this
table, and with a justification — the Chrome Web Store's minimum-permission
rule applies to optional permissions too.
