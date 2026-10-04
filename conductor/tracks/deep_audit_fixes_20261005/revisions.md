# Track Revisions

## Revision 1 — 2026-10-04 — Plan ownership

- **Trigger:** Phase 1 task 1 introduces a typed blocklist-read refusal.
  Explain's message mapper recognizes only its existing error classes and
  would otherwise flatten that refusal to `internal_error`.
- **Change:** Add `src/messages/llm-features.ts` to task 1's owned files.
  Its later owner, task 4, already depends on task 1.
- **Reason:** Preserve typed, redacted failures at the UI boundary without
  importing network error classes into the shared blocklist repository.
  No spec, behavior scope, or dependency change.

## Revision 2 — 2026-10-04 — Plan ownership

- **Trigger:** Phase 1 task 2 removes production transport injection, but
  `src/llm/client.ts` also exposes and forwards `fetchImpl`.
- **Change:** Add `src/llm/client.ts` to task 2's owned files. The file has no
  concurrent Phase 1 owner; later accounting tasks remain sequential.
- **Reason:** Remove the production bypass end-to-end, using test-only
  transport helpers rather than leaving a production configuration seam.
  No spec or phase dependency change.

## Revision 3 — 2026-10-04 — Plan ownership

- **Trigger:** P04 needs the same destination/version binding and affirmative
  disclosure in two independent UI panes, while neither worker handler may
  write consent.
- **Change:** Task 4 owns new shared `src/schemas/feature-consent.ts` and
  `src/ui/components/FeatureConsentDialog.tsx`, plus the already listed
  handlers, records, disclosure and panes. Associated unit/component/e2e
  tests and two store disclosure documents may be updated.
- **Reason:** Keep the approved UI action separate from worker egress. Reuse
  the closed content-free binding and accessible unchecked-default dialog;
  reject provider changes on retry. The changed scopes need renewed consent
  without invalidating unchanged scopes. No overlap with running task 2.

## Revision 4 — 2026-10-04 — Plan ownership

- **Trigger:** P08 applies the same caps in the in-page Readability script
  and the worker schema; importing worker extraction into the page script
  would unnecessarily bundle worker policy dependencies.
- **Change:** Task 7 owns new pure `src/extract/limits.ts`; keep the existing
  `PAGE_EXTRACT_LIMITS` export from `page.ts` as a compatibility re-export.
- **Reason:** One source for deterministic limits without page-side database
  or network imports. Tests first reproduced navigation acceptance, missing
  identity acceptance, seven oversize shapes and a 2.6 MB uncapped article.

## Revision 5 — 2026-10-04 — Plan ownership

- **Trigger:** P03 RED reproduced 33 bypasses but gate-local copies of
  private prompts, schemas and repair wording would drift; importing feature
  services into gates would create dependency cycles.
- **Change:** Task 2 owns new pure `src/llm/prompt-contracts.ts` and contract
  import substitutions in `src/llm/{explain,escalate,summarize,structured}.ts`,
  `src/restructure/propose.ts`, `src/messages/llm-provider.ts`.
- **Reason:** Share closed scope contracts and deterministic tier/repair
  formatting with producers without database/client/gate dependencies.
  Production behavior outside payload admission is unchanged. Task 4 owns
  different message modules; task 7 owns extraction and summary orchestration.
  Coordinator reserves the three extraction-related unit test files;
  task 2 owns blocklist-egress fixture adaptation.

## Revision 6 — 2026-10-04 — Review remediation ownership

- **Trigger:** Independent review found that message-level recipient binding
  was not retained through later asynchronous admission; the capped synopsis
  domain list could not re-admit an omitted source host; summary's Jev wrapper
  did not forward final-gate admission.
- **Verified:** Explain/propose reread provider settings after handler checks.
  Their options lacked a per-attempt authority callback. Summary's Jev client
  supported that callback, but orchestration supplied only a transport wrapper.
  Synopsis domain admission saw only the top 50 domains.
- **Change:** After task 2's worker finished, task 4 may add optional
  `beforeSend` to `ExplainOptions` and `ProposeOptions`, preserving task 2's
  canonical imports. It owns the recipient and full-source synopsis admission
  fixes plus associated message/proposal regressions. Coordinator owns the
  summary final-gate callback forwarding and its regressions under task 7.
- **Reason:** Each privacy authority must survive every await through actual
  dispatch. No concurrent source-file ownership conflict remains.

## Revision 7 — 2026-10-04 — Logging and cold-start ownership

- **Trigger:** P07's required additive row field lives in `src/db/database.ts`,
  and outcome presentation lives in Options. P06's startup guarantee requires
  replacing old browser-restart expectations and synchronizing disclosures.
- **Change:** Add database row type and Options SentLog to task 3. Add README
  and the affected store disclosures/reviewer notes to task 6. Task 3 owns
  its sent-log/gate/component tests; task 6 owns background/queue tests and
  restart tests in `tests/e2e/decisions.spec.ts`.
- **Reason:** These files implement explicitly required behavior, not
  incidental refactors. Tasks 3 and 6 remain file-disjoint. Later database
  retention and same-session keepalive tasks wait for Phase 1.
