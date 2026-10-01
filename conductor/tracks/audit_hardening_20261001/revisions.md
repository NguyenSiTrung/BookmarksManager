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
- **Fixture follow-up:** The existing route helper wrapped all replies,
  including failures, as successful chat-completion envelopes. Add this helper
  to ownership and an explicit typed `error` reply that emits `{error: ...}`.
  The first fixture-only retry still failed, revealing that wrapper rather
  than a production classifier defect. Existing completion replies are unchanged.

## Revision 7 — 2026-10-01 — B09 retry accounting / consumer ownership

- **Trigger:** Review found successful retries erased earlier exposure when
  only the final response settled the logical-send reservation. A final
  reported zero could erase missing usage or an earlier reported overrun.
- **Current task:** Phase 3 Task 2, review fix round 1.
- **Change:** Account each attempted send with existing reservation/usage
  rows, settling before another paid retry is admitted. Preserve independent
  estimated/unknown/reported provenance and current per-attempt admission.
  Add structured/explain/summary consumer tests to this task's ownership.
- **Evidence:** Fourteen new regressions failed before the retry fix;
  203 named tests then passed. Ten consumer assertions still expected the
  old single-reservation representation or previous refusal order.
- **Ruling:** Update consumer expectations to per-attempt accounting without
  weakening request-count, wire-cap, spend or zero-egress assertions.
  Reconfiguration may fail current model validation (`unlisted_model`)
  before feature admission (`no_consent`); preserve the gate's cheap-before-
  sensitive order rather than bypass current configuration checks.
  Cost if wrong: callers see a more precise typed refusal instead of the
  previous code; no additional egress is authorized.

## Revision 8 — 2026-10-01 — Phase 3 browser checkpoint ownership

- **Trigger:** B10 unit/review fixes and the existing browser suite passed,
  but Phase 3's checkpoint explicitly requires omitted-usage and held-revoke
  browser evidence, absent from that existing suite.
- **Change:** Add the existing LLM browser spec/helper to Task 3 ownership.
  Extend wire fakes only as needed for omitted usage and deferred responses;
  retain default replies. Exercise real worker/protocol/accounting and assert
  stored conservative amounts, wire limits and no post-revoke transport.
- **Ruling:** Deliver those controls now rather than count Phase 6's future
  integrated tests as present checkpoint evidence. Cost if wrong: two
  overlapping regression surfaces; no product or permission change.

## Revision 9 — 2026-10-01 — B11 restructure callback owner

- **Trigger:** Real callback regression remains failing after runner fencing:
  a held restructure response merges assignments after owner supersession.
- **Current task:** Phase 4 Task 1, initial implementation validation.
- **Change:** Add `src/restructure/assign.ts` to ownership. Pass the job's
  captured generation into the existing guarded assignment merge, retaining
  generation-zero legacy/direct assignment compatibility.
- **Evidence:** 72 named tests pass, one actual stale callback regression
  fails; 389 adjacent tests and scoped lint/types/diff pass.
- **Ruling:** Fence the actual callback instead of mocking it away or marking
  partial progress/status fencing complete. Cost if wrong: direct callers
  must supply a current generation after ownership is claimed; legacy zero
  semantics remain explicitly tested. No new network or schema abstraction.

## Revision 10 — 2026-10-01 — B11 actual paid-send fencing and browser drift

- **Trigger:** Review P1: runner-entry checks miss later escalation, pair
  iterations and transport queue/preflight/retry waits. Fail-fast split
  requests may release ownership before sibling work settles.
- **Change:** Expand ownership across existing analysis/duplicate/escalation
  and Jev client/gate modules and focused tests. Propagate captured job
  authority to each attempt; retain paused-batch draining and already-sent
  accounting, but refuse canceled/superseded new work. Drain siblings before
  owner release, without a new framework or debug protocol.
- **Gate evidence:** 153 files / 2,933 tests and lint/types/build/compliance
  passed. Browser: 17 passed, one failed. Popup's raw forbidden word `notes`
  also matches static category instructions saying “release notes.”
- **Ruling:** Add that existing browser spec to ownership; keep structural
  no-notes-field assertions and actual secret/query marker checks, remove
  only the ambiguous plain-word prohibition. Cost if wrong: a hypothetical
  free-text note must be detected by a unique marker instead of a common
  English word. No product privacy boundary is relaxed.
