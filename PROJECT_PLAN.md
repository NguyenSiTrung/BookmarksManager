# Bookmarks Manager: Chrome Extension Project Plan

## 1. Summary

A Chrome extension (Manifest V3) that replaces the built-in bookmark manager with a faster, more organized experience:

- Intuitive organization with folders, tags, and categories.
- Fast full-text and fuzzy search, with an optional re-ranking step by Jev.
- Strictly typed, runtime-validated data models (Zod) for bookmarks, Jev requests and answers, and every AI result.
- **Jev** (TypeSafe's decision model) as the main AI engine. It classifies, verifies, and places bookmarks, and every answer comes with a calibrated probability or confidence.
- **Jev provider choice with custom base URLs**: TypeSafe directly, OpenRouter, or any gateway that implements the same API.
- **Optional OpenAI-compatible LLM providers** (custom base URL) that analyze, verify, and restructure Jev's decisions. They take the low-confidence cases, explain decisions, and write any text that Jev cannot (summaries, new folder names).
- No AI change is applied without passing a confidence policy, and risky changes always need user approval.
- **Built for public release on the Chrome Web Store** (section 13):
  - Minimal permissions.
  - Nothing leaves the device by default.
  - Explicit in-product consent before any data is sent.
  - No developer servers, no analytics, and no remote code.

### 1.1 Implementation status (as of 2026-09-28)

**Delivered: Phases 0 through 5 of section 15 — the offline core manager, local search on every surface, the consent-gated TypeSafe/OpenRouter layer with the hardened client and typed question builder, the metadata-only decisions pipeline with the review queue, resumable library scans, Ask re-rank, and save-time suggestions, and the optional LLM layer (Phase 5): preset and custom-HTTPS/loopback OpenAI-compatible providers behind origin-scoped consent, the three-tier structured-output cascade, the reservation-based monthly budget, on-demand explanations, budget-capped second opinions that never auto-apply, restructure proposals with live diff and guarded apply/undo, and on-demand Readability summaries persisted only on Jev verification — plus the Phase 5 track's closing integration-hardening phase (a 9-spec LLM e2e suite, live/performance/accessibility gates, compliance sync, and the full release gate)** (archived tracks `conductor/archive/phase0_foundation_20260925/`, `conductor/archive/phase1_core_manager_20260926/`, `conductor/archive/phase2_search_20260926/`, `conductor/archive/phase3_jev_client_20260927/`, `conductor/archive/phase4_jev_decisions_20260927/`, and `conductor/archive/phase5_llm_layer_20260928/`; no conductor track is active — Phase 5 closed with the full gate green and user-accepted manual verification). Statuses below are per plan area; "Partial" means one real path exists and is tested, not that the area is finished.

**Gate at this revision** (re-verified 2026-09-28 at `8905a21`, whose code is unchanged from the last functional commit `4399a74`): `npm run lint` (0 errors, one `react-hooks/incompatible-library` warning on the virtualizer call), `npm run typecheck`, `npx vitest run` (123 files, 2865 tests — green in isolation; see the load-sensitive caveat below), `npm run build` (1.36 MB), `npm run check:manifest`, `npm run check:bundle`, and `npm run test:e2e` (28 Playwright tests in 6 spec files: 6 core-manager, 4 search-surface, 2 provider-setup, 1 shell smoke, 6 decisions, and 9 LLM — fresh-install zero egress, exact-origin consent→enable→test, the three output tiers, Explain with cost confirmation, automatic escalation, budget exhaustion and revoke, summary→Jev verification, restructure apply/undo, and restart from committed progress; all pass headed under `xvfb-run`) all pass, alongside the key-gated live smoke (`npm run test:live`; 6 skipped without keys) and an analyze-on-save performance gate (worst-of-10 < 1.5 s against the mock server at a 10k-bookmark corpus; observed median 29.2 ms, max 34.0 ms — live latency is not gated). CI runs the e2e specs under a headed browser (`xvfb-run`) for MV3 fidelity. Three caveats: the Phase 2 checkpoint recorded lint-green while an unused `findBookmarkByTitle` import sat in `tests/e2e/search.spec.ts` (removed 2026-09-27); a few specs are load-sensitive under parallel Vitest workers and pass in isolation — `tests/components/delete-all.test.tsx` ("keeps a failure visible when the dialog was dismissed mid-operation"), `tests/components/sidepanel-actions.test.tsx` (an `EditDialog` timeout and an undo-toast text race, observed failing only under a full parallel run on 2026-09-28), and the `search-perf` index-build gate (827 ms observed against its 500 ms budget under load); and the provider spec cannot drive Chrome's real host-permission prompt, because `chrome.permissions.request` never resolves under Playwright — `tests/e2e/helpers/provider.ts` patches the built manifest to move the optional origin into `host_permissions` and stubs `permissions.request`, so consent/Enable/Test connection are exercised end to end but the click-to-grant path itself is not (`BookmarksManager-4fb`, P2).

| Plan area | Status | Implemented today | Still missing |
|---|---|---|---|
| §5.1 Core manager | Partial | Quick save from the popup, keyboard shortcut, and context menu; side-panel manager with folder tree, virtualized list/grid, and views (all/recent/untagged/duplicates/tags/categories); tags, categories, notes; drag and drop; undo; local import/export (JSON/Netscape HTML/CSV); local duplicate detection with keep-one merge; `_favicon` icons; delete-all-data; fuzzy search with the full query language (`tag:`, `folder:`, `domain:`, `category:`, `before:`, `after:`, `is:duplicate`, `is:untagged`) and autocomplete on every surface — side panel, popup, the `bm` omnibox keyword, and the Ctrl/Cmd+K command palette (`is:dead` parses but warns, because it needs the link checker) | Opt-in link checker |
| §5.2 Jev decisions | Done | All six question sets (categorize, tags, placement, misfiled, near-duplicate, rerank) shipped with typed `run()` and a `questionSetVersion` (`src/jev/tasks/`); the analyze pipeline runs them on minimized metadata (title, cleaned URL, domain — notes never sent) through the §10.2 policy; popup save suggestions (tag/category chips, folder pre-select at ≥ 0.7); side-panel Review view with approve/reject/bulk and undo; near-duplicate pair scanning; Ask re-rank with a no-match bar | Title-quality check (`BookmarksManager-4hw.7`, follow-up filed); soft-404/`mark_dead` (release 1.1, needs the link checker) |
| §5.3 LLM features | Done | Optional OpenAI-compatible provider (OpenAI/OpenRouter presets + custom HTTPS/loopback endpoints) configured in Options with per-scope consent and a monthly budget; decision explanations on demand (`llm_explain`); automatic budget-capped second opinions on unsure suggestions (`llm_escalate` — verdict rendered on the review row, never auto-applied); restructure proposals with a live before/after diff, guarded apply, and undo (`llm_restructure` + Jev `restructure-v1` assignments, low-confidence rows left unresolved); opt-in page summaries persisted only on Jev `verify-summary` "supported" (`llm_summary` + `jev_summary_verify`, Readability extraction on click) — all through the scoped egress gate, the three-tier structured-output cascade, and the reservation-based budget (`src/llm/`, `src/extract/`, `src/restructure/`) | — |
| §5.4 v2 features | Not started | — | `alarms` scheduling, smart collections, tuning UI, hierarchical classification, per-task routing |
| §6.1 Components | Partial | Service worker (bookmark listeners, startup reconcile, context-menu registration, `bm` omnibox keyword), popup quick save plus search, side-panel manager plus search bar and command palette, Options page, local MiniSearch index and shared query pipeline (`src/search/`, `useSearchIndex`), consented egress in `src/net/`, the hardened Jev client with batching/retry/concurrency/usage and the typed decision builder (`src/jev/`), typed worker↔UI provider and decision messages (`src/messages/`), Dexie v4 plus `chrome.storage.local`; the decisions layer: background handlers with a resumable job runner (`analyze_selection`/`library_scan`, pause/resume/cancel, resume on worker start), popup save suggestions, side-panel Review view, library-scan launcher, and Ask toggle, Options decisions consent/auto-apply/blocklist/"Data sent" panels; the optional LLM layer: provider presets/custom setup UI, structured-output engine, budget ledger, escalation router, summarize + restructure features, and their worker↔UI messages plus LLM sections in Options/side panel; the on-demand Readability extractor (`src/entrypoints/extract.ts` plus `src/extract/`, injected via `chrome.scripting` only after an explicit user action) | Link checker |
| §6.2 Decision pipeline | Done | Minimize → in-code candidates (≤30 tags, ≤50 folders, pair and rerank pre-filters) → question sets → one consented Jev request per bookmark with an answer-ID cross-check → §10.2 policy → persisted decisions; approve/reject/revert/bulk with undo snapshots and one content-free audit row per transition; a resumable job queue with batch-commit progress, cost estimates, and the near-duplicate pair phase; per-request usage accounting; a "Data sent" log capped at 500 rows with Clear (`src/decisions/`, `src/jobs/`) | Quality evals against labeled fixtures (Phase 6) |
| §6.3 Tech stack | Partial | WXT 0.21.4, React 19.3, Tailwind 4, strict TypeScript 6, Zod 4.6.5 (jitless), Dexie 4.4.6 + dexie-react-hooks, MiniSearch 7.2.0, radix-ui primitives, `@dnd-kit/core` + `@dnd-kit/sortable`, `@tanstack/react-virtual`, Vitest 5, Testing Library, Playwright 1.63, ESLint 9 flat, GitHub Actions | the shadcn/ui package (only its primitives were copied into `src/ui/components/`), Zustand, and TanStack Query are not installed |
| §6.4 Directory layout | Partial | `src/{entrypoints,jev,decisions,jobs,net,consent,security,schemas,db,sync,io,duplicates,undo,messages,search,ui,llm,extract,restructure}`, `tests/{unit,components,fixtures,e2e,fakes,live,mock-servers}`, `store/`, `scripts/`, `.github/workflows/` | `tests/fixtures/labeled/`, `store/assets/` |
| §7 Data model | Partial | `Bookmark`, `Tag`, `Decision` (all seven kinds), `DecisionState`, `Job`, `AuditEntry`, `UsageRecord`, `ProviderSettings`, `ConsentRecord` (consent version 3), `BookmarkMeta`, `TagDef`, `UndoSnapshot`, and `ExportEnvelope` schemas with valid/invalid fixtures, plus the decision auto-apply settings schema and the LLM layer's `LlmProviderSettings`, summary-verification, and restructure-plan schemas (`src/schemas/llm.ts`, `summary-verification.ts`, `restructure.ts`); Dexie v4 tables `metadata`, `decisions`, `consents`, `sentLog`, `keyMaterials`, `bookmarkMeta`, `tags`, `undo`, `jobs`, `audit`, `usage`, `llmUsage`, `llmReservations` (a genuine v2→v3 migration preserves rows; v3→v4 adds the two LLM tables) | Bookmark persistence beyond extension metadata (the native tree is the source of truth); any settings schema beyond provider, LLM, and decision settings; a persisted search-index snapshot (every search surface builds its index in memory today) |
| §8.1 Provider presets | Partial | TypeSafe and OpenRouter with fixed endpoints and per-preset model allowlists (`src/net/presets.ts`) | Custom base URLs and the OpenRouter alpha Decisions preset (deferred to 1.1) |
| §8.2 Wire schemas | Done | `src/jev/wire.ts`: SystemOne request/response, Noul/Choice/Score questions, answer-key and answer-type cross-check, synthetic test request | — |
| §8.3 Client behavior | Done | HTTPS-only, origin allowlist, consent plus host-permission plus key re-checked on every call, scoped `sendConsented` gate with a frozen scope registry, 10 s timeout, `credentials: "omit"`, `redirect: "error"`, redacted error messages, 401/422/429/529 mapping, exponential full-jitter backoff honoring `retry-after`, 32k/64k token-estimation guards, 255-option and 10-level guards, greedy batch planning, per-preset concurrency, response cross-checks (answer keys/types, resolved model), per-request usage/cost accounting (`src/net/send.ts`, `src/jev/`) | — |
| §8.4 Typed question-set builder | Done | `defineDecision`/`noul`/`choice`/`score` compile a goal and fields into SystemOne questions; `build()` returns a typed request; `run(client, state)` returns typed values with per-field confidence (noul margin vs. threshold, response confidence for choice/score), raw probabilities, model, and usage (`src/jev/define.ts`, `src/jev/confidence.ts`) | — |
| §8.5 Options setup flow | Partial | Preset choice, key entry with masked suffix, recipient disclosure, unchecked agreement, Enable requesting the origin permission from the click, Test connection showing model/latency/cost, local draft privacy policy, revocation removing consent and permission and offering key deletion (`src/entrypoints/options/`) | Custom base URL and path |
| §9, §10, §11 | Partial | §9 question design: the six question sets with backtick-quoted state fields, option keys equal to candidate IDs, and JSON snapshots per set; §10.2 confidence bands with inclusive/exclusive boundary tests, per-kind auto-apply settings (off by default; `move`/`merge_duplicates` never auto-apply), folder pre-select at ≥ 0.7, and the no-match bar (`src/decisions/policy.ts`); §11 LLM layer: OpenAI-compatible client with a three-tier structured-output cascade and capability-fallback (`src/llm/client.ts`, `src/llm/structured.ts`), per-scope origin-bound consent, the reservation-based monthly budget, escalation routing, explanations, restructure proposals, and Jev-verified summaries | — |
| §12 Security and privacy | Partial | AES-GCM 256 with a non-extractable `CryptoKey` in IndexedDB and ciphertext in `chrome.storage.local`, worker-only key access, masked keys, single `fetch` module, metadata-only sent log, and delete-all-data (IndexedDB plus `chrome.storage.local`/`session` plus granted optional host permissions; native bookmarks untouched); `DecisionState` minimization (URL cleaning strips query/fragment/userinfo; notes excluded), a built-in plus user-managed sensitive-site blocklist enforced in the pipeline and re-checked by the egress gate, and a 500-row sent-log retention cap with Clear; for page text, the on-demand extractor refuses incognito tabs and applies deterministic length caps, runs only after an explicit user action behind its own consent and disclosure, and a summary is persisted only when Jev `verify-summary` reports "supported" | Passphrase mode |
| §13 Store readiness | Partial | Draft `store/` documents describing the shipped core manager, provider slice, local search, the Jev decisions layer, and the LLM layer (consent version 3, per-field disclosure of the minimized state, updated in the same change as the code and guarded by a snapshot test); `check:manifest` and `check:bundle` CI guards; the generated manifest declares `activeTab`, `bookmarks`, `contextMenus`, `favicon`, `scripting`, `storage`, `sidePanel`, the `omnibox.keyword` `bm`, and the `_execute_action` quick-save command, plus the optional origins `https://api.typesafe.ai/*`, `https://openrouter.ai/*`, `https://*/*` (custom LLM origin capability), and the loopback patterns `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*` | Public privacy-policy URL, icon/screenshots/promo assets, dashboard answers, 2-Step Verification and trader declaration, every item of section 13.13 |
| §14 Testing strategy | Partial | 2865 Vitest unit/component tests plus 6 key-gated live smokes; 28 Playwright e2e tests in 6 spec files (13 core/search/provider/shell specs — external-change sync, "Move to…", import/export round trip, delete-all, 10k virtualized render, zero-egress core sweep, side-panel search, command palette, popup search, zero-egress across every search surface, Options consent→Test-connection against a routed fake TypeSafe endpoint, no-consent zero-request guard, shell smoke — plus 6 decisions specs against a wire-level fake provider: zero-egress gate, Analyze→approve→undo with egress-body checks, popup save suggestions with folder pre-select, Ask rerank/no-match/off, pause-restart-resume, auto-resume from the committed batch — and a 9-spec LLM suite against a wire-level fake OpenAI endpoint: fresh-install zero egress, exact-origin consent→enable→test, the three output tiers, Explain with cost confirmation, automatic escalation, budget exhaustion and revoke, summary→Jev verification, restructure apply/undo, and restart from committed progress); a deterministic 10k search performance gate (index build < 500 ms, median query < 50 ms); an analyze-on-save gate (worst-of-10 < 1.5 s at a 10k corpus against the mock server; observed median 29.2 ms, max 34.0 ms); a scripted HTTP mock Jev server (`tests/mock-servers/jev.ts`); a live smoke suite (`npm run test:live`, key-gated, excluded from the default run; provider probes plus a live categorize check on both presets, LLM probes, and a live decisions check — 6 smokes, all skipped without keys); accessibility gates (accessible-name, focus-restore, and live-region assertions across the LLM and core dialogs — `tests/components/llm-accessibility.test.tsx` and the dialog suites); manifest and bundle compliance tests; CI running the full gate | labeled fixtures, quality evals |
| §15 Phases | Phases 0–5 done; Phases 6–8 open | See the status column in section 15 | — |

Fourteen Beads issues are open, all backlog rather than tracked here: one follow-up filed from the archived Phase 4 track (title-quality check `BookmarksManager-4hw.7`) — its page-text sibling `4hw.6` was superseded and closed when the Phase 5 track shipped the on-demand Readability extractor; seven P3 `followup phase0` items — `src/messages/provider.ts` split, per-preset key-store serialization, egress lint breadth, e2e positive control, background protocol note, keys IV-branch test, and bundle-script hardening (the sent-log retention cap was closed during Phase 4); four Phase 4 review deferrals — the near-duplicate pair cap `2qk` and its O(k²)-prefilter `w6y`, the popup suggestion-row lifecycle `f7c`, usage rows for cross-check failures `eov`; plus `BookmarksManager-sb9` (move the popup↔sidepanel handoff helpers out of `popup/chrome.ts` into `src/sync/`), and `BookmarksManager-4fb` (the optional-host-permission prompt is unreachable under Playwright). Three of the fourteen are P2 (`2qk`, `f7c`, `4fb`); the other eleven are P3. Nothing in the plan's remaining scope is blocked on them.

---

## 2. Jev: What It Is and How It Works

Sources: [Pydantic AI: TypeSafe (Jev)](https://pydantic.dev/docs/ai/models/typesafe/), [Pydantic AI: Decision models](https://pydantic.dev/docs/ai/models/decision/), [TypeSafe API reference](https://docs.typesafe.ai/api), [TypeSafe models](https://docs.typesafe.ai/models), [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev).

### 2.1 Key facts

- Jev is a **decision model**, not a language model. It answers typed questions about a piece of text and **never writes text**. It returns no explanations or reasoning.
- One request contains:
  - a `state`: the material to judge, such as a string, JSON object, or array;
  - named `questions`: many of them, answered in parallel in the same request.
- There are three question types:

| Type | Asks | Returns |
|---|---|---|
| **Noul** | Yes or no | `noul`: probability of yes (0 to 1) |
| **Choice** | Pick one option from a set (at most 255 options) | `choice`, `probabilities` per option, `confidence` |
| **Score** | Rate against ordered, described levels (2 to 10 levels) | `score` (can land between levels), `probabilities`, `legend`, `confidence` |

- The answer is always one of the allowed values, so there is no text to parse and no "hallucinated" label.
- **Pricing** (Jev 1.13): $0.042 per million input tokens. Output tokens are free. Adding more questions to one request costs tokens, not time.
- **Limits**:
  - The state plus the longest single question must fit in 32k tokens.
  - The state plus all questions together must fit in 64k tokens.
  - Input is text only.
  - English gives the best accuracy.
- **Rate limits** (TypeSafe direct): 250,000 tokens per second and 1,200 requests per minute. Rate-limited requests get `429`; an overloaded service returns `529`.
- **Model names**:
  - `jev-latest` and `jev-preview` are aliases that move with each release.
  - A versioned ID such as `jev-1.13.0` can also be used.
  - Once confidence thresholds have been tuned, pin the version they were tuned against, because a new release can shift the numbers.

### 2.2 Where Pydantic fits

Pydantic AI's `TypeSafeModel` is the Python integration. It turns a Pydantic `output_type` into Jev questions:

- The model docstring becomes the goal.
- Each field's description becomes that field's question.
- Enum member docstrings describe what each option means.
- `BoolCriteria` describes what yes and no mean.

It also provides `FallbackModel`, which hands low-confidence or unfillable steps to a language model.

This project calls Jev **directly from the extension in TypeScript**, as decided, so Pydantic AI is not a runtime dependency. The extension reproduces the same pattern:

- A small typed builder (section 8.4) declares a goal, fields, and option descriptions, and maps them to Jev questions.
- Answers are parsed back into a typed object with per-field confidence.
- An LLM cascade in TypeScript plays the role of `FallbackModel`.

A Python/Pydantic service can be added later without changing the wire format, because both sides speak the same `/v1/systemone` JSON.

### 2.3 What Jev does poorly, and what this project does about it

| Jev limitation | Design response in this extension |
|---|---|
| Reads questions literally | Every question states the exact condition; boundary cases go into `criteria` |
| Arithmetic, counting, and date comparison | Done in code: bookmark age, visit counts, duplicate counts, and date filters never go to Jev |
| Indirection (multi-hop questions) | One judgment per question; questions refer to state fields by name, for example "Does `bookmark.title` describe `page`?" |
| Accuracy drops when state has irrelevant detail | Page text is trimmed to metadata, headings, and a short excerpt; folder and tag candidates are pre-filtered in code |
| Adversarial text can move answers | Page content is untrusted. Decisions based on page text never auto-apply destructive actions; deterministic checks (HTTP status, URL normalization) run first |
| A question and its negation need not add up to 1 | Each decision is asked one way only; each threshold is tuned for that specific question |
| Cannot generate text | Summaries, rationales, and new folder names go to the optional LLM provider |

---

## 3. Goals and Non-Goals

### Goals
1. Make saving, finding, and organizing bookmarks faster than Chrome's native manager.
2. Keep native Chrome bookmarks as the source of truth for the tree.
3. Validate every piece of stored data, Jev request, Jev answer, and LLM output against a schema.
4. Use Jev for cheap, fast, calibrated decisions, and use confidence to decide whether to act, ask the user, or escalate to an LLM.
5. Support TypeSafe, OpenRouter, and custom base URLs for Jev, and any OpenAI-compatible endpoint for LLMs.
6. Never apply a risky AI change without explicit user approval.
7. Pass Chrome Web Store review, and stay compliant with the Chrome Web Store User Data Policy after publication.

### Non-Goals (v1)
- A project-owned backend server. All calls go from the extension straight to the user's chosen provider, and the developer receives no user data.
- Analytics, telemetry, or crash reporting. Adding any of these later requires a disclosure update and new consent (section 13).
- Cross-browser support (the architecture keeps it possible).
- Full page archiving.
- Team or shared libraries.

---

## 4. Target Users

- **Heavy researchers** with thousands of bookmarks who cannot find anything.
- **Developers** who want tagged, searchable reference links and control over which AI provider is used.
- **Cost- and privacy-conscious users**. Jev is very cheap: analyzing about 10,000 bookmarks costs under $1. Only the text needed for each decision is sent.

---

## 5. Feature Set

### 5.1 Core (MVP, no AI required)
- **Quick save** from the popup, a keyboard shortcut, or the context menu, with tags, notes, and a folder.
- **Side panel manager** with a folder tree, list or grid view, and drag and drop.
- **Tags** (many-to-many, with colors and descriptions) and **categories** (one per bookmark).
- **Search**: instant fuzzy search over title, URL, domain, tags, and notes.
  - Filters: `tag:`, `folder:`, `domain:`, `category:`, `before:`, `after:`, `is:dead`, `is:duplicate`, `is:untagged`.
  - A command palette (Ctrl/Cmd+K).
- **Two-way sync** with native Chrome bookmarks.
- **Import and export**: Netscape HTML, JSON (schema-validated), and CSV. Exports never include API keys or consent records.
- **Duplicate detection (local)**: exact and normalized URL duplicates, computed on the device.
- **Site icons** via Chrome's built-in `_favicon` API (`favicon` permission). Third-party icon services, such as Google's or DuckDuckGo's favicon URLs, would leak every bookmarked domain.
- **Link checker (opt-in)**: HTTP status and redirects for bookmarked sites. It is off by default and has its own disclosure and optional permission (section 13.9).
- **Works without any API key.** All core features function fully offline, so reviewers and users who never configure AI still get a complete product.

### 5.2 Jev decision features (v1)

| Feature | Jev questions (section 9) | Resulting decision |
|---|---|---|
| **Auto-categorize** | One Choice over categories | `set_category` |
| **Tag suggestions** | One Noul per candidate tag (pre-filtered to about 30 in code) | `add_tags` |
| **Folder placement** on save | One Choice over candidate folders | `move` (or a pre-selected folder in the save dialog) |
| **Soft-404 and parked-page detection** (release 1.1, needs the link checker) | Noul: "Is `page` an error page, parked domain, or login wall instead of the content described by `bookmark.title`?" | `mark_dead` |
| **Near-duplicate check** | Score on candidate pairs found in code | `merge_duplicates` |
| **Title quality** | Noul: "Does `bookmark.title` describe `page`?" | Flag for rename (the new title comes from the LLM or the page `<title>`) |
| **Misfiled bookmark scan** | Choice over folders, compared in code with the current folder | `move` |
| **Search re-rank** | Nouls over the top 20 to 30 keyword results for a query | Better result order; "no match" detection |

### 5.3 LLM features on top of Jev decisions (v1, optional)
These need an OpenAI-compatible provider. The original goal was to use LLMs to "analyze, verify, or restructure the Jev decisions":

- **Analyze (explain)**: Jev returns no rationale. On request, the LLM writes a short explanation for a decision in the review queue.
- **Verify (second opinion)**: when Jev's confidence is in the low band, the same decision is sent to the LLM with the Jev probabilities attached. The LLM returns a schema-validated verdict: `agree`, `disagree` with an alternative, or `unsure`.
- **Restructure**: the LLM proposes a new folder layout (names and descriptions), because only a generative model can invent names. Jev then assigns each bookmark to the proposed folders using Choice questions, cheaply and with confidence. Low-confidence assignments go back to the LLM or to the user.
- **Summaries**: the LLM writes a summary, and Jev then checks "Is `summary` supported by `page`?". This is TypeSafe's "Jev-verified cascade" pattern in reverse.

### 5.4 Advanced (v2)
- Scheduled maintenance with `chrome.alarms`: weekly link checks and auto-tagging of new bookmarks. The `alarms` permission is added only in this release, because the store policy forbids requesting permissions for features that are not built yet.
- Smart collections (saved searches).
- Threshold tuning UI: label a sample of decisions, then pick thresholds per question from the results (see section 10.3).
- Hierarchical folder classification for trees with more than 255 folders (section 9.3).
- Per-task provider routing, for example Jev through OpenRouter and summaries through a local Ollama model.

---

## 6. Architecture

### 6.1 Components (Manifest V3)

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Chrome Browser                            │
│  ┌─────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Popup  │  │  Side Panel  │  │ Options Page │  │ Content      │   │
│  │ save,   │  │ manager,     │  │ providers,   │  │ Script       │   │
│  │ search  │  │ review queue │  │ thresholds   │  │ (on demand)  │   │
│  └────┬────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│       └──────────────┴────────┬────────┴─────────────────┘           │
│                               │ typed messages (Zod)                 │
│                   ┌───────────▼────────────┐                         │
│                   │     Service Worker     │◄──► chrome.bookmarks    │
│                   │ ─ Bookmark sync        │                         │
│                   │ ─ Search index         │                         │
│                   │ ─ Job queue            │                         │
│                   │ ─ Jev client ──────────┼──► TypeSafe / OpenRouter│
│                   │ ─ Confidence router    │    / custom gateway     │
│                   │ ─ LLM client ──────────┼──► OpenAI-compatible    │
│                   │ ─ Consent gate + net   │    (optional)           │
│                   │ ─ Link checker (opt-in)│                         │
│                   └───────────┬────────────┘                         │
│                   ┌───────────▼────────────┐                         │
│                   │ IndexedDB (Dexie)      │                         │
│                   │ chrome.storage.local   │                         │
│                   └────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────────┘
```

- **Service worker**: the only component that holds API keys and talks to providers. MV3 service workers stop when idle, so jobs are saved in IndexedDB and processed in resumable batches.
- **Content script**: there are no static `content_scripts` entries in the manifest. The extraction script is injected only after a user action, using `activeTab` plus `chrome.scripting`. It extracts page metadata, headings, and a Readability excerpt for Jev's `state`, and it never runs in incognito tabs.
- **Network gate** (`src/net/`): the only module allowed to call `fetch`. It enforces HTTPS (only loopback may use plain HTTP), allows only consented destinations, and writes a local "Data sent" log (section 13.12).
- **No offscreen document**: link-checker HTML (title and meta tags only) is parsed with a small bundled parser in the service worker, which avoids the extra `offscreen` permission.

### 6.2 Decision pipeline

```
bookmark ──► deterministic checks (code) ──► build Jev state + questions
                                                 │
                                                 ▼
                                         Jev /v1/systemone
                                                 │
                                                 ▼
                                   Zod-validate answers, compute confidence
                                                 │
                      ┌──────────────────────────┼──────────────────────────┐
                      ▼                          ▼                          ▼
               high confidence            medium confidence           low confidence
         auto-apply (if allowed           review queue                LLM second opinion
          for this decision kind)                                     (if configured),
                                                                      else "unsure"
                      └──────────────────────────┴──────────────────────────┘
                                                 ▼
                                   audit log + undo snapshot
```

### 6.3 Tech stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict) | Type safety end to end |
| Extension framework | **WXT** (Vite-based) | MV3 support, hot reload, manifest generation |
| UI | React + Tailwind CSS + shadcn/ui | Mature, accessible components |
| State | Zustand + TanStack Query | Local state plus an async cache |
| Schemas | **Zod v4** | TypeScript counterpart of Pydantic; validates Jev and LLM payloads; `z.toJSONSchema()` for LLM structured outputs. Configure `z.config({ jitless: true })` so Zod never tries `new Function` code generation, which the MV3 CSP blocks and store reviewers may flag |
| Jev client | **Own thin `fetch` client** (section 8.3) | Works in the service worker, supports custom base URLs and paths, and validates every response with Zod |
| Database | Dexie.js (IndexedDB) | Indexes, live queries, migrations |
| Keyword search | MiniSearch | Fast fuzzy search; produces the shortlist for Jev re-ranking |
| Page extraction | @mozilla/readability | Clean excerpt for Jev's `state` |
| Testing | Vitest, Testing Library, Playwright, mock Jev and LLM servers | Unit, component, and end-to-end tests |
| CI | GitHub Actions | Lint, type check, test, build zip |

**Why not the official `@typesafe-ai/sdk` directly?**
- Its docs target Node.js 20+.
- Browser use requires `dangerouslyAllowBrowser: true`.
- It always appends `/v1/systemone`, so gateways with other paths (such as OpenRouter's alpha Decisions API) cannot be reached.
- Its `models.list()` rejects OpenRouter's model list format.

The wire format is small (section 8.2), so an own client of about 150 lines is simpler and fully under our control. The SDK stays a useful reference for types, and it can be swapped in later if it proves reliable in a service worker.

### 6.4 Directory layout

```
BookmarksManager/
├── PROJECT_PLAN.md
├── package.json
├── wxt.config.ts
├── src/
│   ├── entrypoints/
│   │   ├── background.ts            # service worker
│   │   ├── popup/  sidepanel/  options/
│   │   └── extract.content.ts       # on-demand page extraction
│   ├── schemas/                     # Zod models: bookmark, tag, decision, settings
│   ├── jev/
│   │   ├── wire.ts                  # Zod schemas for /v1/systemone request and response
│   │   ├── client.ts                # fetch client: base URL, path, auth, retries, timeouts
│   │   ├── presets.ts               # TypeSafe, OpenRouter, custom
│   │   ├── define.ts                # typed question-set builder (Pydantic-style)
│   │   ├── confidence.ts            # Noul margin, confidence bands
│   │   ├── budget.ts                # token estimate, 32k/64k guards, 255-option guard
│   │   └── tasks/                   # categorize, tags, placement, health, duplicates, rerank
│   ├── llm/                         # OpenAI-compatible client, structured outputs, cascade
│   ├── decisions/                   # review queue, apply, undo, audit log, policy
│   ├── net/                         # the only fetch wrapper: HTTPS, allowlist, consent check, sent-log
│   ├── consent/                     # disclosure screens, consent records, CONSENT_VERSION
│   ├── db/  sync/  search/  jobs/  security/  ui/
├── store/                           # Chrome Web Store material, kept in sync with the code
│   ├── listing.md                   # name, summary, description, category
│   ├── privacy-policy.md            # published to the project website
│   ├── permissions.md               # justification per permission (dashboard text)
│   ├── privacy-practices.md         # dashboard answers: single purpose, data types, remote code
│   ├── reviewer-notes.md            # test instructions for store reviewers
│   └── assets/                      # icon 128, screenshots, promo tile
├── tests/
│   ├── unit/  e2e/
│   ├── fixtures/labeled/            # labeled bookmarks for threshold tuning and evals
│   └── mock-servers/                # fake Jev (/v1/systemone) and fake OpenAI server
└── .github/workflows/ci.yml
```

---

## 7. Data Model (Zod)

```ts
// src/schemas/bookmark.ts
export const Category = z.enum([
  "article", "docs", "tool", "video", "repo", "reference", "shopping", "social", "other",
]);

export const Bookmark = z.object({
  id: z.string(),                          // Chrome bookmark node id
  url: z.url(),
  title: z.string().min(1).max(500),
  folderId: z.string(),
  tags: z.array(z.string()).default([]),
  category: Category.optional(),
  notes: z.string().max(10_000).optional(),
  summary: z.string().max(2_000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  health: z.object({
    status: z.enum(["unknown", "ok", "redirect", "dead", "soft_dead", "error"]),
    httpCode: z.number().int().optional(),
    finalUrl: z.url().optional(),
    checkedAt: z.iso.datetime().optional(),
  }).default({ status: "unknown" }),
  schemaVersion: z.literal(1),
});

export const Tag = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300).optional(), // shown to Jev as the option's meaning
  color: z.string().optional(),
});
```

```ts
// src/schemas/decision.ts
const DecisionBase = z.object({
  id: z.uuid(),
  bookmarkIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(), // raw Jev distribution
  rationale: z.string().max(1_000).optional(),                // LLM-written, on request
  status: z.enum(["pending", "auto_applied", "approved", "rejected", "applied", "reverted", "unsure"]),
  source: z.object({
    engine: z.enum(["jev", "llm", "rule"]),
    providerId: z.string(),
    model: z.string(),                    // versioned id from the response, e.g. jev-1.13.0
    questionSetVersion: z.string(),       // bump when question wording changes
  }),
  escalation: z.object({ llmVerdict: z.enum(["agree", "disagree", "unsure"]), llmModel: z.string() }).optional(),
  createdAt: z.iso.datetime(),
});

