# Phase 5: Optional OpenAI-Compatible LLM Layer

## Overview

Add an optional OpenAI-compatible LLM subsystem on top of the existing Jev
decision pipeline. The LLM provides capabilities that Jev cannot generate:
decision explanations, low-confidence second opinions, proposed folder
structures, and page summaries.

The subsystem supports curated OpenAI and OpenRouter presets plus custom
OpenAI-compatible providers. Custom providers use a user-defined base URL,
model, authentication mode, and pricing configuration. Remote providers must
use HTTPS; plain HTTP is permitted only for literal loopback destinations.

Nothing leaves the device by default. Each LLM feature requires
recipient-specific consent and exact-origin runtime host permission. Automatic
escalation is separately enabled, disabled by default, and bounded by a
user-configured monthly budget.

This track incorporates the opt-in page-text extraction represented by Beads
issue `BookmarksManager-4hw.6`, because summaries require page content and Jev
verification.

## Functional Requirements

### FR1 — Provider configuration

1. Support curated OpenAI and OpenRouter presets.
2. Support custom OpenAI-compatible providers with:
   - A canonical base URL, including an optional path such as `/v1`.
   - A model identifier.
   - One validated authentication mode:
     - `Authorization: Bearer <token>`;
     - `api-key: <token>`;
     - no authentication.
   - Optional input/output token pricing needed for automatic escalation when
     reliable provider pricing is unavailable.
3. Support `/chat/completions`; treat `/models` as an optional capability.
4. Reject URL credentials, query strings and fragments in the base URL,
   non-loopback plain HTTP, unsupported schemes, malformed or non-canonical
   origins, and arbitrary user-defined headers.
5. Permit plain HTTP only for `localhost`, `127.0.0.1`, and `[::1]`.
6. Store credentials using the existing encrypted worker-only key-storage
   boundary. Never render, log, export, or return raw credentials.
7. Test Connection must use synthetic data and show a redacted result including
   resolved model, latency, supported structured-output tier, and cost/usage
   when available.

### FR2 — Host permissions and transport

1. Declare the optional HTTPS host capability needed for custom runtime origins,
   plus narrowly scoped loopback HTTP patterns.
2. Request only the exact configured origin from a direct user gesture.
3. Re-check the exact origin permission before every request.
4. Remote destinations must use HTTPS; loopback is the only HTTP exception.
5. Use `credentials: "omit"` and reject redirects.
6. Add a dedicated LLM egress gate under `src/net/`; do not weaken or route
   dynamic destinations through the fixed Jev preset gate.
7. The gate must validate the feature scope, destination, model, payload,
   consent, host permission, authentication configuration, and budget before
   calling `fetch`.
8. Revoking a provider must remove all of its consent grants and host
   permission, with an option to delete its stored credential.

### FR3 — Consent and disclosure

1. Maintain recipient- and origin-specific consent for synthetic connection
   testing, decision explanations, automatic second opinions, restructure
   proposals, page-text summaries, and Jev summary verification.
2. Page text requires a separate prominent opt-in because it is more sensitive
   than bookmark metadata.
3. When page text is sent to both an LLM and Jev for verified summaries, the
   user must have separately consented to each recipient.
4. Every disclosure must identify the recipient and exact origin, fields sent,
   purpose, triggering user action, credential use, and retention/policy links
   when known.
5. Changes to recipients or sent fields must invalidate old consent by
   increasing the consent version and updating store documentation.
6. Every successful request must append a content-free “Data sent” entry with
   timestamp, exact destination, feature, and field names.

### FR4 — Structured output client

1. Support these capability tiers:
   1. strict `response_format: json_schema`;
   2. `response_format: json_object` with the schema in the system prompt;
   3. prompt-only output with bounded JSON extraction.
2. Test Connection determines and persists the supported tier.
3. Fall back only when the provider explicitly rejects an unsupported
   capability. Do not treat malformed model output as evidence that a lower
   tier should be used.
4. Validate every feature response with its Zod schema.
5. Permit at most two repair attempts after validation failure.
6. Record the configured and returned model identifiers.
7. Apply an abortable timeout, bounded full-jitter retry for transient failures,
   and `retry-after` handling.
8. Do not retry authentication, authorization, schema-validation, or other
   permanent failures automatically.
