# Track Learnings: perf_ux_hardening_20261014

Patterns, gotchas, and context discovered during implementation.

## Approved Decisions (2026-10-14)

- Scope includes all 39 findings from the 2026-10-14 whole-codebase audit: Backend/MV3 correctness (`B-01`–`B-16`), 5k–20k scaling performance (`P-01`–`P-13`), and UI/UX & accessibility (`U-01`–`U-10`).
- Side-panel page summarization (`B-06`) requests runtime origin permission on the user's `"Agree and summarize"` click (using the existing optional `https://*/*` / loopback capability) when `activeTab` is not active on the target tab.
- High (P1) priority, automated gates only (no manual wait at phase boundaries or completion), and task-level parallel execution enabled for file-disjoint tasks within phases.

## Codebase Patterns (Inherited from `conductor/patterns.md` & `deep_audit_fixes_20261005`)

- **Strict TypeScript & CSP-safe Zod:** `verbatimModuleSyntax` + `noUncheckedIndexedAccess`; import `z` exclusively from `src/schemas/z.ts` (jitless mode).
- **Total Message Handlers & Fail-Closed Gates:** `runtime.onMessage` handlers return `{ok:true,…} | {ok:false,code,message}` Zod unions and never throw or leak `cause` objects. Outbound network calls live only in `src/net/{send,llm-send}.ts`.
- **Dexie & Concurrency Invariants:** Read-modify-write belongs inside the table's `rw` transaction. Dexie `add`/`put` mutates inbound keys onto caller objects—always pass fresh copies.
- **Undo & Mutation Ordering:** Enable writes settings → key → consent; revoke removes consent first. Undo replay must be idempotent and resumable under `withUndoLock`; flow-owned snapshots use `discardById(snapshotId)` / `restoreById(snapshotId)` rather than stack-head `discardLatest()` / `undoExpected()` when concurrent snapshots can interleave.
- **Parallel-Safe Performance Tests:** Never assert a single wall-clock sample under 17-worker Vitest load; use best-of-N minimum estimators (`tests/unit/search-perf.test.ts`) or injected cadence seams (`pollMs`, `undoToastAutoHideMs`).
- **Store & Manifest Discipline:** Keep `store/permissions.md`, `store/reviewer-notes.md`, and `wxt.config.ts` aligned; verify with `npm run check:manifest` and `npm run check:store`.

---

<!-- Learnings from implementation will be appended below -->
