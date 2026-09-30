<!-- Last refreshed: 2026-09-30 -->

# Phase 6 Store Readiness and 1.0 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` or `executing-plans` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Jev 1.13 quality baseline, complete Chrome Web Store
materials, publish the privacy site, package version 1.0.0, and validate it
through the trusted-tester channel.

**Architecture:** Keep evaluation logic pure and deterministic, with networked
provider runs isolated in a key-gated Vitest configuration. Treat `store/` as
the release source of truth, validate it against manifest and consent
contracts, generate public Pages and visual assets from versioned sources, and
package the verified extension through WXT.

**Tech Stack:** WXT 0.21, Manifest V3, TypeScript 6 strict, Zod 4, Vitest 5,
Playwright 1.63, GitHub Pages, GitHub Actions, Chrome Web Store.

**Spec:** `conductor/archive/phase6_store_release_20260928/spec.md`

## Global Constraints

- Version 1.0 includes custom OpenAI-compatible providers and the existing
  broad optional HTTPS capability.
- Broad host capability remains optional; exact-origin consent and permission
  are re-checked before every provider request.
- Jev release behavior uses fixed 1.13 identifiers, not moving aliases.
- Moves, merges, and restructure operations never auto-apply.
- Tag/category auto-apply remains off by default.
- Evaluation fixtures contain no personal bookmark data, private URLs, notes,
  credentials, or provider response bodies.
- `store/privacy-policy.md` remains the canonical privacy-policy source.
- The link checker remains outside version 1.0.
- Public store submission remains outside this track.
- All phases use automated checks. The only Conductor manual verification is
  the final task of the final phase.
- Per task: failing test or artifact check, narrow red/green cycle, applicable
  gate, plan/learnings update, local commit, git note, and close the mapped
  Beads task.
- Never push, pull, fetch, deploy, upload, or run `bd dolt push` without
  explicit user authority.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Eval contracts | `src/eval/schema.ts`, `tests/eval/fixtures/*.json` | Versioned labeled corpus and case validation |
| Eval metrics | `src/eval/metrics.ts`, `src/eval/report.ts` | Pure metric calculation and JSON/Markdown reports |
| Live evaluation | `tests/eval/jev-eval.live.test.ts`, `vitest.eval.config.ts` | Key-gated provider execution |
| Release policy | `src/decisions/release-policy.ts`, `src/decisions/policy.ts`, `src/schemas/provider.ts` | Fixed models and evidence-backed thresholds |
| Store checks | `scripts/check-store.mjs`, `tests/unit/check-store.test.ts` | Version, URL, disclosure, asset, and placeholder checks |
| Public site | `site/index.html`, `site/privacy/index.html`, `site/styles.css` | GitHub Pages homepage and privacy policy |
| Pages deployment | `.github/workflows/pages.yml` | User-triggered static-site deployment |
| Store assets | `store/assets/`, `public/icon/`, `scripts/generate-store-assets.mjs` | Icons, screenshots, and promotional tile |
| Release packaging | `wxt.config.ts`, `scripts/audit-release.mjs`, `store/releases/` | Versioned ZIP, audit, checksum, and evidence |
| Store materials | `store/*.md`, `PROJECT_PLAN.md`, `conductor/product.md` | Listing, dashboard, reviewer, and approved-scope truth |

---

## Phase 1: Labeled Evaluation and Pinned Jev Policy

- [x] Task 1: Define the evaluation corpus and add labeled fixtures (aec3d47)
  - Files: create `src/eval/schema.ts`,
    `tests/eval/fixtures/corpus.json`, and
    `tests/unit/eval-schema.test.ts`.
  - Interfaces: strict `EvalCorpus` with `version`, `bookmarks`, and
    discriminated `cases`; case kinds are `categorize`, `tags`, `placement`,
    `misfiled`, `near_duplicate`, and `rerank`.
  - Red tests accept one valid case of every kind and reject duplicate IDs,
    unknown references/candidates, private or intranet URLs, notes,
    credentials, and unknown keys. Assert approximately 300 bookmark records
    and coverage of every shipped set.
  - Green implementation uses only synthetic/public-looking data, including
    ambiguous, low-confidence, multilingual, and sensitive-site cases.
  - Verify:
    `npx vitest run tests/unit/eval-schema.test.ts && npm run typecheck`.

- [x] Task 2: Implement deterministic evaluation metrics and reports (dae4a35)
  - Files: create `src/eval/metrics.ts`, `src/eval/report.ts`,
    `tests/unit/eval-metrics.test.ts`, and
    `tests/unit/eval-report.test.ts`.
  - Interfaces: `scoreObservation(observation, thresholds)`,
    `aggregateEval(corpus, observations, thresholdGrid)`,
    `renderEvalJson(report)`, and `renderEvalMarkdown(report)`.
  - Reports include model IDs, corpus/question-set versions, counts,
    accuracy/agreement, coverage, review, unsure, auto-apply, and
    incorrect-auto-apply rates.
  - Red tests cover exact threshold boundaries, multi-label tag
    precision/recall, pair/ranking metrics, incomplete output, incorrect
    auto-apply counting, stable ordering, and deterministic serialization.
  - Green implementation imports no network, Chrome, DOM, filesystem, or
    wall-clock surface; callers inject `generatedAt`.
  - Verify:
    `npx vitest run tests/unit/eval-metrics.test.ts tests/unit/eval-report.test.ts`.

