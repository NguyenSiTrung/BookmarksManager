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
- **The eval runner reuses the hardened client, not a parallel fetch.** `makeEvalClient` wraps `createJevClient` with a bare-fetch `JevTransport` (no consent gate — none exists under vitest) at `maxConcurrency: 1`; the client's own timeout/retry/cross-check machinery supplies bounded aborts, missing-answer detection, and invented-candidate rejection for free.
- **Record error codes, never messages.** Observations store `errorCode` only — `JevClientError` messages are designed-redacted but codes are structurally guaranteed to carry no body/key material.
- **Excluded corpus fixtures produce `skipped` observations, not errors** — the excluded sensitive/malformed bookmarks exercise the same never-send path as production, keeping coverage honest (report separates coverage from accuracy).
- **`.gitignore` already covers `test-results/`** — the eval artifacts need no new ignore entry; noted here since the plan listed the file.
- **The client does not pin response-model equality** — it only checks batch consistency; the eval must enforce `acceptedModelIds` itself (`unexpected_model` error).
- **`as const` registries narrow default-parameter types.** Moving `0.5` literal into `RELEASE_THRESHOLDS` turned `isNoMatch`'s default `bar` into the literal type `0.5` — callers passing other values fail typecheck. Annotate `bar: number` explicitly when a default comes from a frozen record.
- **Pin defaults at the schema layer, warn at the UI layer.** `DEFAULT_PROVIDER_MODEL` lives next to `PRESET_MODELS` in `schemas/provider.ts` (single source for the picker's initial value); the warning/note copy stays in `net/provider-info.ts`. schemas→decisions runtime import is safe because release-policy only takes `import type`.
- **Eval and product share `RELEASE_JEV_MODELS`.** `EVAL_PROVIDERS` now derives `requestModel`/`acceptedModelIds` from the release registry — one edit retunes both the harness and the picker default, and the "accepted ids are never aliases" invariant is testable in one place.
- **Existing tests pinned the old default.** The alias-warning suite assumed `jev-latest` was the initial model; changing the default to a pinned id means those tests must `fireEvent.change` into an alias first — a useful reminder that defaults are behavioral contract, not just config.
- **`*/` inside a doc comment ends it.** The `https://*/*` host pattern cannot appear literally in a `/** */` block — vite/oxc fails the transform. Keep the pattern in string constants only; describe it in comments as "the broad any-HTTPS-host optional pattern" (recorded so check-store can keep it out of comments too).
- **`EXTENSION_PRIVACY_POLICY_REFERENCE` is store-pinned.** The consent snapshot asserts both store texts contain the constant verbatim (lowercased) — publishing the policy means updating the constant AND quoting it in `store/privacy-policy.md` + `store/privacy-practices.md` in the same change.
- **`scripting` was missing from two inventories.** privacy-practices justifications and reviewer-notes install list omitted it — the `https://*/*` reconciliation pass also catches permission drift like this; check:store should cross-check store/permissions.md rows against the other docs.
- **Release gates should report, not fail-fast.** `checkStore({root,release})` returns `{ok, violations:[{check,file,message}]}` so one run surfaces every gap — the CLI prints each `[check] file: message` and exits 1, while tests assert on the structured list.
- **Fixture-copying beats fixture-synthesizing for store docs.** `buildGoodFixture` copies the repo's real `store/*.md`, eval baseline, and source files into tmpdir — mutations then mirror real drift (e.g. case-insensitive text like "Capability only" needs `replaceAll(/capabilit/gi)`, and wrapped lines need `\s+`-tolerant regexes in the checker itself).
- **PNG size reads straight from IHDR** — bytes 16–24 BE after the 8-byte signature + "IHDR" tag; no image lib needed for a 33-byte synthetic fixture.
- **Version assets land late by design.** On the pre-Phase-3 tree, `check:store` correctly reports only `version`/`assets`/`release-record` violations — a release-strict gate is expected to fail until release artifacts exist.
- **TS needs a `.d.mts` beside imported `.mjs` scripts** for `typecheck` (TS7016); type the violations array so test assertions stay checked.
- **check-site treats the static site as fully self-contained.** Any `<script>` tag, `<form>`, `document.cookie`, tracker string, or external non-anchor asset (`link/img/iframe` href→http) is a violation — anchors to github.com are fine.
- **Policy equivalence is a field floor, not a diff.** check-site asserts every required string (publisher, contact, `consentVersion`, `jev_*`/`llm_*` scopes, Limited Use, capability-only note, version, effective date) in privacy-policy.md also appears in privacy/index.html — wording can differ, fields cannot.
- **Keep HTML-only checks behind `.endsWith(".html")`** — required non-HTML files (styles.css) otherwise get landmark/meta violations.
- **Playwright screenshots regenerate every asset deterministically** — `page.setContent` with the SVG inlined at the target viewport produces 16/32/48/128 icons; `page.goto(file://...)` at 440×280 produces the promo tile. No image libs needed.
- **Manifest icons in WXT are `icon/NN.png` paths under `public/`** — they land at the built root, so the manifest key is `icon/16.png` not `public/icon/16.png`.
- **Store screenshots are deterministic e2e captures, not manual shots.** `UPDATE_STORE_ASSETS=1` gates `tests/e2e/store-assets.spec.ts` — a synthetic `*.example` tree seeded through `chrome.bookmarks` renders the real production side panel at 1280×800; the spec is a no-op in the default suite.
- **`__dirname` is unavailable in the e2e ESM loader** — derive paths from `fileURLToPath(import.meta.url)` like `helpers/extension.ts` does.
- **Declare-or-helper for `chrome.*` in page.evaluate** — seed.ts carries a narrow `declare const chrome`; new specs should reuse `createBookmark`/`createFolder` rather than re-declaring the namespace inline.
- **`unzip -Z1` + `unzip -p` are the dependency-free zip inspector** — no adm-zip needed; `execFileSync` with a 64MB buffer covers the extension archive, and a null return doubles as "not a zip".
- **The audit forbids by entry-name class, not content** — `*.map`, `.env*`, `*.pem/key/p12/pfx`, sqlite/db/ldb/log, `test-results/`, `tests?/eval/` dirs, `conductor|store|docs|.beads|.agents|.github/`, `src/*.ts`, and project configs — because the zip's only job is shipping the runtime.
- **`npm version 1.0.0 --no-git-tag-version` bumps package.json + lockfile atomically** — wxt.config.ts still needs the manual edit; keep both pinned (check:store cross-checks them).
- **The release record is a gate artifact, not a post-it.** `store/releases/<v>.json` carries commit/bytes/sha256 generated from the clean-worktree build — check:store then validates version/commit/sha256 shape, so the record can't be stale-in-name-only.
- **A gate worktree must run `npm ci` before tests** — `npm run test -- --run` precedes `npm run build` in the sequence, so fixtures that read `.output` need a self-healing `beforeAll` build (committed a403526).
- **Zip determinism**: `wxt zip` reproduced byte-identical 412,893-byte archives across worktrees at the same commit — sha256 is a meaningful release identity.
