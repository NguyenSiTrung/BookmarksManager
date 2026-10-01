<!-- Last refreshed: 2026-09-30 (full refresh after starter tags + paper/course) -->

# Technology Stack

The stack below reflects the declared dependencies in `package.json` and
resolved versions in `package-lock.json`, checked on 2026-09-30 after the
custom Jev provider track (`custom_jev_provider_20260929`, archived
2026-09-29). That track added no dependencies; the Options redesign and
Phase 0–6 deliveries remain the baseline. Items still planned in
`PROJECT_PLAN.md` but not yet installed are marked **[planned]**.

## Platform

- Chrome extension on Manifest V3, built with **WXT 0.21.4** and Vite (`srcDir: "src"`).
- Strict **TypeScript 6.0.3** throughout; root `tsconfig.json` extends the generated
  `.wxt/tsconfig.json` and must add `"jsx": "react-jsx"` itself.
- Native `chrome.bookmarks` remains the bookmark tree's source of truth.
- Entrypoints: `src/entrypoints/background.ts` service worker plus React/HTML
  `popup/`, `sidepanel/` (emits the `side_panel` manifest key automatically), and
  `options/` surfaces.
- Manifest permissions as of Phase 6 (1.0.0): `activeTab`, `bookmarks`,
  `contextMenus`, `favicon`, `scripting` (Readability extraction), `storage`,
  `sidePanel`; `optional_host_permissions` cover the TypeSafe/OpenRouter
  presets, the broad `https://*/*` custom Jev/LLM capability, and loopback
  patterns (`localhost`/`127.0.0.1`/`[::1]`); the `_execute_action` quick-save
  command (`Ctrl+Shift+Y`); and `omnibox.keyword = "bm"` for address-bar
  search (no permission needed). `npm run check:manifest` keeps
  `store/permissions.md` justifications in sync.

## Interface and State

- **React 19.3** and **Tailwind CSS 4** (`@tailwindcss/vite` plugin in
  `wxt.config.ts`; `@import "tailwindcss"` in `src/ui/styles.css`; no tailwind
  config file needed).
- **Radix primitives via the `radix-ui` umbrella 1.6.7** (Dialog, DropdownMenu,
  Popover, Checkbox, Switch) — adopted in Phase 1 in place of shadcn/ui, which
  is no longer planned. `clsx` 2.1 + `tailwind-merge` 3.7 compose class names.
  The Options redesign (2026-09-29) vendors **Geist fonts** (woff2 under
  `src/`, resolved through Vite) behind a scoped `.options-root` palette and an
  inline decorative SVG icon set (`src/ui/components/settings-icon.tsx`
  precedent — no icon dependency).
