<!-- Last refreshed: 2026-09-28 -->

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
- **Phase 3 Jev provider layer delivered** (`phase3_jev_client_20260927`, 2026-09-27): the consent-gated provider layer is complete — a scoped `sendConsented` gate (frozen scope registry; `jev_test` admits only the fixed synthetic request), a hardened Jev client with token/size guards, greedy batching, full-jitter retry honoring `retry-after`, per-preset concurrency, and strict response cross-checks, a typed `defineDecision` question-set builder with per-field confidence, a scripted mock Jev server, Options alias warnings with verified provider data notes/privacy links, provider e2e coverage against a routed fake endpoint, and a key-gated live smoke suite. Verified by a 1789-test unit/component gate plus 13 e2e tests.
- **Phase 4 Jev decisions delivered** (track `phase4_jev_decisions_20260927`, archived 2026-09-28): Jev now works on real bookmark metadata behind its own consent scope — data minimization (title, cleaned URL, domain only; notes never sent), in-code candidate shortlists, the analyze pipeline ("one request, many questions" with an answer-ID cross-check), the §10.2 confidence policy with auto-apply limited to tags/category, a review queue with approve/undo, quick-save suggestions (category chips, tag chips, folder pre-select), Ask rerank on search with a no-match bar, persisted resumable library scans (pause/restart/resume, batch-commit progress), per-request usage accounting, and an Options surface for decisions consent, auto-apply toggles, the URL blocklist, and the "Data sent" log.
- **Phase 4 track hardening delivered** (Phase 5 of track `phase4_jev_decisions_20260927` — end-to-end, live, and docs; 2026-09-28): a 6-spec Playwright e2e suite against a wire-level fake provider (zero-egress gate, analyze→approve→undo, popup save suggestions, Ask rerank, pause-restart-resume, auto-resume from the committed batch), an analyze-on-save performance gate (< 1.5 s worst-case at a 10k-bookmark corpus; observed ~67 ms max), and a key-gated live categorize smoke on both presets. Verified by a 2467-test unit/component gate plus 19 e2e tests and user manual acceptance.
- **Phase 5 LLM layer delivered** (track `phase5_llm_layer_20260928`, archived 2026-09-28): an optional, consent-gated OpenAI-compatible LLM provider (presets or a custom HTTPS/loopback origin) now backs decision explanations, budget-capped automatic second opinions on unsure suggestions, restructure proposals with a reviewable diff and guarded apply/undo, and opt-in page summaries verified by Jev before persisting. Page text leaves the device only under the `llm_summary`/`jev_summary_verify` scopes after an explicit Summarize click; the egress gate re-checks the exact configured origin plus a per-scope consent record before every request. Verified by a 2865-test unit/component gate plus a 9-spec wire-level e2e suite and key-gated live smokes.
- **Not yet built:** opt-in page-text extraction as richer *analyze* input (the summarize feature's extraction is summary-scoped only), the opt-in link checker, and scheduled/smart-collection workflows (see Release Scope).
