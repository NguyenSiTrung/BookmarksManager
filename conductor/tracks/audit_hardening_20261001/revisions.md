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
