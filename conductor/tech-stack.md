<!-- Last refreshed: 2026-09-29 -->

# Technology Stack

The stack below reflects the **installed dependencies in `package.json`** as of
the Options redesign track (`options_redesign_20260929`, archived 2026-09-29),
after the Phase 6 store-readiness/1.0 release track
(`phase6_store_release_20260928`), Phase 5 LLM layer (`phase5_llm_layer_20260928`),
Phase 4 Jev decisions (`phase4_jev_decisions_20260927`), and the earlier
archived Phase 3/2/1/0 tracks. Items still planned in `PROJECT_PLAN.md` but not
yet installed are marked **[planned]**.

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
  presets, the broad `https://*/*` custom-LLM-origin capability, and loopback
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
- `chrome.storage.local` holds provider-key ciphertext envelopes only
  (`src/security/keys.ts`); non-extractable AES-GCM-256 `CryptoKey` material
  persists in IndexedDB via structured clone. `chrome.storage.session` carries
  the one-shot popup→side-panel pending-edit key; UI prefs live in the
  `metadata` table under `prefs:*` keys.
- Offline-core modules added in Phase 1: `src/sync/` (typed `chrome.bookmarks`
  slice, listeners, reconcile, `flattenTree` read model), `src/undo/` (LIFO
  snapshots and replay), `src/duplicates/` (URL normalize + grouping),
  `src/io/` (JSON/Netscape/CSV import/export planner + writers), and
  `src/ui/{components,hooks,lib}` (side-panel tree, list/grid, dialogs, toasts).
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
  `client.ts` (`createJevClient` — batching, retry, per-preset concurrency,
  response cross-checks, typed redacted `JevClientError`s), `connection.ts`
  (`testJevConnection` runs through the client on the `jev_test` scope), and
  `define.ts` (`defineDecision`/`noul`/`choice`/`score` — a Pydantic-style
  typed question-set builder with `build()` and typed `run()`).
- Presets in `src/net/presets.ts`: TypeSafe and OpenRouter model allowlists;
  `src/net/provider-info.ts` holds per-preset UI metadata including the
  frozen moving-alias registry (`jev-latest`, `jev-preview`).
- Network gate `src/net/send.ts` is the only `fetch` site: scoped
  `sendConsented(scope, …)` re-verifies
  preset→model→https→origin→consent→host-permission→key on every send
  against a frozen scope registry (`jev_test` admits only the deep-equal
  synthetic request); consent records and disclosure strings live in
  `src/consent/`.
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
  and an unpriced manual-confirmation escape; `escalate.ts` routes unsure
  decisions for a second opinion without applying anything. `src/extract/`
  holds the click-triggered Readability page extraction; `src/restructure/`
  the bounded synopsis, proposal, Jev assignment, diff, and guarded apply.

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
- **Playwright 1.63** headed persistent-context e2e (`tests/e2e`) — must use
  `channel: "chromium"`; branded Chrome silently ignores `--load-extension`.
  `tests/e2e/helpers/decisions.ts` fakes the provider at the WIRE level (a
  scriptable route with a request valve: first N fulfill, the rest held until
  `release()`) and can relaunch the same extension id over a persistent
  profile to emulate browser restarts mid-job.
- **ESLint 9 flat config** (`eslint.config.mjs`) with typescript-eslint and
  react/react-hooks plugins; egress restriction rules ban `fetch` outside
  `src/net/**`.
- Compliance scripts: `npm run check:manifest` (generated manifest ↔
  `store/permissions.md`), `npm run check:bundle` (whole-file scan for
  `eval(`, `new Function`, remote `<script src>`), `npm run check:store`
  (release-strict store-readiness gate over `store/` docs, assets, and the
  release record), `npm run check:site` (static-site gate for `site/`), and
  `npm run zip` (reproducible `wxt zip` release archive).
- GitHub Actions CI (`.github/workflows/ci.yml`, Node 22): lint → typecheck →
  unit → build → manifest check → bundle check → store-readiness gate →
  headed Playwright under `xvfb-run`. A second workflow
  (`.github/workflows/pages.yml`) gates `site/` via `check:site` and deploys
  it to GitHub Pages on push to `main` or manual dispatch.
- No project-owned backend, analytics, or remote code.

See `PROJECT_PLAN.md` for the detailed architecture and staged permission
inventory.
