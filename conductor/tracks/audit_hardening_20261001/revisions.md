# Audit Hardening Revisions

## Revision 1 — 2026-10-01 — Plan

- **Trigger:** Phase 2 Task 1 requires admission checks on summary fallback
  and repair sends. Those sends are owned by `src/llm/summarize.ts`, which
  the original task file list omitted.
- **Current task:** Phase 1 Task 1 review fix. No Phase 2 implementation has
  started and the sequential phase boundary remains intact.
- **Change:** Add `src/llm/summarize.ts` to Phase 2 Task 1 ownership and
  explicitly pass feature admission into its structured-send wrapper.
  Phase 2 Task 2 already owns this file, but the phase is sequential.
- **Ruling:** Extend this task's ownership to the existing summary wrapper,
  rather than introduce an alternate transport or skip per-send admission.
  This implements B05 without changing its scope. If incorrect, the added
  option can be revised within the same module; no new dependency is needed.

## Revision 2 — 2026-10-01 — Plan

- **Trigger:** Phase 2 Task 2 mandates a consent-version bump, but its file
  list omitted the version owner, `src/consent/records.ts`. The existing
  provider browser test also pins the current grant's version.
- **Current task:** Phase 2 Task 1 implementation; Task 2 has not started.
- **Change:** Add the consent record module and provider browser test to
  Task 2 ownership. Keep the existing sequential phase and disclosure scope.
- **Ruling:** Bump the existing shared consent version at its actual owner
  and update the current-version browser expectation, rather than add a
  second version source. If incorrect, this causes unnecessary consent
  reacquisition, but cannot silently authorize obsolete grants.

## Revision 3 — 2026-10-01 — Plan

- **Trigger:** Phase 2 Task 1 review reproduced an ownership/design gap:
  `sendLlmConsented` internally retries after 429/transport failures, without
  returning through feature-local structured-send admission. A changed
  blocklist could therefore permit a second affected LLM disclosure.
- **Current task:** Phase 2 Task 1 review remediation.
- **Change:** Add the existing LLM client/gate and their tests to Task 1
  ownership. Carry admission to the existing transport-attempt boundary.
  Later tasks sharing these files remain behind sequential phase boundaries.
- **Ruling:** Enforce B05 at each actual attempt rather than disable retries
  or consider fallback checks sufficient. If incorrect, the extra admission
  read adds latency or refusals, but cannot silently skip the origin gates.

## Revision 4 — 2026-10-01 — Plan

- **Trigger:** B06 review found unconditional summary grant writes silently
  upgrade stale versions. The Summary dialog auto-sends on open and has no
  production consumer of the clarified per-recipient disclosure constants.
- **Current task:** Phase 2 Task 2 review remediation.
- **Change:** Extend ownership to the summary message protocol, dialog,
  their tests, and existing LLM browser test. Add a read-only recipient/version
  preflight, disclosure and affirmative send; validate echoed origin/version
  against freshly resolved destinations before recording current consent.
- **Ruling:** Make renewed summary consent explicit rather than label the
  unchanged automatic grant a re-disclosure. Existing current grants remain
  compatible, but opening/dismissing the dialog never authorizes egress.
  If incorrect, the extra affirmative step adds friction; it cannot silently
  send page text to an undisclosed recipient.

## Revision 5 — 2026-10-01 — Plan and explicit user ruling

- **Trigger:** B08 gate/wire regressions exposed client-owned capability
  classification incorrectly treating token-limit rejections as structured
  output rejection. Existing fallback requires reading the provider error
  body, conflicting with the inherited no-non-2xx-body pattern.
- **Current task:** Phase 3 Task 1; four regressions remain failing.
- **User decision:** Allow bounded, validated error-body classification with
  no logging or leakage, rather than remove fallback on ambiguous status
  alone. This overrides the inherited pattern for LLM classification only.
- **Change:** Add the existing LLM client and client tests to task ownership.
  Bound the actual read (not full `text()` followed by slicing), validate the
  envelope, and let explicit token-limit fields/mentions veto capability
  fallback. Ambiguous, malformed or oversized errors remain HTTP failures.
- **Ruling:** Preserve real structured fallback with an internal redacted
  classification exception. If incorrect, fallback may require refinement
  for another provider; error bodies still cannot become logged, persisted
  content or surfaced exception text.

## Revision 6 — 2026-10-01 — Plan / browser fixture

- **Trigger:** The B08 full unit gate passed 2,814 tests, but browser fallback
  failed: its fake returned raw unstructured text, not the validated error
  envelope required by the explicitly approved classification contract.
  Four browser tests passed, one failed and five did not run.
- **Current task:** Phase 3 Task 1 integration gate.
- **Change:** Add the existing LLM browser spec to Task 1 ownership. Emit an
  OpenAI-compatible structured capability error with `param: response_format`,
  preserving the three-tier behavior assertion. Add the actual 1,500-token
  proposal allowance assertion to every tier's wire request.
- **Ruling:** Align the fake with the approved validated contract, rather
  than reintroduce raw-text classification. If incorrect, a text-only provider
  cannot automatically fall back; it still fails visibly with no cap removal.
