<!-- Last refreshed: 2026-09-26 -->

# Bookmarks Manager

## Vision

Make saving, finding, and organizing Chrome bookmarks faster and clearer than the built-in manager, without requiring an account, API key, or network connection for core features.

## Users

- Researchers with large bookmark libraries who need fast retrieval.
- Developers who want tagged, searchable references and control over AI providers.
- Privacy- and cost-conscious users who want useful offline features and explicit control over any data sent.

## Core Experience

The Manifest V3 extension provides a quick-save popup and a side-panel manager for native Chrome bookmarks. Users organize bookmarks with folders, tags, and categories; search titles, URLs, domains, tags, and notes; import and export their data; and detect duplicates locally. Native Chrome bookmarks remain the source of truth for the bookmark tree.

## Optional AI

Jev proposes classifications, tags, and folder placement with confidence scores. An optional OpenAI-compatible provider supplies explanations and generative work that Jev cannot do. Suggestions pass a confidence policy, and risky changes require explicit user approval. Nothing is sent to a provider without recipient-specific in-product consent.

## Release Scope

- **1.0:** Complete offline core and optional AI through narrow-permission provider presets, with Chrome Web Store disclosures and review readiness.
- **1.1:** Custom provider base URLs and the opt-in link checker, with their additional permissions and disclosures.
- **v2:** Scheduled maintenance, smart collections, threshold tuning, and other advanced workflows.

## Boundaries

No developer backend, analytics, remote code, or data leaving the device by default. Use the least permissions needed for shipped features. Keep data flows, privacy disclosures, and store materials consistent with actual behavior.

`PROJECT_PLAN.md` contains the detailed feature inventory, architecture, milestones, and store policy checklist. This guide summarizes the approved direction without replacing that plan.

## Delivery Status

- **Phase 0 foundation delivered** (archived `phase0_foundation_20260925`, 2026-09-25): MV3 scaffold, consent-gated Jev provider connection with TypeSafe/OpenRouter presets, WebCrypto-protected provider keys, and CI-guarded store disclosures.
- **Phase 1 core manager delivered** (archived `phase1_core_manager_20260926`, 2026-09-26): the complete offline core — native-bookmark sync with live listeners and startup reconcile, extension metadata (tags/categories/notes) in IndexedDB, a guarded mutation service with LIFO undo, URL-normalized duplicate detection with keep-one merge, JSON/Netscape/CSV import/export, the full side-panel UI (ARIA folder tree, virtualized list/grid, drag and drop, bulk actions, tag manager, duplicates view), quick save via popup/keyboard shortcut/context menu, `_favicon` icons, and "delete all extension data". Verified by a 1128-test unit/component gate plus 7 e2e specs (including zero-egress) and user manual acceptance.
- **Phase 2 search delivered** (archived `phase2_search_20260926`, 2026-09-26): fully local search — a MiniSearch fuzzy index over title, URL, domain, tags, and notes; a query language with filters (`tag:`/`folder:`/`domain:`/`in:`/`is:`/`before:`/`after:`/`has:`), negation, quoted phrases, and inline warnings; the side-panel search bar with autocomplete; a Ctrl/Cmd+K command palette (jump targets, commands, per-result actions); the popup search box; and the `bm` omnibox keyword. Everything computes on-device — queries are never stored or sent, proven by a zero-egress e2e sweep over every surface. Verified by a 1591-test unit/component gate plus 11 e2e specs and user manual acceptance.
- **Not yet built:** the Jev decision pipeline, the optional OpenAI-compatible provider, the opt-in link checker, and scheduled/smart-collection workflows (see Release Scope).