- [x] Task 3: Add the key-gated TypeSafe/OpenRouter evaluation runner (23be89c)
  - Files: create `vitest.eval.config.ts`,
    `tests/eval/jev-eval.live.test.ts`, and `tests/eval/provider.ts`;
    modify `package.json`, `package-lock.json`, and `.gitignore`.
  - TypeSafe requests `jev-1.13.0`; OpenRouter requests
    `typesafe/jev-1.13`. Accepted response IDs are explicit and actual IDs are
    recorded.
  - `npm run test:eval` writes JSON and Markdown under `test-results/eval/`.
  - Red tests cover key-specific skip behavior, moving-alias rejection,
    unexpected model IDs, timeout, malformed response, missing answers, and
    invented candidates without leaking bodies or keys.
  - Green implementation builds requests through production question-set
    builders, serializes provider calls, and uses bounded aborts.
  - Verify:
    `npx vitest list --config vitest.eval.config.ts --filesOnly` and
    `npm run test:eval` without keys; both providers skip cleanly.

- [x] Task 4: Pin release models and evidence-backed confidence policy (851af50)
  - Files: create `src/decisions/release-policy.ts`; modify
    `src/decisions/policy.ts`, `src/schemas/provider.ts`,
    `src/net/provider-info.ts`,
    `src/entrypoints/options/ProviderSetup.tsx`,
    `tests/unit/decisions-policy.test.ts`, and create
    `store/evals/jev-1.13-baseline.md`.
  - Interfaces: `RELEASE_JEV_MODELS` owns fixed request/response identifiers;
    `RELEASE_THRESHOLDS` owns review, preselect, auto-apply, and rerank bars.
  - Red tests prove fixed defaults, moving-alias warnings, default-off
    auto-apply, never-auto-apply safety invariants at confidence 1, and shared
    UI/policy constants.
  - Green implementation selects evidence-backed thresholds; when evidence is
    insufficient, retain the safer current value and record uncertainty.
  - Verify:
    `npx vitest run tests/unit/decisions-policy.test.ts tests/components/provider-setup.test.tsx`
    and `npm run typecheck`.

## Phase 2: Version 1.0 Compliance Baseline

- [x] Task 1: Reconcile the approved broad-provider release scope (08e35b0)
  - Files: modify `PROJECT_PLAN.md`, `conductor/product.md`,
    `store/permissions.md`, `store/privacy-policy.md`,
    `store/privacy-practices.md`, `store/listing.md`,
    `store/reviewer-notes.md`, `src/consent/disclosure.ts`, and
    `tests/unit/consent-snapshot.test.ts`.
  - Replace the earlier "custom providers in 1.1" recommendation with the
    approved 1.0 scope. Explain that `https://*/*` is optional capability, not
    default access, while retaining exact-origin consent, permission,
    redirect, credential, and revoke guarantees. Keep the link checker in 1.1.
  - Obtain the real publisher display name and monitored support contact; do
    not infer them.
  - Public URLs:
    `https://nguyensitrung.github.io/BookmarksManager/`,
    `https://nguyensitrung.github.io/BookmarksManager/privacy/`, and
    `https://github.com/NguyenSiTrung/BookmarksManager/issues`.
  - Verify:
    `npx vitest run tests/unit/consent-snapshot.test.ts tests/unit/manifest.test.ts`
    and `npm run check:manifest`.

- [x] Task 2: Add the strict store-readiness checker (5af6977)
  - Files: create `scripts/check-store.mjs` and
    `tests/unit/check-store.test.ts`; modify `package.json`,
    `package-lock.json`, and `.github/workflows/ci.yml`.
  - Interface: `checkStore({ root, release })` returns all structured
    violations; `npm run check:store` runs release-strict validation.
  - Red tests detect unfinished markers, missing publisher/contact/URLs,
    version disagreement, undocumented permissions, absent Limited Use or
    custom-provider text, missing reviewer/dashboard content, missing or
    wrong-size assets, moving release model defaults, and missing eval/release
    evidence.
  - Green implementation parses local files conservatively, reports every
    violation in one run, and performs no remote request in CI.
  - Verify:
    `npx vitest run tests/unit/check-store.test.ts`,
    `npm run check:store`, `npm run lint`, and `npm run typecheck`.

## Phase 3: Public Site, Listing, and Store Assets
<!-- execution: parallel -->