export const Decision = z.discriminatedUnion("kind", [
  DecisionBase.extend({ kind: z.literal("set_category"), category: Category }),
  DecisionBase.extend({ kind: z.literal("add_tags"), tags: z.array(z.string()).min(1) }),
  DecisionBase.extend({ kind: z.literal("move"), targetFolderId: z.string() }),
  DecisionBase.extend({ kind: z.literal("mark_dead"), evidence: z.enum(["http", "soft_404", "parked", "login_wall"]) }),
  DecisionBase.extend({ kind: z.literal("merge_duplicates"), keepId: z.string() }),
  DecisionBase.extend({ kind: z.literal("rename"), newTitle: z.string() }),
  DecisionBase.extend({ kind: z.literal("create_folder"), path: z.array(z.string()).min(1), description: z.string() }),
]);
```

**Storage split:**
- `chrome.bookmarks`: the tree.
- IndexedDB: metadata, decisions, audit log, job queue, and the search index snapshot.
- `chrome.storage.local`: settings and API keys. Keys are encrypted at rest (section 12) and never go into `chrome.storage.sync`.
- Consent records: stored locally as `{ scope, providerOrigin, consentVersion, acceptedAt }` (section 13.5).

---

## 8. Jev Provider Setup

### 8.1 Provider presets

| Preset | Base URL | Endpoint | API key | Model value | Notes |
|---|---|---|---|---|---|
| **TypeSafe** | `https://api.typesafe.ai` | `POST /v1/systemone` | TypeSafe key from [console.typesafe.ai/keys](https://console.typesafe.ai/keys) | `jev-latest`, `jev-preview`, or `jev-1.13.0` | `GET /v1/models` lists available aliases |
| **OpenRouter** | `https://openrouter.ai/api` | `POST /v1/systemone` | OpenRouter key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | `jev-latest` (maps to `~typesafe/jev-latest`), `jev-1.13`, or `typesafe/jev-1.13` | Response adds `id`, `provider`, and `usage.cost` (USD). OpenRouter's `/v1/models` uses a different format, so the model list is built in (the TypeSafe list call is not reused). Billed to the OpenRouter account; no TypeSafe account needed |
| **OpenRouter Decisions (alpha)** | `https://openrouter.ai/api/alpha` | `POST /decisions` | OpenRouter key | `typesafe/jev-1.13` | Same body and answers. Alpha API: one user reported about 15% read timeouts. Offered as an advanced option only |
| **Custom** | user-provided, HTTPS only | path configurable, default `/v1/systemone` | user-provided | user-provided | For self-hosted proxies or gateways that implement the TypeSafe spec |

