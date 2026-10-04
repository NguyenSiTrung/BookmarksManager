# Bookmarks Manager

A Chrome extension (Manifest V3) that replaces the built-in bookmark manager
with a faster, more organized experience — local-first, with an optional AI
provider connection you control.

Everything works on your device: no account, no sign-in, no telemetry, no
developer servers, and zero network requests on install, on page load, or in
the background. Your native Chrome bookmarks stay the source of truth.

## Features

**Core (no API key required)**

- **Quick save** from the popup, a keyboard shortcut
  (Ctrl+Shift+Y / Command+Shift+Y), or the right-click menu — with tags,
  notes, a category, and a folder.
- **Side-panel manager**: folder tree, virtualized list/grid, views for all,
  recent, untagged, duplicates, tags, and categories; drag and drop with a
  keyboard-accessible drag mode.
- **Local search everywhere**: a MiniSearch fuzzy index with a filter syntax
  (`tag:`, `folder:`, `domain:`, `is:duplicate`, `before:`, negation, quoted
  phrases) on the side-panel bar, the Ctrl+K / Command+K command palette,
  the popup, and the `bm` omnibox keyword — zero egress.
- **Organize**: color-coded tags, one category per bookmark, notes, undo for
  delete/move/merge/tag-delete.
- **Local duplicate detection** (exact and normalized URLs) with keep-one
  merge.
- **Import/export** as JSON, Netscape HTML, or CSV — local files only, keys
  never exported.
- **Delete all extension data** from the options page; native bookmarks are
  untouched.

**Optional Jev AI decisions** (TypeSafe or OpenRouter, your own key)

- Categorize, tag suggestions, folder pre-select, misfiled scan,
  near-duplicate check, and "Ask" search re-rank — powered by Jev, a decision
  model that returns typed answers with calibrated confidence.
- Metadata only: title, cleaned URL, domain, and candidate names are sent;
  notes never leave the device. A confidence policy decides what may
  auto-apply (off by default); everything else lands in a review queue with
  approve/reject/undo and an audit log.
- Popup suggestions run only after Tags focus or Suggest. Cold startup pauses
  interrupted scans and restructure jobs without sending anything; click
  Resume to continue from the last committed batch.

**Optional LLM layer** (OpenAI-compatible preset or custom endpoint)

- Plain-language decision explanations, budget-capped second opinions on
  low-confidence calls (never auto-applied), folder-restructure proposals
  with a live diff and guarded apply/undo, and opt-in page summaries verified
  by Jev.
- Monthly spending budget you set; per-scope consent tied to the exact origin
  you configured.

## Privacy and security

- No AI call without explicit, versioned consent plus the browser's
  host-permission prompt; revoking removes consent, permission, and key.
- API keys are AES-GCM encrypted at rest and reachable only from the service
  worker.
- A single `fetch` wrapper in `src/net/` enforces the egress gate; a lint
  rule bans `fetch` anywhere else, and e2e tests prove zero-egress surfaces.
- Sensitive-site blocklist, metadata minimization, and a "Data sent" audit
  log you can inspect and clear.

## Status

Version 1.0.0 — implementation-complete through Phase 6 (see
[PROJECT_PLAN.md](PROJECT_PLAN.md) §1.1 for the detailed status table). The
audited trusted-tester ZIP is recorded in `store/releases/`; public Chrome
Web Store submission is pending user-controlled account steps (GitHub Pages
enablement, dashboard answers, publisher declaration, upload + install
smoke).

The Playwright e2e suite is green again: the assertion drift left by the
Options redesign (`BookmarksManager-gyx`, P1) was repaired and the issue
closed on 2026-09-29.

## Development

```bash
npm ci                  # install (lockfile is authoritative)

npm run dev             # WXT dev server with reload
npm run build           # production build to .output/chrome-mv3
npm run zip             # package the extension ZIP

npm run lint            # eslint (includes the fetch-outside-src/net ban)
npm run typecheck       # wxt prepare && tsc --noEmit
npm run test -- --run   # Vitest unit/component suite (jsdom + fake-indexeddb)
npm run test:e2e        # Playwright MV3 suite (Chromium; headed by default)
npm run test:live       # key-gated live provider smokes (needs TYPESAFE_API_KEY/OPENROUTER_API_KEY)
npm run test:eval       # key-gated eval against the labeled corpus

npm run check:manifest  # manifest permissions match store/permissions.md
npm run check:bundle    # no eval()/remote code in the bundle
npm run check:site      # site/ self-containment gate
npm run check:store     # release-strict store-readiness gate
```

Load the built extension from `.output/chrome-mv3` via
`chrome://extensions` → Developer mode → Load unpacked.

Browser tests need Playwright's Chromium (`npx playwright install chromium`).
The suite runs headed by default; set `E2E_HEADLESS=1` to run headless, and on
Linux wrap the headed launch in `xvfb-run -a npm run test:e2e`. Extension
specs must use `channel: "chromium"` — branded Chrome ignores
`--load-extension`. Chrome's native `chrome.permissions.request` prompt cannot
be driven under Playwright (the promise never resolves and no prompt window
exists), so provider specs install a temporary manifest copy that holds the
optional host pattern as a regular permission; exact-origin consent is
otherwise covered by unit/component tests and the routed e2e specs
(`tests/e2e/audit-provider-workflows.spec.ts`). The native prompt itself is a
manual check in a real Chrome install, not automated coverage.

## Tech stack

WXT 0.21, React 19, strict TypeScript, Tailwind 4, Zod 4 (jitless), Dexie
(IndexedDB), MiniSearch, Radix UI primitives, dnd-kit, Vitest +
Testing Library, Playwright.

## Project layout

```
src/
  entrypoints/   background service worker, popup, sidepanel, options, extract content script
  net/           the only fetch wrapper: HTTPS, origin allowlist, consent gate, sent log
  jev/           wire schemas, hardened client, typed decision builder, question sets
  llm/           OpenAI-compatible client, structured-output cascade, budget
  decisions/     policy, review queue, apply/undo, audit, release pins
  jobs/          resumable job runner (analyze, library scan)
  consent/  security/  schemas/  db/  sync/  io/  duplicates/  undo/
  search/  extract/  restructure/  messages/  ui/  eval/
tests/           unit, components, e2e, fakes, fixtures, live, mock-servers, eval
store/           Chrome Web Store material kept in sync with the code (gates enforce it)
site/            GitHub Pages homepage + privacy policy source
conductor/       product/architecture context and archived development tracks
```

## Documentation

- [PROJECT_PLAN.md](PROJECT_PLAN.md) — full plan, status table (§1.1),
  milestones (§15)
- `store/` — listing copy, privacy policy, permission justifications,
  dashboard answers, reviewer notes, release records
- `conductor/` — product and architecture context; `conductor/tracks.md`
  lists archived tracks
- Site (once GitHub Pages is enabled):
  `https://nguyensitrung.github.io/BookmarksManager/`

Issue tracking uses [beads](https://github.com/gastownhall/beads) (`bd`);
see AGENTS.md for the git/commit policy.
