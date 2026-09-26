<!-- Last refreshed: 2026-09-26 -->

# Technology Stack

The stack below reflects the **installed dependencies in `package.json`** as of the
Phase 1 core manager track (`phase1_core_manager_20260926`, archived 2026-09-26),
built on the Phase 0 foundation (`phase0_foundation_20260925`). Items still
planned in `PROJECT_PLAN.md` but not yet installed are marked **[planned]**.

## Platform

- Chrome extension on Manifest V3, built with **WXT 0.21.4** and Vite (`srcDir: "src"`).
- Strict **TypeScript 6.0.3** throughout; root `tsconfig.json` extends the generated
  `.wxt/tsconfig.json` and must add `"jsx": "react-jsx"` itself.
- Native `chrome.bookmarks` remains the bookmark tree's source of truth.
- Entrypoints: `src/entrypoints/background.ts` service worker plus React/HTML
  `popup/`, `sidepanel/` (emits the `side_panel` manifest key automatically), and
  `options/` surfaces.
- Manifest permissions as of Phase 1: `activeTab`, `bookmarks`, `contextMenus`,
  `favicon`, `storage`, `sidePanel`; `optional_host_permissions` for the
  TypeSafe/OpenRouter preset origins; the `_execute_action` quick-save command
  (`Ctrl+Shift+Y`). `npm run check:manifest` keeps `store/permissions.md`
  justifications in sync.

## Interface and State

- **React 19.3** and **Tailwind CSS 4** (`@tailwindcss/vite` plugin in
  `wxt.config.ts`; `@import "tailwindcss"` in `src/ui/styles.css`; no tailwind
  config file needed).
- **Radix primitives via the `radix-ui` umbrella 1.6.7** (Dialog, DropdownMenu,
  Popover, Checkbox) — adopted in Phase 1 in place of shadcn/ui, which is no
  longer planned. `clsx` 2.1 + `tailwind-merge` 3.7 compose class names.
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
- **Dexie 4.4.6** on IndexedDB (`src/db/database.ts`, **version 2**): v1 tables
  `metadata`, `decisions`, `consents`, `sentLog`, `keyMaterials`; v2 adds
  `bookmarkMeta` (`id,*tags,category,updatedAt`), `tags` (`nameKey`), and `undo`
  (`++id,createdAt`). The metadata/tag repository is `src/db/meta.ts`.
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
- **[planned]** MiniSearch (local fuzzy search), `@mozilla/readability`
  (opt-in page excerpt) — not yet installed.

## AI and Networking

- Thin TypeScript client for Jev's `/v1/systemone` wire format: `src/jev/wire.ts`
  (request/response schemas, `makeSyntheticRequest`) and `src/jev/connection.ts`
  (`testJevConnection` with coded, redacted errors).
- Presets in `src/net/presets.ts`: TypeSafe and OpenRouter model allowlists.
- Network gate `src/net/send.ts` re-verifies
  preset→model→https→origin→consent→host-permission→key on every send; consent
  records and disclosure strings live in `src/consent/`.
- Message layer `src/messages/provider.ts`: total `runtime.onMessage` handlers
  returning `{ok:true,…} | {ok:false,code,message}` Zod-validated unions.
- **[planned]** Optional OpenAI-compatible LLM client for generation and
  second opinions. Pydantic AI informs the typed question-builder design but is
  not a runtime dependency.

## Quality and Delivery

- **Vitest 5** + Testing Library (`@testing-library/react` 16, jsdom 30,
  fake-indexeddb 6.2.5) — `tests/unit`, `tests/components`, `tests/fixtures`,
  and `tests/fakes` (in-memory `chrome.bookmarks` fake with fixed roots).
- **Playwright 1.63** headed persistent-context e2e (`tests/e2e`) — must use
  `channel: "chromium"`; branded Chrome silently ignores `--load-extension`.
- **ESLint 9 flat config** (`eslint.config.mjs`) with typescript-eslint and
  react/react-hooks plugins; egress restriction rules ban `fetch` outside
  `src/net/**`.
- Compliance scripts: `npm run check:manifest` (generated manifest ↔
  `store/permissions.md`) and `npm run check:bundle` (whole-file scan for
  `eval(`, `new Function`, remote `<script src>`).
- GitHub Actions CI (`.github/workflows/ci.yml`, Node 22): lint → typecheck →
  unit → build → manifest check → bundle check → headed Playwright under
  `xvfb-run`.
- No project-owned backend, analytics, or remote code.

See `PROJECT_PLAN.md` for the detailed architecture and staged permission
inventory.
