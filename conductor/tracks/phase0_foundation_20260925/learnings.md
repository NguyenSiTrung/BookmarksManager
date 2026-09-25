# Track Learnings: phase0_foundation_20260925

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

- No application code or test suite exists yet. Follow the architecture in
  `PROJECT_PLAN.md` and update this file as concrete patterns emerge.
- The Beads workspace already exists. Do not reinitialize it or automatically
  push/sync code or Beads data.
- `conductor/workflow.md` requires test-first behavior changes, verification
  of scaffold/doc artifacts, local per-task commits, and git notes.
- Parallel workers own only their annotated implementation paths. The
  coordinator serializes updates to shared plan/learnings files and Beads.

---

<!-- Learnings from implementation will be appended below. -->