All presets use `Authorization: Bearer <key>` and `Content-Type: application/json`.

### 8.2 Wire schemas (Zod)

```ts
// src/jev/wire.ts
const Text = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]);

export const NoulQuestion = z.object({
  type: z.literal("noul"),
  instructions: Text,
  criteria: z.object({ true: Text.optional(), false: Text.optional() }).optional(),
});
export const ChoiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: Text,
  criteria: z.record(z.string(), Text.nullable())
    .refine((c) => { const n = Object.keys(c).length; return n >= 2 && n <= 255; }, "2 to 255 options"),
});
export const ScoreQuestion = z.object({
  type: z.literal("score"),
  instructions: Text,
  criteria: z.array(Text).min(2).max(10),
});
export const Question = z.discriminatedUnion("type", [NoulQuestion, ChoiceQuestion, ScoreQuestion]);

export const SystemOneRequest = z.object({
  model: z.string(),
  state: Text,
  questions: z.record(z.string(), Question),
});

export const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal("choice"), choice: z.string(),
             probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
  z.object({ type: z.literal("score"), score: z.number(), legend: z.record(z.string(), z.string()),
             probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
]);

export const SystemOneResponse = z.object({
  model: z.string(),                       // versioned id that answered
  answers: z.record(z.string(), Answer),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cost: z.number().optional(),           // OpenRouter only
  }),
  id: z.string().optional(),               // OpenRouter only
  provider: z.string().optional(),         // OpenRouter only
});
```

