# Track Learnings: deep_audit_fixes_20261005

Implementation discoveries belong here and in the mapped Beads task's notes.
This file starts with approved context and inherited patterns; it does not
claim that any audit finding has been fixed or reproduced.

## Approved Decisions (2026-10-05)

- All findings of the 2026-10-04 audit are in scope except four deferred items
  (active Jev provider pointer, storage.persist/backup, Applied/History view,
  add_tags per-tag policy) filed as P3 Beads: BookmarksManager-od9, BookmarksManager-xxo, BookmarksManager-tax, BookmarksManager-rwy.
- High/P1 track priority. No track dependencies. Hours unset.
- **Automated gates only**; no manual checks at any phase or at completion.
- Task-level parallelism only for file-disjoint tasks; phases sequential.
- **Consent/privacy claims are enforced in code**, not softened in docs:
  explain/restructure get real disclosures, gates get per-scope guards, the
  popup suggests only on explicit action, jobs do not resume egress at cold
  start.
- Bulk Approve all: confirm dialog plus aggregate undo. Bulk Analyze routes
  through the job queue with estimate and cancel.
- Reused Beads: eov (Phase 2 task 3), 2v9 (Phase 3 task 5), 7k4 (Phase 7 task
  1), bih (Phase 7 task 2).

## Audit Provenance

- Baseline observed 2026-10-04: typecheck, lint, 159 files / 2395 unit and
  component tests, build, check:manifest, check:bundle, npm audit (prod) all
  green. Playwright e2e was not run in the audit.
- Findings come from four read-only slice audits (security/privacy, data
  integrity, decisions/jobs, UI). Four were confirmed by direct code reads:
  readBlocklist fails open (P01), startRestructure omits userBlocklist (P02),
  AbortSignal.timeout is misclassified (A01), applyMerge uses peekLatest (D04).
  **All others are unreproduced; apply the verify-first rule.**
- audit_hardening_20261001 (archived) already changed undo serialization,
  explain/summary blocklist checks, job ownership and reservation settlement.
  Re-read current code before trusting any line reference in spec.md.

<!-- Learnings from implementation will be appended below -->
