# Track Learnings: phase4_jev_decisions_20260927

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Read `conductor/patterns.md` before each task. It already consolidates Phases 0–3, including the
elevated `phase3_jev_client_20260927` patterns. The ones most relevant to this track:

- **Scoped consent gates validate cheap-before-sensitive.** Scope registration and the scope's request
  guard run before consent rows, permissions, or key material are read. Extend the frozen registry, never
  the caller. Prove short-circuits with dependency-spy call counts.
- **Fail-closed gates re-verify per call:** preset → model → https → origin → consent → host permission →
  key on every send.
- **Mutation ordering for irreversible pairs:** enable writes settings → key → consent (consent last);
  revoke removes consent first.
- **Keep domain layers pure:** `src/<domain>/` modules import no chrome/DOM/fetch and expose a typed
  contract; surfaces consume them.
- **Definition-time validation throws `TypeError`;** only run-time answer problems use the domain error
  taxonomy. Choice 2–255 options and score 2–10 levels are enforced at declaration.
- **`noul` confidence is a margin, not a probability** (`noulMargin(p, t)`).
- **Playwright can route MV3 worker `fetch`** with `context.route(...)`, but `chrome.permissions.request`
  never resolves under Playwright; use the manifest-copy workaround in `tests/e2e/helpers/provider.ts`.
- **Snapshot-then-mutate:** undo replay must be idempotent and resumable; discard by row id, never
  "latest"; serialize stack operations.
- **Read-modify-write belongs inside the row's transaction.**
- **Dexie migration test pattern:** seed a genuine vN-1 database, reopen with the real class, assert
  `verno` plus preserved rows; update verno/table-list assertions in the same commit.
- **IndexedDB read-assertions must not create the db** (`indexedDB.databases()` first).
- **Doc-drift discipline:** store disclosures must match `src/consent/disclosure.ts` constants nearly
  verbatim; grep actual call sites before trusting permission justifications.
- **Egress assertions filter OUT internal schemes** rather than matching only `http(s)`; assert after
  `context.close()`.
- **Module-level shared state needs an exported reset hook** (e.g. `resetJevClientPools()`).
- **`exactOptionalPropertyTypes`:** conditionally spread optional fields, never assign `undefined`.
- **Parallel-worktree recipe:** one `.worktrees/` worktree per task with hardlinked `node_modules`/`.wxt`,
  disjoint file sets, and one coordinator serializing commits, notes, plan markers, and `bd` updates.

---

<!-- Learnings from implementation will be appended below -->
