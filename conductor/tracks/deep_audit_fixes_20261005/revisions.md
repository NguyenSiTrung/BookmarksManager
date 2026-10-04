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