After parsing, the client also checks that every question key has an answer of the **same type**. A missing or mismatched answer is an error, just as Pydantic AI raises `UnexpectedModelBehavior`.

### 8.3 Client behavior (`src/jev/client.ts`)

- **Config per provider**: `baseUrl`, `path`, `apiKey`, `model`, optional `pinnedModel`, `extraHeaders`, `timeoutMs` (default 10,000, matching the SDK), `maxRetries` (default 2), and `maxConcurrency`.
- **Always explicit about instructions**: every question sends `instructions`, even though the TypeSafe SDK treats the field as optional. OpenRouter's schema marks it as required.
- **Before sending**:
  - Check the request against `SystemOneRequest`.
  - Check the choice option cap (255) and score level cap (10).
  - Estimate tokens (about 4 characters per token, plus a 25% margin for JSON) to stay under 32k for the state plus the longest question and under 64k in total.
  - Requests that are too large are split, or the state is trimmed. Nothing is sent that will fail.
- **Retries**: exponential backoff with jitter on `429`, `529`, `5xx`, timeouts, and network errors, honoring `retry-after`. No retry on `401` or `422`; those surface as configuration or bug errors.
- **Usage accounting**: store `usage.input_tokens` and `usage.cost` (when present) per job, and show the running cost in the UI.
- **Record `response.model`** on every decision, so each result is traceable to the exact Jev version.

### 8.4 Typed question-set builder (Pydantic-style, in TypeScript)

This mirrors Pydantic AI's rules:
- The goal plays the role of the model docstring.
- Each field's question plays the role of the field description.
- Option descriptions play the role of enum member docstrings.
- Noul criteria play the role of `BoolCriteria`.

```ts
// src/jev/define.ts (sketch)
const categorize = defineDecision({
  goal: "Classify a saved bookmark for a personal bookmark library.",
  fields: {
    category: choice("Which kind of resource is `bookmark`?", {
      article:   "A blog post, news story, essay, or tutorial meant to be read.",
      docs:      "Official documentation or an API reference for a product or library.",
      tool:      "A web app or online utility the user interacts with.",
      video:     "A page whose main content is a video or a video channel.",
      repo:      "A source code repository or package registry page.",
      reference: "A wiki, dictionary, cheat sheet, or other lookup resource.",
      shopping:  "A product page or online store.",
      social:    "A social media profile, post, or discussion thread.",
      other:     "None of the above describes it well.",
    }),
    is_evergreen: noul("Will `page` still be useful to read a year from now?", {
      true:  "Reference material, fundamentals, or tools that do not go out of date quickly.",
      false: "News, announcements, time-limited offers, or version-specific notes likely to go stale.",
    }),
  },
});

const result = await categorize.run(jev, state);
// result.values.category: Category (typed)
// result.confidence.category: number
// result.confidence.is_evergreen: number (Noul margin, section 10.1)
```

`run()` builds the questions, calls the client, validates the answers, and returns typed values plus per-field confidence and the raw probabilities.

### 8.5 Setup flow in the Options page

