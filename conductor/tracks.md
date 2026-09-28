# Project Tracks

This file tracks major development tracks.

---

<!-- Archived: 2026-09-25 — Phase 0 foundation and TypeSafe/OpenRouter provider connection (see conductor/archive/phase0_foundation_20260925/) -->

---

<!-- Archived: 2026-09-26 — Phase 1 Core manager completed: all 5 phases (data/sync, mutations+undo, import/export, side panel UI, quick save+delete-all) with full gate green (1128 unit/component tests, 7 e2e) and user-accepted manual verification (see conductor/archive/phase1_core_manager_20260926/) -->

---

<!-- Archived: 2026-09-26 — Phase 2 Search completed: MiniSearch fuzzy index + query language (filters/negation/quotes/warnings), side-panel search bar with autocomplete, Ctrl/Cmd+K command palette with commands and per-result actions, popup search, and the `bm` omnibox keyword — all fully local with zero egress; full gate green (1591 unit/component, 11 e2e) and user-accepted manual verification (see conductor/archive/phase2_search_20260926/) -->

---

<!-- Archived: 2026-09-27 — Phase 3 Jev client completed: scoped sendConsented gate (frozen registry, jev_test synthetic-only), hardened client (token/size guards, greedy batching, full-jitter retry + retry-after, per-preset concurrency, response cross-checks, usage accounting), typed defineDecision builder with per-field confidence, scripted mock Jev server, Options moving-alias warnings + verified provider disclosures, provider e2e against a routed fake endpoint, and a key-gated live smoke suite — full gate green (1789 unit/component, 13 e2e) and user-accepted manual verification (see conductor/archive/phase3_jev_client_20260927/) -->

---

<!-- Archived: 2026-09-28 — Phase 4 Jev decisions completed: metadata-only decisions pipeline (title/cleaned-URL/domain minimization with blocklist; notes never sent), six question sets, §10.2 confidence policy with auto-apply off by default (never for move/merge), review queue with audit+undo, resumable job queue incl. near-duplicate pair scans, popup save suggestions, Ask re-rank, usage/cost tracking, "Data sent" log (cap 500), decisions consent v2, Dexie v3 — full gate green (2467 unit/component, 19 e2e) and user-accepted manual verification (see conductor/archive/phase4_jev_decisions_20260927/) -->

---

<!-- Archived: 2026-09-28 — Phase 5 LLM layer completed: optional consent-gated OpenAI-compatible provider (presets + custom HTTPS/loopback origins, generic encrypted credential store, exact-origin egress gate), three-tier structured-output cascade with capability fallback, reservation-based monthly budget, on-demand explanations, budget-capped second opinions on unsure suggestions (never auto-applied), restructure proposals with live diff + guarded apply/undo, opt-in Readability summaries persisted only on Jev verification — full gate green (2865 unit/component, 28 e2e incl. the 9-spec wire-level LLM suite, 6 key-gated live smokes) and user-accepted manual verification (see conductor/archive/phase5_llm_layer_20260928/) -->

---

<!-- Archived: 2026-09-28 — Phase 6 Store readiness and 1.0 trusted-tester release completed: pinned Jev 1.13 evaluation evidence and confidence policy, intentional broad-provider disclosures, strict local store/site gates, self-contained GitHub Pages site, reproducible store assets, audited 1.0.0 trusted-tester ZIP with recorded checksum, and user-confirmed manual verification; public submission remained out of scope (see conductor/archive/phase6_store_release_20260928/) -->
