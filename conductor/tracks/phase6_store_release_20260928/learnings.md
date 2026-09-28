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
- **Sensitive-vs-private fixture tension resolves structurally, not by list.** Split `isNonPublicUrl` (structural: file:/hostless/private-IP/dotless/intranet-TLD, fail-closed) out of `isSensitiveUrl` (structural + builtin blocklist + user blocklist) in `src/decisions/minimize.ts`. Corpus fixtures may carry builtin-sensitive public domains (chase.com etc.) only when `excluded: true`; private/intranet URLs are rejected outright. The `excluded` flag on a fixture asserts the expected minimizer verdict, so the corpus cannot drift from runtime behavior.
- **"Malformed" fixtures must be truly unparseable.** `localhost:3000`-style strings parse as valid URLs (scheme `localhost:`, empty host) and would be rejected for the wrong reason. Use strings like `ht!tp://[`, `://missing-scheme.com`, `http://` for the unparseable-excluded class.
- **Zod 4 has no `.strict()` method — use `z.strictObject`.** Same for `discriminatedUnion` on `"kind"`. All imports go through `src/schemas/z.ts` (jitless build for MV3 CSP).
- **Deterministic corpus generation beats hand-written fixtures.** `scripts/generate-eval-corpus.mjs` emits the ~315-bookmark/294-case corpus from typed rows; keeping the generator in-repo makes the fixture auditable and regenerable. Watch for duplicate ids when fixed candidate lists collide with per-bookmark folders — dedupe while preserving the `current: true` entry order.
- **`npm install` state can drift on this VM.** `@mozilla/readability` was missing from node_modules though present in package.json, producing a phantom typecheck failure on clean main — run `npm install` before trusting baseline failures.
- **Score the policy outcome, not just the answer.** `scoreObservation` replays §10.2 bands (auto_apply/preselect/review/unsure) so the report directly answers "if toggles were on, how often would auto-apply have been wrong" — the incorrect-auto-apply rate is the release-policy evidence. Auto-apply is evaluated as if toggles were on; runtime toggles stay off.
- **Misfiled correctness has three-way semantics.** Predicting the current folder or "none" both mean "no move" in production — correct only for correctly-filed cases. Track `flaggedMisfiled` separately for detection precision/recall.
- **Reproduce production's add_tags confidence verbatim** (min noulMargin over selected tags at t=0.5) — import `noulMargin` rather than reimplementing.
- **Zod-inferred output types make defaults required in test fixtures** — `excluded: false` must be explicit in `satisfies EvalCorpus` literals; `noUncheckedIndexedAccess` means `cases[i]` needs `as EvalCase`.