- [x] Task 1: Build the static GitHub Pages site (6e37c82)
  <!-- files: site/index.html, site/privacy/index.html, site/styles.css, site/404.html, scripts/check-site.mjs, tests/unit/check-site.test.ts, .github/workflows/pages.yml -->
  - Homepage links to privacy and support in one click. The privacy page is
    materially equivalent to `store/privacy-policy.md` and includes all
    release identity, recipient, custom-provider, key, deletion, Limited Use,
    version, and effective-date fields.
  - Pages uses `workflow_dispatch` and `/BookmarksManager/` base paths.
  - Red tests cover broken links, missing landmarks/metadata, policy drift,
    remote scripts, trackers, forms, cookies, and external fonts.
  - Verify:
    `npx vitest run tests/unit/check-site.test.ts` and
    `node scripts/check-site.mjs`.

- [x] Task 2: Create reproducible icons and promotional assets (2752d51)
  <!-- files: store/assets/source/icon.svg, store/assets/source/promo.html, scripts/generate-store-assets.mjs, public/icon/16.png, public/icon/32.png, public/icon/48.png, public/icon/128.png, store/assets/icon-128.png, store/assets/promo-440x280.png, wxt.config.ts, tests/unit/manifest.test.ts -->
  - Render PNGs from committed SVG/HTML through Playwright. Use no
    third-party logo and preserve 16x16 legibility.
  - Red tests cover missing manifest icons, nonexistent paths, invalid PNG
    signatures/IHDR dimensions, and a promo tile other than 440x280.
  - Verify:
    `node scripts/generate-store-assets.mjs`, `npm run build`,
    `npx vitest run tests/unit/manifest.test.ts`, and
    `npm run check:manifest`.

- [x] Task 3: Capture real UI screenshots and finalize listing materials (d51484c)
  <!-- files: tests/e2e/store-assets.spec.ts, store/assets/screenshot-manager-1280x800.png, store/listing.md, store/privacy-practices.md, store/reviewer-notes.md, scripts/check-store.mjs, tests/unit/check-store.test.ts -->
  <!-- depends: task1, task2 -->
  - Seed deterministic synthetic bookmarks and capture the real production
    side panel at 1280x800. Exclude keys, personal data, test controls, broken
    favicons, and provider logos.
  - Finalize category, language, 1.0 release notes, dashboard worksheet, broad
    optional permission rationale, and reviewer walkthrough.
  - Verify:
    `UPDATE_STORE_ASSETS=1 xvfb-run -a npx playwright test tests/e2e/store-assets.spec.ts`,
    `npm run check:store`, and `xvfb-run -a npm run test:e2e`.
  - Visual review is deferred to the final track verification.

## Phase 4: Release Candidate and Trusted-Test Release

- [x] Task 1: Set version 1.0.0 and add release packaging/audit (cbd8cdf)
  - Files: modify `package.json`, `package-lock.json`, and `wxt.config.ts`;
    create `scripts/audit-release.mjs`,
    `tests/unit/audit-release.test.ts`, and
    `store/releases/1.0.0-checklist.md`.
  - `npm run zip` invokes `wxt zip`.
  - `auditRelease({ zipPath, expectedVersion })` rejects forbidden entries and
    returns name, size, SHA-256, and manifest summary.
  - Red tests cover version mismatch, missing icons/manifest, source maps,
    `.env`, keys, databases, test/eval output, development files, and
    permission drift.
  - Verify:
    `npm run build`, `npm run zip`,
    `node scripts/audit-release.mjs .output/*-1.0.0-chrome.zip`, and
    `npx vitest run tests/unit/audit-release.test.ts`.

- [x] Task 2: Run the final automated gate and record the candidate (7f534f6)
  - Files: create `store/releases/1.0.0.json`; update
    `store/releases/1.0.0-checklist.md` and `PROJECT_PLAN.md` only with
    verified evidence.
  - Build from a clean worktree at the committed 1.0.0 source revision.
  - Run:
    `npm ci`;
    `npm run lint`;
    `npm run typecheck`;
    `npm run test -- --run`;
    `npm run build`;
    `npm run check:manifest`;
    `npm run check:bundle`;
    `npm run check:store`;
    `node scripts/check-site.mjs`;
    `xvfb-run -a npm run test:e2e`;
    `npm run test:live`;
    `npm run test:eval`;
    `npm run zip`;
    and the release ZIP audit.
  - Record source commit, commands, pass/skip counts, ZIP path, size, and
    SHA-256. Live smoke and eval gates must run with both provider credentials
    before final verification.

- [x] Task: Conductor - User Manual Verification
      'Store readiness and 1.0 trusted-tester release'
      (Protocol in workflow.md)
  - This is the only manual-verification task in the track.
  - Present eval/threshold evidence, the complete automated gate, Pages
    preview, assets, listing/dashboard/reviewer materials, section 13.13
    evidence, and the audited ZIP checksum.
  - User-controlled actions:
    1. Confirm publisher identity, contact, trader status, developer
       registration, and 2-Step Verification.
    2. Authorize/push and trigger the Pages deployment.
    3. Verify public homepage and privacy URLs.
    4. Enter approved dashboard answers.
    5. Upload the exact ZIP to the trusted-tester channel.
    6. Install the distributed build and perform the documented smoke.
    7. Verify update behavior when a prior trusted-test build exists.
  - Record non-secret Pages/release/install evidence. Public submission remains
    out of scope.
  - User confirmed manual verification complete on 2026-09-28.
