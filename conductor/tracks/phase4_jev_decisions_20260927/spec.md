# Spec: Phase 4 — Jev Decisions

Track: `phase4_jev_decisions_20260927` · Type: feature · Source: PROJECT_PLAN.md §§2.3, 5.2, 6.1–6.2, 7, 9.1–9.5,
10, 12, 13.4–13.5, 13.12, 14, 15 (Phase 4)

## Overview

Phase 3 finished the provider layer: a scoped consent gate, a hardened Jev client, and the typed
`defineDecision` builder with per-field confidence. The only request that can leave the device is still the
fixed synthetic `jev_test` probe. This track runs Jev on real bookmarks for the first time. It delivers six
question sets (categorize, tags, folder placement on save, near-duplicates, misfiled scan, search re-rank),
the §10.2 confidence policy, a review queue with apply, reject, and undo, an audit log, a resumable job
queue, cost tracking, and the "Data sent" log UI. All of it sits behind a new bookmark-data consent per
provider.

**Data flow changes for the first time.** Only metadata is sent: title, cleaned URL, domain, folder path,
tag names and descriptions, and "Ask" search queries. Notes and page text are never sent. `CONSENT_VERSION`
goes from 1 to 2, and the `store/` disclosures are updated in the same change. No permissions are added.

### Decisions taken while writing this spec (2026-09-27)
- **Metadata only; page text deferred.** No content script, no `scripting` permission, and no Readability.
  Plan §9.1 notes that title, URL, and domain are enough for most category and tag decisions. The title
  quality check needs page text, so it moves to a follow-up together with extraction.
- **Auto-apply off by default** (plan §10.2 and §17 open question 2). Thresholds stay untuned until Phase 6
  pins them on labeled fixtures. Each eligible kind gets a one-toggle opt-in.
- **One bookmark-data consent per Jev provider** (§13.5), covering every Phase 4 feature. The consent names
  every trigger.
- **User-started triggers only**: saving a bookmark, clicking Analyze on a bookmark or selection, starting a
  library scan, or running an "Ask" search. Nothing runs on install, on a timer, or in the background
  without a started job.
- **No manual verification until the end of the track.** Each phase ends with an automated full-gate
  checkpoint, and the only user verification is the track's last task.

## Functional Requirements

### FR1 Decisions consent scope (`src/consent/`, `src/net/send.ts`, `src/schemas/provider.ts`)
- Add a `jev_decisions` scope to the frozen registry, with one consent per provider. The disclosure lists
  the exact fields sent, the recipient name and literal origin, the purpose, and the triggers (save,
  Analyze, library scan, Ask search), and it links to the provider's privacy policy and this extension's.
  The agree checkbox starts unchecked, and Enable is a separate action. `jev_test` stays synthetic-only.
- The `jev_decisions` request guard strictly parses the request state against a closed `DecisionState`
  schema. It refuses unknown fields, any URL that still has a query, fragment, or userinfo, and any
  blocklisted URL, and it does so before the gate reads consent, permissions, or the key.
- Bump `CONSENT_VERSION` from 1 to 2. A stale v1 record of either scope triggers re-disclosure before the
  next request. Revoking a provider deletes both of its consent scopes, removes its host permission, and
  offers to delete its key.

### FR2 Data minimization (`src/decisions/minimize.ts`, pure)
- URL cleaning removes query strings, fragments, and `user:password@` credentials before anything is sent.
- A built-in sensitive-site blocklist, editable in Options, covers banking, health portals, webmail,
  `file://` URLs, private and loopback IP ranges, and dotless intranet hostnames. Matching bookmarks are
  skipped and marked "not sent" in the UI.
- Notes are never included. Every ID in an answer (folder, tag, candidate) is checked against the
  candidates that were actually sent, and anything else is an `answer_mismatch`.

### FR3 Candidate pre-filters in code (`src/decisions/candidates.ts`, pure)
- Tags: the top 30 existing tags by keyword and domain overlap.
- Folders: the top 50 by path and title similarity, plus a `none` option. Folder IDs are the option keys,
  and paths are the descriptions.
- Near-duplicate pairs: same domain and a similar title, excluding pairs already caught locally as exact
  or normalized URL duplicates.
- Misfiled scan: the folder candidate set, which always includes the bookmark's current folder.
- Rerank: the top 30 MiniSearch results for the query.
- Ages, counts, and date comparisons are computed in code and never sent to Jev (§2.3).

### FR4 Question sets (`src/jev/tasks/`)
Built with `defineDecision`. Each exports its own `questionSetVersion`, and every question refers to named
state fields in backticks, one judgment per field (§9).
- `categorize`: one choice over `Category`, with the §8.4 option descriptions.
- `tags`: one noul per candidate tag: "Is `bookmark` mainly about `tag`?"
- `placement` (on save) and `misfiled` (scan): one choice over candidate folder IDs, plus `none`.
- `nearDuplicate`: one score per pair with the four §9.2 levels.
- `rerank`: one noul per candidate: "Does `bookmark` match what `query` is looking for?"

### FR5 Confidence policy (`src/decisions/policy.ts`, pure)
Bands per §10.2, configurable per decision kind:

