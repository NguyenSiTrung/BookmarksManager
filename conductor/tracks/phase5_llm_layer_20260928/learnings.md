# Track Learnings: phase5_llm_layer_20260928

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Read `conductor/patterns.md` before each task. It contains 98 consolidated
pattern entries from Phases 0–4. The ones most relevant to this track:

- **Scoped consent gates validate cheap-before-sensitive.** Scope registration
  and request-shape validation happen before consent rows, permissions, or key
  material are read. Prove short-circuits with dependency-spy call counts.
- **Fail-closed gates re-verify every call.** Destination, model, transport,
  origin, consent, exact host permission, credential, and feature payload are
  not trusted from setup-time state.
- **Keep the fixed Jev registry fixed.** Dynamic OpenAI-compatible destinations
  use a separate LLM gate rather than weakening `src/net/send.ts`.
- **Enable consent last; revoke consent first.** Partial setup cannot leave an
  egress-capable provider, and a partial revoke still fails closed.
- **Worker-owned secrets stay worker-only.** UI protocols receive masked
  suffixes and redacted status, never credential material.
- **Domain layers stay pure.** Provider parsing, structured-output validation,
  budget math, synopsis construction, and diff generation import no
  Chrome/DOM/React/fetch APIs.
- **Snapshot before mutation.** Restructure apply must be idempotently undoable;
  stale-tree validation happens before the first mutation.
- **Read-modify-write belongs inside the transaction.** This is required for
  concurrent budget reservations and persisted job cursors.
- **Dexie migrations use a genuine prior database.** Seed v3, reopen through
  the real class, assert the new version and preserved rows.
- **Unknown cost is not zero.** Existing usage code intentionally distinguishes
  absent provider cost from `$0.00`; LLM estimates must preserve provenance.
- **Exact optional properties are spread conditionally.** Never assign
  `undefined` under `exactOptionalPropertyTypes`.
- **MV3 jobs resume from committed progress.** User pause/cancel wins races;
  transient active-tab work is not falsely labeled resumable.
- **Playwright routes service-worker fetch, but its host-permission prompt is
  not trustworthy.** Keep routed e2e coverage and a real-Chrome manual gate.
- **Store disclosures mirror typed constants.** Sent fields, recipients,
  triggers, permissions, and consent versions change in one task.
- **Parallel workers use disjoint files.** The coordinator serializes shared
  entrypoints, package files, store docs, plan/learnings, commits, notes, and
  Beads state.

---

<!-- Learnings from implementation will be appended below -->