1. Choose a preset (TypeSafe, OpenRouter, or Custom). For Custom, enter the base URL and path. The URL must be `https://`; plain `http://` is accepted only for `localhost` and `127.0.0.1`.
2. Paste the API key. It is encrypted and stored in `chrome.storage.local`.
3. **Read and accept the data disclosure** for this provider (section 13.5). Nothing is sent before this step.
4. Grant the host permission. When the user clicks, the extension calls `chrome.permissions.request({ origins: ["<origin>/*"] })` for that provider only. Chrome requires a user gesture for this call.
5. **Test connection**:
   - Send one tiny Noul request (about 300 input tokens, costing a tiny fraction of a cent).
   - Show the returned `model`, the latency, and `usage.cost` when available.
   - Map errors to clear messages: `401` means a bad key, `422` means the gateway is incompatible, and `429`/`529` means try again later.
6. Choose the model: an alias or a pinned version. The UI warns that thresholds tuned on one version may not carry over to another.
7. Show the provider's data notes and link to its privacy policy:
   - TypeSafe says Jev is not trained on customer requests. Zero data retention is available on enterprise plans.
   - For OpenRouter, the data policy on the Jev model page applies.

The full manifest and a justification for each permission are in section 13.3. With a host permission granted, service worker `fetch` calls to that origin are not blocked by CORS.

---

## 9. Jev Question Design for Bookmarks

General rules, taken from TypeSafe's guidance:
- **State is only what is judged.** Questions live in `questions`.
- **State is an object with named fields**, and questions refer to those fields in backticks.
- **One judgment per field.** Composite judgments are combined in code.
- **Filter before sending.** Do not dump the whole page or the whole library into the state.

### 9.1 Analyze a single bookmark (one request, many questions)

```json
{
  "model": "jev-latest",
  "state": {
    "bookmark": { "title": "Tokio tutorial: async in depth", "url": "https://tokio.rs/tokio/tutorial/async", "domain": "tokio.rs" },
    "page": {
      "description": "Learn how async/await works under the hood in Tokio.",
      "headings": ["Futures", "Wakers", "Executors"],
      "excerpt": "In this section we explore how Rust futures are polled..."
    }
  },
  "questions": {
    "category": { "type": "choice", "instructions": "Which kind of resource is `bookmark`?", "criteria": { "article": "...", "docs": "...", "tool": "..." } },
    "tag_rust":  { "type": "noul", "instructions": { "tag": { "name": "rust", "description": "The Rust programming language" }, "question": "Is `page` mainly about `tag`?" } },
    "tag_async": { "type": "noul", "instructions": { "tag": { "name": "async", "description": "Asynchronous programming" }, "question": "Is `page` mainly about `tag`?" } },
    "folder":    { "type": "choice", "instructions": "Which folder should `bookmark` be filed in?", "criteria": { "f_12": "Programming / Rust", "f_31": "Programming / Web", "none": "None of these folders fits." } }
  }
}
```

- **Tag candidates**: the top 30 tags by keyword and domain overlap, chosen in code. Each becomes its own Noul, because a Choice picks only one option and tags are "yes or no per option".
- **Folder candidates**: the top 50 folders by path and content similarity, plus a `none` option. Folder IDs are option keys; paths and sample titles are the descriptions.
- **Page text** is sent only when the user enables it. Otherwise the state is title, URL, and domain only, which is still enough for most category and tag decisions.

### 9.2 Verify

| Check | Done by | Question |
|---|---|---|
| HTTP 4xx/5xx, DNS failure, redirect chain | Code | none |
| Exact or normalized URL duplicate | Code | none |
| Soft 404, parked domain, login wall | Jev | Noul on `{bookmark, page}` with criteria that describe each case |
| Near-duplicate pair (same domain, similar title in code) | Jev | Score: "Do `a` and `b` point to the same content?" Levels: *unrelated*, *same topic but different content*, *same content at a different URL or version*, *identical page* |
| Title describes the page | Jev | Noul: "Does `bookmark.title` describe `page`?" |

### 9.3 Restructure

1. **Misfiled scan**: for each bookmark, ask a Choice over existing folders. If Jev picks a different folder than the current one with high confidence, propose `move`.
2. **Large trees (more than 255 folders)**: classify level by level. First pick a top-level folder, then a child folder inside it, keeping the top two branches when confidence is low. This follows TypeSafe's hierarchical classification recipe.
3. **New layout** (needs an LLM):
   - The LLM proposes folder paths and descriptions as structured JSON validated by Zod.
   - Jev assigns every bookmark to the proposed folders.
   - The user sees a before-and-after tree diff with confidence shading.
   - The user applies the change as one batch, with a snapshot for undo.

### 9.4 Search re-rank ("Ask")

1. MiniSearch returns a shortlist of the top 30 results for the query.
2. Jev answers one Noul per candidate: "Does `bookmark` match what `query` is looking for?". This is one request with 30 questions.
3. Results are sorted by probability. If every probability is below the "no match" bar, the UI says so instead of showing weak results.

### 9.5 Cost estimate

| Workload | Tokens (approx.) | Cost at $0.042 per million |
|---|---|---|
| Analyze one bookmark (metadata only, about 40 questions) | 1,500 | about $0.00006 |
| Analyze 10,000 bookmarks | 15 million | about $0.63 |
| One re-ranked search | 3,000 | about $0.00013 |

LLM escalations cost extra and depend on the chosen LLM. They are limited to the low-confidence band, and a monthly budget cap stops them automatically.

---

## 10. Confidence Policy

### 10.1 Reading confidence

- **Choice and Score answers**: use the returned `confidence`, which the API derives from the probability distribution.
- **Noul answers** have no `confidence` field. Compute a margin from the probability `p` and the threshold `t` (default 0.5), using Pydantic AI's formula:
  - when `p ≥ t`: margin = `(p − t) / (1 − t)`
  - when `p < t`: margin = `(t − p) / t`

### 10.2 Bands and actions, configurable per decision kind

| Decision kind | Auto-apply | Review queue | Escalate to LLM or mark unsure |
|---|---|---|---|
| `add_tags`, `set_category` | confidence ≥ 0.85 (off by default, one toggle) | 0.5 to 0.85 | < 0.5 |
| `move` (on save, pre-select only) | never auto-moves; pre-selects the folder when ≥ 0.7 | 0.5 to 0.7 | < 0.5 |
| `move` (misfiled scan), `merge_duplicates`, `mark_dead` | **never** | confidence ≥ 0.5 | < 0.5 |
| `create_folder`, restructure plans | **never** | always | not applicable |

- Actions that destroy or move data always require the user.
- These starting values are conservative. They are tuned per question on labeled data (section 10.3) and pinned to a model version.

### 10.3 Threshold tuning
- Ship a labeled fixture set of about 300 bookmarks across categories, tags, and folders.
- An eval script runs the question sets against Jev and reports accuracy against the auto-apply rate for each threshold.
- After a model version change or a question wording change, re-run the evals, then bump `questionSetVersion`.

---

## 11. OpenAI-Compatible LLM Layer (optional)

Used only for tasks Jev cannot do or is unsure about.

- **Providers**: OpenAI, OpenRouter chat models, Groq, Together, Mistral, DeepSeek, Ollama, LM Studio, vLLM, LiteLLM, or custom. Each has its own base URL, key, model, and headers. Each also needs its own consent, because it is a different recipient, and its own host permission requested per origin.
- **Endpoints**: `/chat/completions`, `/models`.
- **Structured output tiers**:
  1. `response_format: json_schema` (strict), using `z.toJSONSchema()`;
  2. `response_format: json_object`, with the schema in the system prompt;
  3. prompt-only, with JSON extraction from the reply.

  In every tier, the reply is validated with Zod, and the model gets up to 2 repair attempts that include the validation error.
- **Escalation payload**: the LLM receives the same `state`, the question wording, the options, and Jev's probabilities. It returns `{ verdict: "agree" | "disagree" | "unsure", choice?: string, rationale: string }`.
- **Local servers**: Ollama needs `OLLAMA_ORIGINS=chrome-extension://*`, or it rejects requests from the extension. The UI shows this hint when it detects the error.

---

## 12. Security and Privacy

- **Nothing leaves the device by default.**
  - A fresh install makes no network requests at all.
  - Every outbound request goes through `src/net/`, which blocks any destination without a matching consent record.
- **API keys** (authentication information under the store policy):
  - Encrypted at rest by default with WebCrypto AES-GCM. The key is non-extractable and stored in IndexedDB, so extension code cannot read out the raw key material.
  - Optional passphrase mode (PBKDF2-derived key) for stronger protection.
  - Used only by the service worker, and sent only to the provider that issued the key, in the `Authorization` header.
  - Never exposed to content scripts or pages, never logged, never included in exports or error text, and never shown in full after entry (masked except the last 4 characters).
  - The UI suggests using a key with a credit limit.
- **Transport**:
  - HTTPS only for every remote destination; custom base URLs with `http://` are rejected unless they point to loopback (`localhost`, `127.0.0.1`).
  - `credentials: "omit"` on every request, so no site cookies are sent.
- **Least privilege**:
  - Only the permissions listed in section 13.3.
  - Host permissions are optional, requested one origin at a time, and removed with `chrome.permissions.remove` when a provider or feature is turned off.
  - No `history`, `tabs`, `cookies`, `webRequest`, or `alarms` in v1.
- **Data minimization, all on by default**:
  - Metadata-only mode. Page excerpts need a separate opt-in.
  - Query strings, fragments, and `user:password@` credentials are removed from URLs before anything is sent.
  - A built-in sensitive-site blocklist, editable by the user, means matching bookmarks are never sent. It covers banking, health portals, webmail, `file://` URLs, private IP ranges, and intranet hostnames without a dot.
  - Notes are never sent.
  - Page text is never extracted from incognito tabs.
- **User control**:
  - A "Delete all extension data" button removes the database, settings, keys, and consent records.
  - Uninstalling removes all local data.
  - A "Data sent" log shows the time, destination, feature, and field names of each outbound request (not the content).
- **Adversarial pages**:
  - Jev treats state as data, and TypeSafe warns that injected text can move its answers.
  - Page-derived decisions therefore never auto-apply destructive actions.
  - Deterministic checks run first, and IDs in answers are checked against the candidates that were sent.
- **Transparency**: the Options page shows exactly which fields each task sends, and to which provider.

---

## 13. Chrome Web Store Readiness and Privacy Compliance