- **`@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0** drive tree/list drag and
  drop (pointer + keyboard sensors); **`@tanstack/react-virtual` 3.14**
  virtualizes the bookmark list/grid; **`dexie-react-hooks` 4.4** backs live
  IndexedDB queries under `src/ui/hooks/`.
- **[planned]** Zustand, TanStack Query — not yet installed; verify versions
  when first introduced.

## Data and Search

- **Zod 4.6.5** in jitless mode for the MV3 CSP — single configuration site
  `src/schemas/z.ts`; every schema file imports `z` from there, never from `zod`
  directly.
- **Dexie 4.4.6** on IndexedDB (`src/db/database.ts`, **version 4**): v1 tables
  `metadata`, `decisions`, `consents`, `sentLog`, `keyMaterials`; v2 adds
  `bookmarkMeta` (`id,*tags,category,updatedAt`), `tags` (`nameKey`), and
  `undo` (`++id,createdAt`); v3 (Phase 4) adds the decisions-UI tables `jobs`
  (`id,status,createdAt` — resumable batch jobs), `audit`
  (`++id,decisionId,changedAt` — decision lifecycle history), and `usage`
  (`++id,jobId,recordedAt` — per-request cost rows); v4 (Phase 5) adds
  `llmUsage` (`++id,providerId,recordedAt`) and `llmReservations`
  (`id,providerId,status`) for LLM budget metering. The metadata/tag
  repository is `src/db/meta.ts`.
- `chrome.storage.local` holds encrypted provider-credential envelopes only;
  `src/security/credentials.ts` owns envelope IO, and `src/security/keys.ts`
  wraps it for Jev while preserving storage IDs. Non-extractable AES-GCM-256
  `CryptoKey` material persists in IndexedDB via structured clone.
  `chrome.storage.session` carries the one-shot popup→side-panel pending-edit
  key; UI prefs live in the `metadata` table under `prefs:*` keys.
- Offline-core modules added in Phase 1: `src/sync/` (typed `chrome.bookmarks`
  slice, listeners, reconcile, `flattenTree` read model), `src/undo/` (LIFO
  snapshots and replay), `src/duplicates/` (URL normalize + grouping),
  `src/io/` (JSON/Netscape/CSV import/export planner + writers), and
  `src/ui/{components,hooks,lib}` (side-panel tree, list/grid, dialogs, toasts).
- `src/db/starter-tags.ts` (2026-09-30): one-shot starter tech tag pack
  (`STARTER_TAGS`, 18 name/description pairs). Seeds only when
  `prefs:starterTagsSeeded` has never been written **and** `listTags()` is
  empty; any decision writes the flag so later emptiness never re-injects.
  Fail-soft (total catch → no-op) and fire-and-forget from `background.ts`.
  Tag `description` is the Jev-facing meaning (≤300 chars, same contract as
  `TagDef`).
- Category enum (`src/schemas/bookmark.ts`) is
  `article | paper | course | docs | tool | video | repo | reference |
  shopping | social | other`. Adding a value must also update the Jev
  `categorize` option docs in `src/jev/tasks/categorize.ts`, search
  unknown-category error text, `category-select.tsx`, and `PROJECT_PLAN.md`
  §7 / §8.4.
- **MiniSearch 7.2.0** powers fully local search (added in Phase 2). The pure
  layer in `src/search/` — `query.ts` (parser + warnings), `index.ts`
  (documents, boosts title>tags>domain>url>notes, `toSourceBookmark`/
  `ancestorsOf`, `buildIndex`, `applyDocDiff`), `run.ts` (`runQuery` executor,
  `SearchIndexHandle`, `buildSearchHandle`, `collectDuplicateIds`),
  `suggest.ts` (autocomplete), `openable.ts` (URL denylist), `omnibox.ts`
  (session-scoped index, XML-escaped ≤8 suggestions, disposition routing) —
  has no React/Chrome imports; surfaces consume it via
  `src/ui/hooks/useSearchIndex.ts` (live diff-updating handle), the shared
  `src/ui/components/query-input.tsx` combobox, `src/sync/tabs.ts`
  (`openBookmarkUrl` typed open slice), and `registerOmnibox()` in
  `src/entrypoints/background.ts`.
- `@mozilla/readability` 0.6 — opt-in page excerpt extraction, used by
  `src/extract/readability.ts` under the click-triggered
  `entrypoints/extract.ts` content script (Phase 5).

## AI and Networking

- Jev provider layer in `src/jev/` (added Phase 3): `wire.ts`
  (request/response schemas, `makeSyntheticRequest`), `budget.ts` (token
  estimation, 32k/64k guards, greedy batch planning), `retry.ts`
  (full-jitter backoff honoring `retry-after`), `usage.ts` (per-request
  token/cost totals), `confidence.ts` (§10.1 per-field confidence),
  `client.ts` (`createJevClient` — batching, retry, per-provider concurrency,
  response cross-checks, typed redacted `JevClientError`s), `connection.ts`
  (`testJevConnection` runs through the client on the `jev_test` scope), and
  `define.ts` (`defineDecision`/`noul`/`choice`/`score` — a Pydantic-style
  typed question-set builder with `build()` and typed `run()`).
- Presets in `src/net/presets.ts`: TypeSafe and OpenRouter model allowlists;
  `src/net/provider-info.ts` holds per-preset UI metadata including the
  frozen moving-alias registry (`jev-latest`, `jev-preview`).
- **Custom Jev provider** (`custom_jev_provider_20260929`):
  `ProviderSettings` is a strict discriminated union in
  `src/schemas/provider.ts`; `JevProviderId` includes `typesafe`,
  `openrouter`, and one `custom` slot. The custom row carries a canonical
  `LlmBaseUrl` and model ID. `src/jev/providers.ts` resolves presets from
  the frozen registry or the custom endpoint as `<baseUrl>/systemone`,
  pinning its model allowlist to the configured ID.
  `src/jev/settings.ts` re-validates stored rows and resolves the active
  provider in stable TypeSafe → OpenRouter → custom order, requiring current
  consent at the resolved origin. Missing/invalid custom settings fail
  closed; HTTPS is required except for literal loopback HTTP.
- Jev gate `src/net/send.ts`: `sendConsented(scope, providerId, …)` resolves
  the destination per call and verifies the model, scheme/exact origin,
  scope request guard, wire schema, origin-scoped consent, host permission,
  and provider key before sending. The frozen scope registry keeps
  `jev_test` synthetic-only. Consent records and disclosures live in
  `src/consent/`.
- LLM gate `src/net/llm-send.ts`: `sendLlmConsented` independently
  re-resolves the configured destination and checks the registered scope,
  wire schema/model pin, exact-origin consent, host permission, credential,
  and budget reservation. These two modules are the provider fetch sites;
  ESLint restricts fetch to `src/net/**`, not to one file.
- Message layer `src/messages/provider.ts`: total `runtime.onMessage` handlers
  returning `{ok:true,…} | {ok:false,code,message}` Zod-validated unions.
- **Phase 4 decisions layer** (all behind the `jev_decisions` consent scope in
  the same gate): `src/jev/tasks/` — six pure question sets
  (`categorize`/`tags`/`placement`/`misfiled`/`near-duplicate`/`rerank`), each
  exporting a `questionSetVersion`; `src/decisions/` — `minimize.ts`
  (title/cleaned-URL/domain only; notes and page text never sent, intranet
  suffixes blocklisted), `candidates.ts` (in-code shortlists for tags/folders),
  `pipeline.ts` (`analyzeBookmark` — one request, many questions; answer-ID
  cross-check; §10.2 policy; persist + usage), `policy.ts` (confidence bands,
  auto-apply limited to `add_tags`/`set_category`), `apply.ts` (guarded apply
  with compensating undo), `store.ts` (persist + lifecycle), `rerank.ts` (Ask
  reordering with the 0.5 no-match bar), `blocklist.ts`, `duplicates.ts`;
  `src/jobs/` — `queue.ts`/`runner.ts` (persisted, resumable, strictly
  sequential per bookmark, batch-commit progress) + `estimate.ts`; and
  `src/messages/decisions.ts` (total handlers: analyze, save-suggest, rerank,
  approve/reject, scan lifecycle). UI: Options consent + auto-apply +
  blocklist + "Data sent" log; sidepanel review queue, scan dialog, and Ask
  toggle; popup suggestion chips.
- **LLM provider layer** (`src/llm/`, added Phase 5): OpenAI-compatible
  presets (OpenAI, OpenRouter) and custom HTTPS/loopback endpoints with a
  canonical base-URL policy; `client.ts` wraps the wire schemas in the
  egress gate; `structured.ts` runs the three-tier output cascade
  (json_schema → json_object → prompt_only) with capability-only fallback
  on 400/404/422 responses; `budget.ts` meters spending with reservations
  and an unpriced manual-confirmation escape, and classifies the record's
  explicit ceiling (`budgetChoiceOf`: capped / unlimited / unset);
  `pricing.ts` resolves the per-token price a reservation uses — the
  built-in table for a preset's default model, else the user's override;
  `escalate.ts` routes unsure decisions for a second opinion without
  applying anything, and only when a ceiling is chosen and pricing is known.
  `src/extract/` holds the click-triggered Readability page extraction;
  `src/restructure/` the bounded synopsis, proposal, Jev assignment, diff,
  and guarded apply.

## Quality and Delivery

- **Vitest 5** + Testing Library (`@testing-library/react` 16, jsdom 30,
  fake-indexeddb 6.2.5) — `tests/unit`, `tests/components`, `tests/fixtures`,
  and `tests/fakes` (in-memory `chrome.bookmarks` fake with fixed roots).
  `tests/mock-servers/jev.ts` is a scripted HTTP fake of the System One
  endpoint (its default answers are schema-valid and pass the pipeline's
  cross-check); `tests/unit/decisions-perf.test.ts` gates analyze-on-save
  (worst-of-10 < 1.5 s at a 10k-bookmark corpus); `tests/live/` is a
  key-gated smoke suite (synthetic probe + live categorize) run only via
  `npm run test:live` (separate `vitest.live.config.ts`, excluded from the
  default run and CI; every test skips when its env key is absent);
  `npm run test:eval` (`vitest.eval.config.ts`) runs the separate key-gated
  evaluation suite.
- **Playwright 1.63** persistent-context e2e (`tests/e2e`) — must use
  `channel: "chromium"`; branded Chrome silently ignores `--load-extension`.
  The suite runs headed by default; `E2E_HEADLESS=1` opts into headless, and
  Linux CI wraps the headed launch in `xvfb-run -a`. `chrome.permissions.request`
  prompts cannot be driven under Playwright, so provider specs install a
  temporary manifest copy that holds the optional host pattern as a regular
  permission; the native prompt itself is not automated. `tests/e2e/helpers/decisions.ts`
  fakes the provider at the WIRE level (a scriptable route with a request
  valve: first N fulfill, the rest held until `release()`) and can relaunch the
  same extension id over a persistent profile to emulate browser restarts
  mid-job. The cross-feature audit regressions live in
  `tests/e2e/audit-data-safety.spec.ts` (+ `helpers/audit-data.ts`) and
  `tests/e2e/audit-provider-workflows.spec.ts` (+ `helpers/audit-provider.ts`).
- **ESLint 9 flat config** (`eslint.config.mjs`) with typescript-eslint and
  react/react-hooks plugins; egress restriction rules ban `fetch` outside
  `src/net/**`.
- Compliance scripts: `npm run check:manifest` (generated manifest ↔
  `store/permissions.md`), `npm run check:bundle` (whole-file scan for
  `eval(`, `new Function`, remote `<script src>`), `npm run check:store`
  (release-strict store-readiness gate over `store/` docs, assets, and the
  release record), `npm run check:site` (static-site gate for `site/`), and
  `npm run zip` (reproducible `wxt zip` release archive).
- GitHub Actions CI (`.github/workflows/ci.yml`, Node 22) runs on every pull
  request and push to `main` with workflow-level `permissions: contents: read`
  and no secrets. The `quality` job runs lint → typecheck → unit → build →
  manifest check → bundle check → site check → headed Playwright under
  `xvfb-run`. A separate `release-checks` job (`needs: quality`) owns the
  release-strict store-readiness gate and runs only for a published release or
  manual dispatch, so routine PRs never run store packaging. A second workflow
  (`.github/workflows/pages.yml`) gates `site/` via `check:site` and deploys
  it to GitHub Pages on manual dispatch or pushes to `main` that change
  `site/**` or the Pages workflow.
- No project-owned backend, analytics, or remote code.

See `PROJECT_PLAN.md` for the detailed architecture and staged permission
inventory.
