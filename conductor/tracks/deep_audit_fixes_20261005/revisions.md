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