Sources: [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies), [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [Review process](https://developer.chrome.com/docs/webstore/review-process). Policies change; re-read them before every submission.

### 13.1 Policies that apply and how the plan meets them

| Policy | Requirement | How this plan meets it |
|---|---|---|
| Privacy Policy | Any product that handles user data (**even if only stored locally**) must post an accurate privacy policy that lists all parties data is shared with | Privacy policy on the project website, linked in the dashboard (13.6) |
| Limited Use | Use data only for the disclosed single purpose. Browsing activity only for a prominent user-facing feature. No selling, ads, or credit use. No humans reading data | No developer servers; data goes only to the provider the user picked, for the feature the user started |
| Limited Use statement | An affirmative statement on a website belonging to the extension | Included in the privacy policy (13.6) |
| Disclosure Requirements | Prominent in-product disclosure and **affirmative consent before** handling data. The store description or privacy policy alone is not enough. Re-disclose when practices change | Consent screens per recipient and feature, with a versioned consent (13.5) |
| Handling Requirements | Transmit with modern cryptography; keep authentication info secure; never disclose it publicly | HTTPS only, keys encrypted at rest, never exported or logged (section 12) |
| Use of Permissions | Narrowest permissions; applies to **optional permissions too**; no "future-proofing" | Permission inventory with per-release introduction (13.3) |
| Quality: single purpose | One narrow, easy-to-understand purpose | Everything serves bookmark organization; no general "chat with any page" feature (13.2) |
| Manifest V3 code rules | No remote code, no `eval` of fetched strings, no interpreter for remote commands | All logic bundled; AI output is data mapped to a closed set of decision kinds (13.8) |
| Code Readability | No obfuscation; minification allowed | Readable build and a public source repository (13.8) |
| Listing Requirements | Description, icon, and screenshots required; accurate metadata; no keyword spam | Listing plan (13.10) |
| Impersonation | No implied endorsement by Google or other companies | No Google, Chrome, TypeSafe, or OpenRouter logos; neutral wording (13.10) |
| Minimum Functionality | No broken features | The core works without any API key; AI features explain what they need |
| 2-Step Verification | Required on the developer account | Publishing checklist (13.11) |
| Dashboard consistency | Any mismatch between dashboard answers, privacy policy, and behavior can suspend **all** of the publisher's items | `store/` docs updated in the same change as the code, plus CI checks (13.12) |

### 13.2 Single purpose statement (draft for the dashboard)

> Organize, search, and clean up your Chrome bookmarks. Optional AI suggestions (categories, tags, folders, duplicate and dead-link detection, and search ranking) use an AI provider that you choose and configure with your own API key.

**Scope rule for future features**: every feature must act on the user's bookmarks. Features such as "summarize any page", "chat with the web", or a new-tab dashboard belong in a separate extension.

### 13.3 Permission inventory

**Required permissions (v1):**

| Permission | Justification (dashboard text) | Install warning |
|---|---|---|
| `bookmarks` | Core feature: read, organize, move, and edit the user's bookmarks. | "Read and change your bookmarks" |
| `storage` | Store settings, tags, notes, decisions, and encrypted API keys on the device. | none |
| `sidePanel` | Show the bookmark manager in Chrome's side panel. | none |
| `contextMenus` | Right-click "Save to Bookmarks Manager". | none |
| `activeTab` | Read the current tab's title and URL when the user saves it; extract page text only when the user clicks Analyze. | none |
| `scripting` | Inject the page-extraction script into the active tab after that user action (only with `activeTab`, never automatically). | none |
| `favicon` | Show site icons locally through Chrome's `_favicon` API instead of a third-party icon service. | none expected; confirm in a test install |

**Optional host permissions**, requested at runtime from a user click and removable at any time:

| Pattern | Used for | Requested when |
|---|---|---|
| `https://api.typesafe.ai/*` | Jev through TypeSafe | The user adds the TypeSafe provider |
| `https://openrouter.ai/*` | Jev and LLMs through OpenRouter | The user adds OpenRouter |
| Hosts of the other LLM presets (for example `https://api.openai.com/*`) | LLM provider | The user adds that preset |
| `http://localhost/*`, `http://127.0.0.1/*` | Local LLM servers on the same device | The user adds a local provider |
| `https://*/*` | (a) Custom HTTPS base URL: only that single origin is requested. (b) Link checker: reading HTTP status of bookmarked sites | The user saves a custom provider, or turns on the link checker |
| `http://*/*` | Link checker only, for old bookmarks that still use `http://` | The user turns on the link checker |

**Not requested in v1:**
- `alarms`: added with scheduled maintenance in v2.
- `history`, `tabs`, `cookies`, `webRequest`, `offscreen`, `unlimitedStorage`.
- Any required host permission.

**Manifest (release 1.0 omits only `http://*/*` — the link checker would need it in a later release):**

```json
{
  "manifest_version": 3,
  "permissions": ["bookmarks", "storage", "sidePanel", "contextMenus", "activeTab", "scripting", "favicon"],
  "optional_host_permissions": [
    "https://api.typesafe.ai/*",
    "https://openrouter.ai/*",
    "https://api.openai.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    "https://*/*",
    "http://*/*"
  ]
}
```

**Implemented today (2026-09-28):** the generated manifest declares `activeTab`, `bookmarks`, `contextMenus`, `favicon`, `scripting`, `storage`, and `sidePanel`, plus the `omnibox.keyword` `bm` (which needs no permission) and the `_execute_action` quick-save command. `scripting` backs the on-demand Readability extractor (`src/entrypoints/extract.ts`, shipped with the Phase 5 summaries): the script is injected only after an explicit user action on the active tab — there are no static content scripts and no extraction on navigation, install, timers, or scans. The optional origins today are `https://api.typesafe.ai/*`, `https://openrouter.ai/*`, `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`, and `http://[::1]/*`: the first two back the Jev presets, and the rest are capabilities for the optional LLM layer, whose egress gate grants and re-checks the exact configured origin (scheme, host, and port) per scope before any request can fire. The broad `https://*/*` pattern is therefore already in the shipped manifest, so the staged-release split recommended below no longer describes it. The Phase 4 decisions layer added **no** new permissions — it sends bookmark metadata only to the origins the user already granted for the provider, and `npm run check:manifest` keeps the manifest in sync with `store/permissions.md`. Each remaining permission above is added with the feature that needs it, so no "future-proofing" appears in a shipped manifest (section 1.1, `store/permissions.md`).

**Approved release scope (Phase 6).** The earlier staged-release recommendation — custom base URLs deferred to 1.1 — was superseded: version 1.0 ships custom OpenAI-compatible providers, so the broad `https://*/*` optional capability and the loopback patterns are intentional release behavior. `https://*/*` is a capability pattern, not default access: it grants only the exact configured origin at runtime, behind exact-origin consent, the permission prompt, refused redirects/credentials, and clean revocation. The minimum-permission policy still applies to optional permissions.
- **1.0** ships the core plus the TypeSafe and OpenRouter presets, the LLM presets, and custom base URLs via `https://*/*`.
- **1.1** adds the opt-in link checker, together with `http://*/*`.

Adding optional permissions in an update does not disable the extension for existing users. Only new *required* permissions trigger Chrome's re-approval prompt.

### 13.4 Data inventory

| Data | Store category | Stored where | Leaves the device? | Recipient | Trigger |
|---|---|---|---|---|---|
| Bookmark titles, URLs (cleaned), domains, folder names | Web history | Chrome bookmarks, IndexedDB | Only after AI consent | The chosen Jev provider; the LLM provider for escalations | Save, Analyze, bulk jobs, AI search: all started by the user |
| Tag names and descriptions | User-generated content | IndexedDB | As question options, after AI consent | Jev provider | Same as above |
| Notes | User-generated content | IndexedDB | **Never** | none | none |
| Page excerpt (description, headings, short excerpt) | Website content | Not stored; only derived results are kept | Only with the separate page-text consent | Jev and LLM providers | The user clicks Save or Analyze |
| AI search queries | User-generated content | Recent searches (local, clearable) | After AI consent | Jev provider | The user runs an AI search |
| Link checker requests | Web history, website content | Status results only | A request goes to each bookmarked site | Those sites (they see the user's IP address) | The user starts a link check |
| API keys | Authentication information | Encrypted in local storage | Only in the `Authorization` header | The provider that issued the key | Each request to that provider |
| Anything to the developer | none | none | **Never** | none | no analytics, crash reports, or remote config |

### 13.5 In-product disclosure and consent

- **Before the first request to any recipient**, show a disclosure screen in the extension UI (not only in the privacy policy or the store listing). It states:
  - **What** is sent: the exact fields from 13.4. The page-text line appears only if that toggle is on.
  - **To whom**: the provider name and its literal origin, for example "OpenRouter (openrouter.ai), which forwards Jev requests to TypeSafe", or the custom origin.
  - **Why**: the feature it powers.
  - **When**: only when the user saves, analyzes, starts a job, or runs an AI search.
  - **Links**: the provider's privacy policy and this extension's privacy policy.
- **Affirmative action**: an unchecked "I agree" checkbox plus an "Enable" button. Cancel leaves the feature off. There are no pre-checked boxes, and no consent is inferred from closing the dialog.
- **Separate consents**:
  - each Jev provider;
  - each LLM provider;
  - page text;
  - the link checker.
- **Versioned**: `CONSENT_VERSION` is increased whenever the set of sent fields or recipients changes. The extension then shows the updated disclosure again before the next request, because the store policy requires disclosing data practice changes after install.
- **Revocable**: turning a feature or provider off deletes its consent record, removes its host permission, and offers to delete its key.
- **Enforced in code**: the `src/net/` gate refuses any request that has no matching consent record for its scope and origin. An end-to-end test checks this.

### 13.6 Privacy policy

Host it on a project website, such as GitHub Pages, one click from the homepage, and link it in the dashboard. Keep the source in `store/privacy-policy.md`.

Outline:
1. Who publishes the extension and how to contact them.
2. **Summary**: "The developer does not collect, receive, or store any of your data. Everything stays in your browser unless you turn on a feature that sends data to a provider you choose."
3. Data stored locally, taken from the 13.4 inventory.
4. Data sent to third parties at your direction:
   - TypeSafe, OpenRouter, the LLM providers you configure, and any custom endpoint you enter;
   - the websites contacted by the link checker;
   - the exact fields sent and when.
5. Default protections: metadata only, URL cleaning, sensitive-site blocklist, notes never sent.
6. Third-party processing and retention, governed by each provider's policy (with links).
7. API keys: encrypted on the device, sent only to their issuer.
8. No sale of data, no advertising use, no creditworthiness use, and no human access to your data.
9. **Limited Use statement**, verbatim: "The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements." This is followed by a plain description of how the extension complies.
10. How to delete data: the "Delete all extension data" button, revoking a provider, uninstalling.
11. Security: HTTPS, encryption at rest.
12. Not directed at children.
13. Changes to this policy: an in-extension notice plus renewed consent; version and effective date.

### 13.7 Dashboard "Privacy practices" answers (draft)

- **Single purpose**: the text from 13.2.
- **Permission justifications**: the text from 13.3.
- **Remote code**: "No, I am not using remote code."
- **Data usage**: declare conservatively, because under-declaring is the risky direction:
  - **Web history**: bookmark URLs and titles, sent to the user-chosen AI provider when AI features are on; link-checker requests.
  - **Website content**: page excerpts when enabled; link-checker responses.
  - **Authentication information**: the user's API keys, stored encrypted and sent only to their issuer.
  - Not collected: personally identifiable information, health, financial, personal communications, location, user activity (no click or keystroke monitoring).
- **Certifications**: tick all three Limited Use certifications (no sale, no unrelated use, no creditworthiness use).
- **Privacy policy URL**: from 13.6.

Google sets the checkbox labels in the dashboard, and they can change. Map this inventory to the current labels at submission time.

### 13.8 Remote code, AI output, and code readability

- All JavaScript is bundled by WXT:
  - no CDN scripts;
  - no `eval`, `new Function`, or string timers;
  - no remote config that changes behavior.
  Question sets and prompts ship inside the package.
- **AI output is data, not instructions.**
  - Jev and LLM responses are parsed by Zod into a **closed set** of decision kinds (section 7).
  - Fixed code applies them, only after the confidence policy and user approval.
  - A model can never choose an API call, a URL to open, or a code path.
  - This keeps the design clear of the store's rule against interpreters for remotely fetched commands.
- The build is minified at most, never obfuscated. Consider submitting it unminified and linking the public source repository to make review easier.
- A CI step scans the built bundle for `eval(`, `new Function`, and `<script src="http`. Any hit fails the build unless it is on a reviewed allowlist.

### 13.9 Link checker safety

The link checker contacts third-party sites on the user's behalf, so it has extra safeguards:
- **Off by default**, with its own disclosure: "Checking links sends a request from your browser to each bookmarked website. Those websites can see your IP address and that the page was requested."
- Requests use `credentials: "omit"`, a `HEAD` request first, and a `GET` fallback that reads at most 64 KB. Redirects are followed at most 5 times.
- **Skipped URLs**:
  - query parameters that look like secrets or actions (`token`, `key`, `sig`, `auth`, `session`, `code`, `reset`, `unsubscribe`, `logout`, `delete`, `confirm`);
  - private IP ranges, loopback, and intranet hostnames;
  - non-HTTP schemes;
  - blocklisted domains.
- Rate limits: at most 1 request per second per domain and 4 at a time overall. The user can pause or cancel.
- Soft-404 detection sends page content to Jev only if the user has also given page-text consent.

### 13.10 Store listing

- **Name**: descriptive and original. Avoid "Chrome" or "Google" in a way that implies Google made or endorses it, and use no third-party logos.
- **Description**:
  - Plain feature list.
  - States that AI features are optional and need the user's own API key from a supported provider.
  - Explains what is sent when those features are on.
  - Names providers once, in context, rather than as a keyword list (the store's keyword spam rule).
  - No unverifiable claims such as "100% private" or "best".
- **Assets**:
  - icon 128×128 (plus 16, 32, and 48 in the package);
  - at least one screenshot at 1280×800 or 640×400 showing the real UI;
  - small promo tile 440×280.
- **URLs**: homepage, support (email or issue tracker), and privacy policy.
- **Reviewer notes** (`store/reviewer-notes.md`, and the dashboard's test-instructions field if it offers one):
  - how to test the core without a key;
  - that AI features need the user's own key;
  - optionally, a temporary low-credit test key that is revoked after review.

### 13.11 Developer account and publishing

- Register a Chrome Web Store developer account (one-time registration fee).
- Turn on 2-Step Verification (required), and verify a contact email that is monitored and not spam-filtered.
- Complete the trader or non-trader declaration the dashboard asks for (EU). Traders must provide contact details that are shown publicly.
- **Review time**: usually a few days, sometimes a few weeks. It is longer for new developers, new extensions, and broad host permissions. Plan calendar buffer, and keep the 1.0 permissions narrow (13.3).
- Release to trusted testers or as unlisted first, then publish publicly.
- Answer store emails quickly: warnings give 7 to 30 days to fix an issue before takedown.

### 13.12 Keeping code and disclosures consistent

- **One network module**: an ESLint `no-restricted-globals` rule bans `fetch` everywhere except `src/net/`. That module enforces HTTPS, the consent gate, the destination allowlist, and the local "Data sent" log.
- **Manifest snapshot test**: CI fails if `manifest.json` permissions differ from the list in `store/permissions.md`.
- **Consent snapshot test**: CI fails if the fields that a task sends change without a `CONSENT_VERSION` increase and matching changes to `store/privacy-practices.md` and `store/privacy-policy.md`.
- **Release checklist item**: re-read the store policies and each provider's data policy, then update the listing if anything changed.

### 13.13 Pre-submission checklist

- [ ] Fresh install makes zero network requests (verified in DevTools).
- [ ] Every remote request is HTTPS and passes through `src/net/`, with a consent record.
- [ ] A disclosure and consent screen appears before the first request to each recipient; the checkbox is unchecked by default.
- [ ] Manifest permissions match 13.3; no unused permission; each has a justification.
- [ ] No `alarms`, `history`, `tabs`, `cookies`, `webRequest`, or `<all_urls>` in 1.0.
- [ ] Favicons come from `_favicon`, with no third-party icon service.
- [ ] API keys are encrypted at rest, masked in the UI, and absent from exports, logs, and error messages.
- [ ] The privacy policy is live, lists all recipients, and contains the Limited Use statement.
- [ ] The dashboard privacy practices match 13.7 and the privacy policy.
- [ ] The bundle scan finds no `eval`, `new Function`, or remote scripts; Zod runs in jitless mode.
- [ ] The core features work with no API key; AI features clearly explain what they need.
- [ ] The listing has a description, icon, screenshots, and support and privacy URLs, with no keyword lists or endorsement claims.
- [ ] 2-Step Verification is on, the contact email is verified, and the trader status is declared.
- [ ] Reviewer notes are written.

---

## 14. Testing Strategy

| Level | Tooling | Coverage |
|---|---|---|
| Schemas | Vitest | Valid and invalid fixtures for bookmarks, decisions, and Jev wire request/response (including OpenRouter's extra fields) |
| Jev client | Vitest + mock Jev server | Base URL and path joining, auth header, 401/422/429/529 handling, retry-after, timeouts, answer type mismatch, token and option guards |
| Question builders | Vitest (snapshot tests) | Exact JSON sent for each task; `instructions` always present |
| Confidence policy | Vitest | Band boundaries, Noul margin math, "never auto-apply" rules |
| LLM layer | Vitest + mock OpenAI server | Structured output tiers, repair loop, escalation verdicts |
| End-to-end | Playwright with the unpacked extension | Provider setup and test connection, save with folder pre-select, review queue approve and undo |
| Live smoke test (manual or nightly) | Script with real keys | One request each to TypeSafe and OpenRouter, checking that response shapes still match the Zod schemas |
| Quality evals | Script + labeled fixtures | Accuracy and auto-apply rate per question set and model version |
| Store compliance | Vitest + Playwright + CI scripts | Zero requests on a fresh install; consent gate blocks unconsented origins; `http://` rejected for non-loopback URLs; exports contain no keys; manifest matches `store/permissions.md`; bundle scan for `eval` and remote scripts; permissions removed when a feature is turned off |

**Performance targets**: keyword search under 50 ms at 10k bookmarks (the Phase 2 perf gate measured a 213 ms index build and a ~15 ms median query on its synthetic 10k corpus); popup opens in under 150 ms; Jev analyze on save takes under 1.5 s end to end, including page extraction.

---

## 15. Milestones and Timeline

Estimates assume one developer working full time.

| Phase | Status (2026-09-28) | Scope | Estimate |
|---|---|---|---|
| **0. Setup** | **Done** — extended with the provider-connection slice (see 1.1) | WXT, TypeScript strict, lint (including the `fetch` ban outside `src/net/`), Vitest, Playwright, CI (manifest snapshot and bundle scan), base Zod schemas (jitless), Dexie, `store/` skeleton | 4 days |
| **1. Core manager** | **Done** — offline core manager shipped (see 1.1) | Sync, side panel, popup save, tags, categories, drag and drop, import/export (no secrets), local duplicate detection, `_favicon` icons, "Delete all data" | 2 weeks |
| **2. Search** | **Done** — MiniSearch index, full query language with inline warnings, side-panel search bar with autocomplete, Ctrl/Cmd+K palette with commands and per-result actions, popup search, and the `bm` omnibox keyword, all local with zero egress (see 1.1) | MiniSearch index, query syntax, command palette | 1 week |
| **3. Jev provider layer** | **Done** — scoped consent gate, hardened client (batching, retry/backoff, concurrency, usage), typed question-set builder with per-field confidence, mock Jev server, e2e provider coverage, and a key-gated live smoke suite shipped (see 1.1); alpha Decisions preset deferred to 1.1 | Wire schemas, `src/net/` gate, fetch client, presets (TypeSafe, OpenRouter, alpha Decisions), consent screens and records, runtime host permissions, encrypted keys, test connection, token and option guards, mock Jev server, typed builder | 2 weeks |
| **4. Jev decisions** | **Done** — delivered and user-verified on the track `phase4_jev_decisions_20260927` (archived 2026-09-28): metadata-only data minimization with URL cleaning and a sensitive-site blocklist, all six question sets, the §10.2 confidence policy with auto-apply limited to tags/category (off by default), the review queue with audit and undo, a resumable job queue (analyze selection, library scan with near-duplicate pairs), popup save suggestions, Ask re-rank, cost/usage tracking, the "Data sent" log with a retention cap, decisions consent version 2, and the track's closing hardening suite (6 e2e specs, analyze-on-save perf gate, key-gated live categorize) — see 1.1 | Categorize, tags, folder pre-select, near-duplicates, misfiled scan, search re-rank, confidence policy, review queue, audit log, undo, cost tracking, "Data sent" log | 2.5 weeks |
| **5. LLM layer** | **Done** — delivered and user-verified on the track `phase5_llm_layer_20260928` (archived 2026-09-28): preset and custom-HTTPS/loopback OpenAI-compatible providers behind origin-scoped consent (`CONSENT_VERSION` 3) and a generic encrypted credential store, the three-tier structured-output cascade with capability fallback, the reservation-based monthly budget with an unpriced manual-confirmation escape, on-demand decision explanations, budget-capped second opinions on unsure suggestions that never auto-apply, restructure proposals with a live diff and guarded apply/undo, and on-demand Readability summaries persisted only on Jev verification — plus the track's closing integration-hardening phase (a 9-spec LLM e2e suite, live/performance/accessibility gates, compliance sync, and the full release gate) — see 1.1 | OpenAI-compatible client, per-provider consent, structured outputs, escalation, explanations, restructure proposals, summaries with Jev verification | 1.5 weeks |
| **6. Store readiness and 1.0 release** | Partial — the Phase 5 track's integration-hardening phase landed the accessibility gates, the compliance sync, and the full-gate CI pass; labeled fixtures, evals, thresholds pinned to `jev-1.13.0`, store assets, the public privacy-policy URL, dashboard answers, reviewer notes, the 13.13 checklist, and the trusted-tester release remain | Labeled fixtures, evals, thresholds pinned to `jev-1.13.0`, accessibility, privacy policy website, listing text and assets, dashboard privacy answers, reviewer notes, 13.13 checklist, trusted-tester release | 1.5 weeks |
| **Store review** | Not started | Calendar time, not work: usually days, up to a few weeks for a new developer | buffer |
| **7. Release 1.1** | Not started | Custom base URLs and the link checker (with soft-404) with broad optional host permissions, updated disclosures, `CONSENT_VERSION` increase | 1 week |
| **8. v2** | Not started | Scheduled maintenance (adds `alarms`), smart collections, threshold tuning UI, hierarchical classification, per-task routing | 2 to 3 weeks |

**Status note (2026-09-28):** Phases 0 through 5 are complete and their tracks are archived under `conductor/archive/` (latest: `phase5_llm_layer_20260928/`); no conductor track is active. The Phase 5 track closed gate-green with user-accepted manual verification, and its closing integration-hardening phase (a 9-spec LLM e2e suite, live/performance/accessibility gates, compliance sync, and the full release gate) shipped with it. Phase 5 shipped the optional OpenAI-compatible LLM layer: preset and custom-HTTPS/loopback provider setup behind origin-scoped consent, a generic encrypted credential store, a three-tier structured-output cascade (json_schema → json_object → prompt_only, capability-only fallback), a reservation-based monthly budget with an unpriced manual-confirmation escape, on-demand decision explanations, automatic second opinions on unsure suggestions that never auto-apply, restructure proposals with a live diff and guarded apply/undo, and opt-in Readability page summaries persisted only on Jev verification — all through the exact-origin egress gate. Store readiness (Phase 6) is open.

**Total**: about 11 weeks of work to a public 1.0 (Phases 0 to 6), plus store review time. Release 1.1 follows about a week later; v2 takes another 2 to 3 weeks.

### Definition of done per phase
- New schemas have valid and invalid fixture tests.
- Unit and end-to-end tests pass in CI.
- Jev features are verified against both TypeSafe and OpenRouter (live smoke test).
- No new permission without a documented reason in `store/permissions.md`.
- Any change to sent data or recipients updates `store/` docs and `CONSENT_VERSION` in the same change.

---

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The `jev-latest` alias moves and shifts probabilities | Thresholds silently wrong | Pin `jev-1.13.0` by default after tuning; record `response.model`; re-run evals before moving |
| Changes to OpenRouter's System One surface (new) or its alpha Decisions API | Requests fail or hang | Zod-validated responses, a nightly live smoke test, provider fallback (TypeSafe, then OpenRouter), and alpha offered as opt-in only |
| Rate limits change (TypeSafe warns they may) | 429 during bulk jobs | Per-provider concurrency, backoff honoring `retry-after`, resumable job queue |
| Context limit exceeded by long page text | 400 `max_tokens_exceeded` | Pre-send token estimate, excerpt trimming, split question sets |
| More than 255 folders or tag candidates | 400 error | Pre-filter in code; hierarchical classification |
| Jev misled by adversarial page content | Wrong tags or folders | Metadata-only default, never auto-apply destructive actions, review queue |
| Non-English bookmarks | Lower accuracy | Detect language in code; raise thresholds or route to the LLM for non-English content |
| MV3 service worker stops mid-job | Lost progress | Jobs persisted in IndexedDB, small batches, atomic apply with snapshot |
| API key leakage | Security incident | Service-worker-only access, encryption at rest, redacted logs, no keys in exports, credit-limited keys |
| Store rejection for broad host permissions or weak justifications | Delayed launch | Staged release (narrow 1.0, broad patterns in 1.1), per-permission justifications, readable code |
| Mismatch between dashboard answers, privacy policy, and behavior | Takedown, or suspension of all of the publisher's items | `store/` docs as the single source, CI snapshot tests, `src/net/` gate, release checklist |
| Data sent without prior consent (for example, a new code path) | Policy violation | Consent gate enforced in `src/net/`, lint ban on `fetch` elsewhere, end-to-end consent tests |
| An AI provider changes its data policy | Disclosure out of date | Link to each provider's policy; review policies at each release; increase `CONSENT_VERSION` if recipients change |
| The link checker triggers actions on sites (logout or one-time links) | User harm | Opt-in, `HEAD` first, skip rules for action and token URLs, no cookies |

---

## 17. Open Questions

1. **Page text**: the plan keeps metadata-only as the default, which is required for a clean privacy story. Should page text be offered at all in 1.0, or deferred to 1.1? — **Resolved (2026-09-28):** the decisions layer is metadata-only (title, cleaned URL, domain; notes never sent). Opt-in page-text extraction shipped with the Phase 5 summaries (`BookmarksManager-4hw.6` superseded by `BookmarksManager-4qn.4.1` and closed): the bundled Readability extractor runs only after an explicit user action behind its own consent, refuses incognito tabs, applies length caps, and Jev sees extracted text only in the `verify-summary` check.
2. **Auto-apply defaults**: should tag and category auto-apply be on or off at first run? The current plan is off. — **Resolved (2026-09-28):** off at first run, enforced by the settings schema defaults and covered by policy tests.
3. **UI framework**: React (assumed) or Svelte/Vue? — **Resolved (2026-09-25):** React 19 is the shipped choice; the Options page, popup, and side panel are React bundled by WXT.
4. **Metadata sync across devices** (tags, notes, decisions): is Chrome's native bookmark sync enough? Any cloud sync would add a new recipient and new disclosures.
5. **Project website and publisher identity**: where will the homepage and privacy policy live (GitHub Pages recommended)? Will you publish as an individual or an organization, and as a trader or non-trader in the EU?
6. **Staged release**: is it acceptable to ship custom base URLs and the link checker in 1.1 instead of 1.0, to keep the first review simple?

---

## 18. Immediate Next Steps

Progress as of 2026-09-28 (see section 1.1):

1. **Done.** Scaffold the WXT project (TypeScript, React, Tailwind, Vitest, Playwright), with the `fetch` lint ban, the manifest snapshot test, and the `store/` folder from day one.
2. **Done.** Build `src/net/` (HTTPS, allowlist, consent gate, "Data sent" log) before any feature that sends data.
3. **Done.** Write `src/jev/wire.ts` and fixture tests from the documented TypeSafe and OpenRouter response examples.
4. **Done.** Build the mock Jev server (`POST /v1/systemone`) and the fetch client against it. `tests/mock-servers/jev.ts` drives the client tests, which cover retries (including `retry-after`), guards, batching, concurrency, and usage accounting.
5. **Done (key-gated).** Add the provider setup, consent screen, and "Test connection" flow, then verify it live with one TypeSafe key and one OpenRouter key. The flow shipped and is covered end to end against a routed fake endpoint; live verification is automated as the key-gated `npm run test:live` suite (6 smokes: provider probes and a live categorize check on both presets, LLM probes, and a live decisions check), which is skipped without keys and has not been run with real keys in this environment, and the real host-permission prompt is bypassed in e2e (`BookmarksManager-4fb`).
6. **Done.** Built end to end on the Phase 4 track: categorize (plus tags, placement, misfiled, near-duplicate, and rerank question sets) runs on real bookmark metadata behind the `jev_decisions` consent scope — save-time suggestions in the popup, Analyze from the side panel and bulk bar, a review queue with approve/undo, and a resumable library scan; covered by 6 e2e specs against a wire-level fake provider, an analyze-on-save perf gate, and a key-gated live categorize smoke (see 1.1).
7. **Done (drafts).** Draft `store/privacy-policy.md` and `store/permissions.md` early, and update them with every change that affects data flow. Both exist, describe only shipped behavior, and are guarded by CI; publication details and the public URL remain release prerequisites.
8. **Done.** Build the optional LLM layer (Phase 5): provider setup with per-scope consent, the three-tier structured-output cascade, the monthly budget, on-demand explanations, automatic escalation, restructure proposals, and Jev-verified summaries — shipped on `phase5_llm_layer_20260928` together with the track's integration-hardening phase (see 1.1).
9. **Next (Phase 6).** Store readiness and the 1.0 release: labeled fixtures and quality evals, thresholds pinned to `jev-1.13.0`, the privacy-policy website and `store/assets/`, dashboard answers, reviewer notes, the 13.13 checklist, and the trusted-tester release.

---

## 19. References

- Pydantic AI, TypeSafe (Jev): https://pydantic.dev/docs/ai/models/typesafe/
- Pydantic AI, Decision models: https://pydantic.dev/docs/ai/models/decision/
- Pydantic AI, `TypeSafeProvider` API: https://pydantic.dev/docs/ai/api/pydantic-ai/providers/
- TypeSafe API reference: https://docs.typesafe.ai/api
- TypeSafe models, pricing, and limits: https://docs.typesafe.ai/models
- TypeSafe state guide: https://docs.typesafe.ai/concepts/state
- TypeSafe confidence guide: https://docs.typesafe.ai/confidence
- Jev 1.13 limitations: https://docs.typesafe.ai/model-jaggedness/jev-1.13
- TypeSafe JavaScript SDK: https://docs.typesafe.ai/sdk/javascript
- OpenRouter, Jev hub: https://openrouter.ai/docs/guides/community/jev
- OpenRouter, TypeSafe SDK and System One API: https://openrouter.ai/docs/guides/community/typesafe-sdk
- Pydantic AI issue on routing Jev through OpenRouter (background): https://github.com/pydantic/pydantic-ai/issues/8552
- Chrome Web Store Program Policies: https://developer.chrome.com/docs/webstore/program-policies/policies
- Chrome Web Store User Data FAQ: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Chrome Web Store privacy fields: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Chrome Web Store review process: https://developer.chrome.com/docs/webstore/review-process
- Chrome extensions, fetching favicons: https://developer.chrome.com/docs/extensions/how-to/ui/favicons