9. Errors must be redacted and must not contain credentials, prompts, response
   bodies, bookmark content, or page excerpts.

### FR5 — Decision explanations

1. Provide an explicit Explain action for pending review-queue decisions.
2. Send only the minimized decision state, question, candidate labels, Jev
   probabilities, and selected answer.
3. Return and validate a concise rationale no longer than 1,000 characters.
4. Persist the rationale with the decision.
5. An explanation must not change, approve, apply, or otherwise mutate the
   underlying decision.

### FR6 — Automatic low-confidence escalation

1. Automatic escalation is disabled by default.
2. Users must explicitly configure and enable an LLM provider, grant the
   second-opinion consent scope, enable automatic escalation, and configure a
   monthly budget.
3. Only results in the existing Jev low-confidence band are eligible.
4. Escalation may run only as part of an existing user-started Save, Analyze,
   library-scan, or equivalent decision operation.
5. Send the minimized decision state, question, allowed options, Jev
   probabilities, and Jev answer.
6. Validate the result as `agree`, `disagree` with an allowed alternative
   candidate, or `unsure`, plus a concise rationale.
7. Reject unknown candidate IDs, invented actions, or incompatible output.
8. Persist the verdict, returned model, and rationale with the decision.
9. Escalated decisions always remain subject to user review. Escalation never
   upgrades a low-confidence decision into an automatic bookmark mutation.
10. Missing consent, permission, credentials, pricing, budget, or a valid
    response must fall back to the ordinary review queue.

### FR7 — Monthly budget and usage

1. Track input tokens, output tokens, request count, model, provider, and cost
   provenance for each LLM request.
2. Distinguish provider-reported, locally estimated, and unavailable cost.
3. Unknown cost must never be presented as zero.
4. Automatic escalation requires reliable provider pricing or configured
   input/output token rates.
5. Before a request, reserve a conservative maximum estimated cost.
6. Refuse the request when the reservation would exceed the calendar-month
   budget.
7. Reconcile the reservation with returned usage and provider-reported cost.
8. Manual LLM actions may proceed without known pricing only after a clear
   per-action confirmation that cost cannot be estimated.
9. Show current-month usage, remaining budget, and whether values are reported
   or estimated.

### FR8 — Restructure proposals

1. Restructuring is a dedicated, explicitly started workflow.
2. Build a bounded local synopsis containing folder paths, category/tag counts,
   domains, and capped representative titles. Do not send an unbounded bookmark
   dump.
3. The LLM proposes schema-validated folder paths and descriptions.
4. Enforce limits on folder count, depth, name length, and description length.
5. Jev assigns bookmarks to the proposed folders using Choice questions.
6. Show a before/after tree diff with assignment confidence indicators.
7. Low-confidence assignments remain unresolved for user review.
8. Restructure plans never auto-apply.
9. Apply an approved plan through guarded bookmark mutations as one logical
   batch with an undo snapshot.
10. Persist enough job state to resume proposal and assignment work after
    service-worker suspension.

### FR9 — On-demand page extraction

1. Add the `scripting` permission only with this implemented feature.
2. Use `activeTab` plus `chrome.scripting` to inject extraction code only after
   an explicit user action.
3. Do not declare static content scripts.
4. Do not extract on navigation, installation, timers, background scans, or
   unrelated Analyze actions.
5. Never extract from incognito tabs.
6. Use Readability to derive page metadata, headings, and a bounded excerpt.
7. Treat the page as hostile data and isolate it from system instructions.
8. Apply deterministic character/token limits before any request.
9. Never send or persist the full DOM.
10. Do not persist the extracted excerpt; retain only derived, approved results.
11. Keep notes excluded from all LLM and Jev payloads.

### FR10 — Summaries with Jev verification

1. Expose an explicit Summarize action for the active page when it maps to a
   saved bookmark.
2. Require separate page-text consent for the selected LLM origin and the Jev
   verification origin.
3. Send the bounded extracted page representation to the LLM.
4. Validate an LLM-generated summary of at most 2,000 characters.
5. Ask Jev whether the summary is supported by the extracted page.
6. Persist the summary in extension-owned bookmark metadata only when Jev
   verifies it as supported.
7. Show failed or uncertain verification to the user without automatically
   persisting the summary.
8. Add `summary` to `BookmarkMeta` through a backward-compatible persistence
   change.