| Kind | Auto-apply | Review queue | Below |
|---|---|---|---|
| `add_tags`, `set_category` | ≥ 0.85 **only when that kind's toggle is on (default off)** | 0.5–0.85 | `unsure` |
| `move` on save | never; pre-selects the folder at ≥ 0.7 | 0.5–0.7 | `unsure` |
| `move` (misfiled), `merge_duplicates` | **never** | ≥ 0.5 | `unsure` |

- Rerank "no match" bar: when every candidate probability falls below it, the UI says there is no match
  instead of showing weak results.
- The low-band escalation hook returns `unsure` until Phase 5 adds the LLM layer.

### FR6 Decision store, apply, and undo (`src/decisions/`, Dexie v3)
- Persist `Decision` rows (the §7 schema), with `source.model` taken from the response and
  `source.questionSetVersion` from the task.
- Apply approved decisions only through the existing mutation service, tag ops, and duplicate merge, each
  with an undo snapshot. Supported actions: approve, reject, revert, and bulk approve.
- An append-only `audit` table records every status change (decision id, from, to, actor `user|policy`,
  timestamp). It stores no bookmark content.

### FR7 Job queue (`src/jobs/`, Dexie `jobs` table)
- Persisted, resumable batches in the service worker. A job survives an MV3 worker restart and can be
  paused or canceled.
- Job kinds: analyze selection (categorize + tags), library scan (categorize + tags, misfiled,
  near-duplicate).
- Before a job starts, show a cost estimate derived from the token estimate.

### FR8 Cost tracking (Dexie `usage` table)
- Persist usage per request and per job: input and output tokens, and cost when the provider reports it.
- Show running totals in the side panel and in Options.

### FR9 Worker messaging (`src/messages/decisions.ts`)
- Total, Zod-validated `runtime.onMessage` handlers returning `{ok:true,…} | {ok:false,code,message}`.
- Keys and the Jev client stay in the worker. The UI sends intents and reads Dexie live queries.

### FR10 UI
- **Popup save:** asynchronously suggest a folder (pre-selected at ≥ 0.7) and show tag and category
  suggestion chips the user can accept. The save itself never waits on Jev.
- **Side panel:**
  - a Review view with confidence shading, approve, reject, bulk approve, and undo;
  - an Analyze action per bookmark and in the bulk bar;
  - a library-scan launcher with progress, pause, cancel, and running cost;
  - an "Ask" toggle on the search bar that reranks results and shows a "no match" state.
- **Options:**
  - the decisions consent screen for each provider;
  - per-kind auto-apply toggles;
  - the blocklist editor;
  - the "Data sent" log (time, destination, feature, and field names only), with a clear button and a
    retention cap (closes `BookmarksManager-sd1`);
  - cost totals.

### FR11 Store and compliance
- Update `store/privacy-policy.md`, `store/privacy-practices.md`, `store/permissions.md` (host-permission
  justifications), `store/listing.md`, and `store/reviewer-notes.md` to describe the shipped decision data
  flow nearly verbatim from the disclosure constants.
- Add the §13.12 consent snapshot test: CI fails if the fields a task sends change without a
  `CONSENT_VERSION` increase and matching `store/` edits.

## Non-Functional Requirements
- `minimize.ts`, `candidates.ts`, `policy.ts`, and `src/jev/tasks/*` stay pure (no `chrome`, DOM, React, or
  `fetch` imports).
- `z` is imported only from `src/schemas/z.ts`, and `fetch` stays confined to `src/net/**`. Message handlers
  stay total, and error messages stay redacted.
- Analyze-on-save completes in under 1.5 s end to end against the mock server. The popup still opens in
  under 150 ms, and the 10k search performance gate still passes.
- The full CI gate stays green, and coverage of new `src/{decisions,jobs,jev/tasks}` modules is above 80%.

## Acceptance Criteria
1. Without `jev_decisions` consent, no bookmark request leaves the device (e2e zero-egress). The gate
   refuses non-conforming states before it reads consent, permissions, or the key, which spy call counts
   prove.
2. Request snapshot tests pin the exact JSON for each question set. No request contains notes, query
   strings, fragments, userinfo, or blocklisted URLs.
3. Policy tests cover every band boundary and every "never auto-apply" rule. Auto-apply is off on first
   run.
4. E2E against the routed fake provider covers:
   - consent → Analyze → review queue → approve → undo;
   - save with a folder pre-select;
   - an Ask search that reranks and shows "no match";
   - a library scan that resumes after a worker restart;
   - exactly one `sentLog` row per request that actually left.
5. `CONSENT_VERSION === 2`, the `store/` docs match the disclosure constants, the consent snapshot test
   passes, and `check:manifest` shows no permission change.
6. A key-gated live smoke test runs categorize on fixture bookmarks (never user data) against TypeSafe and
   OpenRouter.

## Out of Scope
- Page text: the extraction content script, the `scripting` permission, `@mozilla/readability`, the
  page-text consent, and the title-quality check (a follow-up Beads issue).
- `mark_dead`, soft-404 and parked-page detection, and the link checker (release 1.1).
- The LLM layer: escalation verdicts, rationales, restructure, `create_folder`, `rename` (Phase 5).
- Labeled fixtures, evals, threshold pinning to `jev-1.13.0`, and language detection (Phase 6).
- Hierarchical classification for more than 255 folders, scheduled jobs (`alarms`), smart collections,
  and the threshold tuning UI (v2).
- Custom base URLs and the OpenRouter alpha Decisions preset (release 1.1).