- **Tooling:** The SDD task-brief script expects task headings, while this
  approved Conductor plan uses task checkbox lines. Continue using the
  existing track-specific ignored workspace and manually extracted briefs,
  preserving the approved plan format.

## Revision 8 — 2026-10-04 — P07 shared-test alignment

- **Trigger:** Two existing Jev split-draining regressions wait for one
  sent-log row after two fetches have already started. Dispatch-time logging
  now correctly writes two rows before either response settles.
- **Change:** Task 3 also owns the narrow interim-wait adaptation in
  `tests/unit/jev-client.test.ts`. Wait for the first row's final `http_401`
  outcome instead of the old response-time row count; retain final two-row
  accounting and the original owner-drain/Resume assertions.
- **Reason:** Test the same completed-attempt boundary without hiding a
  dispatched sibling. No Jev production behavior or source ownership change.

## Revision 9 — 2026-10-04 — Shared path minimization contract

- **Trigger:** P09 requires the cleaner and independent CleanedUrl gate schema
  to agree on matrix/opaque path minimization without importing schema/runtime
  policy into each other. Disclosure wording is snapshot-checked in store docs.
- **Change:** Task 8 owns new pure `src/decisions/url-path.ts` plus the two
  store privacy disclosures. Associated minimization/schema/real-wire and
  local-resource-identity regressions belong to task 8.
- **Reason:** Share only the path contract; retain raw local URL identity and
  all current gate contracts. Clarify what cleaned URL includes without adding
  fields, recipients or automatic triggers.

## Revision 10 — 2026-10-04 — Hosted path disclosure ownership

- **Trigger:** P09's store policy clarifies the remaining-path contract, but
  its hosted counterpart is outside the original task ownership.
- **Change:** Add `site/privacy/index.html` to task 8 for the same narrow path
  clarification. The coordinator owns this documentation edit and `check:site`;
  no source implementer remains active.
- **Reason:** Keep the local hosted-policy source and store policy synchronized
  before completing the task. This does not publish the site or preempt H06's
  final documentation consolidation.

## Revision 11 — 2026-10-04 — Reset failure checkpoint blocker

- **Trigger:** The fresh Phase 1 unit gate and isolated existing test both
  reproduced a disappearing delete-all error. Source inspection identifies
  unconditional error clearing on dialog close.
- **Change:** Track `BookmarksManager-3op.9` as a separate baseline repair,
  blocking the Phase 1 checkpoint. It owns only Options `DeleteAllData.tsx`
  and its existing component test. P09's source ownership remains disjoint.
- **Reason:** Fix the actual baseline defect instead of hiding a gate failure
  with timing retries. Preserve an honest result for the destructive reset,
  without changing deletion semantics or expanding the audited feature scope.

## Revision 12 — 2026-10-04 — Shared abort classification ownership

- **Trigger:** A01 covers both gates, while Jev's internal deadline currently
  aborts with the same default reason as a user's AbortController. Adding
  duplicated gate-local classifiers would drift; accurate dispatch outcomes
  need a distinguishable internal deadline reason.
- **Change:** Phase 2 task 1 owns new pure `src/net/abort.ts` for common
  classification and `src/jev/client.ts` for the narrow internal deadline
  reason/caller adaptation. Associated gate/client/retry regressions belong
  to that task. No other Phase 2 implementation is active.
- **Reason:** Distinguish timeout from caller abort without inspecting error
  text, changing Jev's intended retry policy, or duplicating rules. Preserve
  existing wait caps and per-attempt authority/accounting.

## Revision 13 — 2026-10-05 — Message protocol and audit outcome ownership

- **Trigger:** Phase 2 task 1's new `aborted` gate code surfaced five TS2345
  errors: four closed message-code unions relay gate codes verbatim and
  could not carry it. `SummarizeErrorCode`'s safe-parse guard would silently
  flatten `aborted` to `internal_error`. The interrupted worker also logged
  caller aborts as `timeout` under P07's closed outcome vocabulary, which
  conflates a user cancel with a deadline in the audit register.
- **Change:** Phase 2 task 1 additionally owns the narrow union-member
  additions in `src/messages/{llm-features,llm-provider,provider,
  restructure,summaries}.ts`, the `SentLogOutcome` member and the
  `isSentLogOutcome` guard in `src/db/database.ts` and `src/net/sent-log.ts`
  respectively (nothing else in either file), and the caller/protocol
  regression updates in `tests/unit/{llm-provider-messages,
  provider-messages,llm-feature-messages,restructure-messages,
  summary-messages,sent-log}.test.ts`.
- **Ruling on outcome honesty:** caller aborts record `outcome: "aborted"`
  in the sent log; the closed P07 vocabulary gains one content-free member,
  applied additively — legacy rows and every existing outcome are
  unaffected, and the register stays honest about which attempts the user
  cancelled versus which the deadline cut. A01's error-code distinction and
  the audit row now agree.
- **Reason:** Keep total typed message results verbatim at every UI
  boundary (no `internal_error` flattening of a user action) and keep the
  audit outcome truthful. No other Phase 2 task is active, so the shared
  files cannot conflict; task 6's later `database.ts` work is unaffected
  (union member only). No spec behavior, retry policy, wait cap, or
  dependency change.