9. Current-page extraction and summary generation are not resumable after loss
   of active-tab context; failures must be reported cleanly and restarted by
   the user.

### FR11 — User interface

1. Extend Options with preset/custom LLM provider setup, base URL, model,
   authentication and pricing fields, exact recipient and permission
   disclosures, Test Connection, capability status, automatic-escalation
   controls, monthly budget and usage, and revoke/delete controls.
2. Extend the review queue with explanation and escalation verdicts.
3. Add a dedicated restructure preview and confirmation workflow.
4. Add summary extraction/generation/verification states to an appropriate
   active-page surface.
5. All controls, dialogs, progress states, validation messages, and result
   states must be keyboard-accessible and screen-reader understandable.

## Non-Functional Requirements

### Security and privacy

- No network request on fresh installation, page load, or provider enablement.
- No feature request without current scope/origin consent and host permission.
- Existing URL minimization and sensitive-site blocking remain enforced.
- Page text and model output are untrusted input.
- Dynamic providers must not weaken the fixed Jev destination boundary.
- Raw credentials, prompts, responses, excerpts, and bookmark content must not
  appear in logs or error messages.
- Store permissions, privacy documentation, disclosures, and actual behavior
  must remain synchronized.

### Reliability

- Every trust boundary uses strict runtime validation.
- Permanent failures fail fast; transient retries are bounded.
- Restructure and automatic-escalation work survives service-worker suspension
  from the last committed step.
- Partial failures never silently mutate bookmarks.
- Provider incompatibility is surfaced as an actionable, redacted error.

### Performance and limits

- Extracted content, restructure synopses, prompts, responses, repair attempts,
  and concurrency are bounded.
- Provider calls must not block local bookmark management or search.
- Budget checks occur before egress.
- The active-page extraction path must avoid retaining DOM or excerpt data after
  completion.

### Maintainability

- The LLM transport, structured-output engine, and individual feature services
  remain independently testable.
- Existing Jev client and gate behavior remain backward compatible.
- Feature schemas are the source of truth for prompts, validation, and repair.
- No provider-specific branching belongs in feature services when a capability
  profile can express the difference.

## Acceptance Criteria

1. OpenAI, OpenRouter, and a scripted custom OpenAI-compatible endpoint can be
   configured, tested, used, revoked, and deleted.
2. Remote HTTP and non-loopback custom endpoints are rejected.
3. Loopback HTTP providers work only after explicit origin permission and
   consent.
4. Fresh install and every missing-consent/permission case produce zero
   requests.
5. Strict JSON Schema, JSON-object, and prompt-only providers each pass the
   structured-output contract tests.
6. Invalid outputs stop after two repair attempts and cause no bookmark
   mutation.
7. Explanations are persisted without changing decision state.
8. Eligible low-confidence decisions escalate automatically only when enabled,
   consented, configured, and within budget.
9. Escalation alternatives are constrained to the original candidates and
   remain in review.
10. Budget exhaustion prevents egress, while unknown cost is never shown as
    zero.
11. Restructure produces a bounded proposal, Jev assignments, a user-visible
    diff, and an undoable user-confirmed apply.
12. Page extraction runs only from an explicit active-tab action, never in
    incognito, and never persists raw content.
13. A summary is persisted only after schema validation and positive Jev
    verification.
14. Revocation removes all provider consent and permission and prevents future
    contact.
15. Unit, component, end-to-end, compliance, and key-gated live
    smoke suites pass.
16. Actual Chrome permission prompts, page extraction, restructure application,
    and summary verification pass Conductor manual checkpoints.
17. Manifest declarations, store permission inventory, privacy policy,
    disclosures, and consent snapshots match shipped behavior.

## Out of Scope

- Per-task provider routing; one configured default LLM provider serves Phase 5
  features.
- Arbitrary request headers or custom JavaScript provider adapters.
- Non-OpenAI-compatible APIs.
- Remote HTTP providers.
- Static or automatic content scripts.
- Background page crawling or extraction from unopened bookmarks.
- Incognito extraction.
- General webpage chat, “summarize any page” outside bookmark management, or
  other features outside the extension’s single purpose.
- Automatic application of escalated decisions or restructure plans.
- Threshold-tuning UI and labeled quality evaluations planned for store
  readiness.
- Scheduled maintenance, smart collections, and other v2 workflows.
