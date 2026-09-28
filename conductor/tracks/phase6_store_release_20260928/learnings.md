# Track Learnings: phase6_store_release_20260928

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Read `conductor/patterns.md` before each task. It contains 73 consolidated
pattern entries from Phases 0–5. The ones most relevant to this track:

- **Store disclosures mirror typed constants.** Sent fields, recipients,
  triggers, permissions, and consent versions change together and remain
  guarded by snapshot tests.
- **A performance or quality gate must disclose and pin what its harness
  bypasses.** Record exact model, corpus, question-set versions, skipped
  surfaces, and worst-case evidence.
- **Live suites stay separate and key-gated.** Use dedicated Vitest config,
  environment-only credentials, `skipIf` when absent, and never log keys or
  response bodies.
- **Scoped consent gates validate cheap-before-sensitive and fail closed on
  every call.** Store preparation must never weaken runtime enforcement.
- **Playwright routes service-worker fetch but cannot reliably drive Chrome's
  optional-host permission prompt.** Keep automated routed coverage and leave
  the real permission prompt to the final trusted-tester verification.
- **The public claim must match the measured boundary.** Zero-egress,
  performance, accessibility, and provider claims cite the exact harness and
  do not generalize beyond it.
- **Parallel workers use disjoint files.** Phase 3 site and visual-asset work
  may run concurrently; the listing integration waits for both.

---

<!-- Learnings from implementation will be appended below -->
