# Phase 6: Store Readiness and 1.0 Trusted-Tester Release

## Overview

Prepare Bookmarks Manager version 1.0 for Chrome Web Store distribution and
release it to trusted testers.

The track establishes a reproducible Jev quality baseline, pins release
decisions to Jev 1.13, reconciles code and store disclosures, publishes a
GitHub Pages privacy-policy site, produces required listing assets, builds a
verified 1.0 upload package, and validates installation through the
trusted-tester channel.

Version 1.0 includes custom OpenAI-compatible providers. Broad optional HTTPS
and loopback host capabilities are therefore intentional release behavior and
must be accurately justified and disclosed. This supersedes the earlier
narrow-presets-only staging recommendation in `PROJECT_PLAN.md`; the plan and
product context must be updated to match the approved release boundary.

Public Chrome Web Store submission, review, and general-availability
publication are separate milestones.

## Functional Requirements

### FR1 — Labeled quality fixtures

1. Add approximately 300 synthetic, rights-safe, non-personal bookmark
   fixtures covering categories, tags, folder placement, misfiled detection,
   near-duplicate decisions, and Ask re-ranking.
2. Include representative domains, languages, ambiguous cases,
   sensitive-site exclusions, malformed inputs, and deliberately
   low-confidence examples.
3. Store expected labels and fixture-version metadata in reviewable,
   schema-validated files.
4. Do not include real user bookmark exports, credentials, personal notes, or
   private URLs.
5. Test valid fixtures and invalid fixture rejection.

### FR2 — Jev evaluation runner

1. Add a key-gated evaluation command that runs shipped question sets against
   TypeSafe and OpenRouter's corresponding Jev route.
2. Pin evaluation and release defaults to the Jev 1.13 model family, using
   fixed provider-specific identifiers rather than moving aliases such as
   `jev-latest`.
3. Record configured and returned model identifiers and fail closed on an
   unexpected model.
4. Report, per question set and threshold: sample count, accuracy or
   task-appropriate agreement, coverage, review-queue rate,
   unsure/escalation rate, auto-apply rate, and incorrect-auto-apply rate.
5. Keep paid/network evaluation outside the default offline suite while
   testing aggregation and report generation deterministically.
6. Produce versioned human-readable and machine-readable reports without
   committing keys or sensitive provider payloads.
7. Require re-evaluation when a model identifier, question wording, candidate
   construction rule, or `questionSetVersion` changes.

### FR3 — Confidence-policy release baseline

1. Select and document per-question thresholds from labeled evaluation
   evidence.
2. Preserve all safety invariants:
   - moves never auto-apply;
   - merges never auto-apply;
   - restructure operations never auto-apply;
   - automatic tag/category application remains opt-in and off by default.
3. Pin chosen model identifiers, thresholds, fixture version, and question-set
   versions in release-controlled configuration.
4. Do not weaken a safety rule solely to improve automated coverage or
   acceptance metrics.
5. When evidence is insufficient to justify a threshold, retain the safer
   existing threshold, record the uncertainty, and surface it in the final
   verification.

### FR4 — Intentional broad optional-provider scope

1. Keep custom OpenAI-compatible provider support in version 1.0.
2. Retain only optional host patterns required by shipped preset, custom
   HTTPS, and literal-loopback provider behavior.
3. Continue requesting the exact configured origin from a direct user gesture
   and re-checking exact-origin consent and permission before every request.
4. Reconcile the intentional broad optional HTTPS capability with
   `PROJECT_PLAN.md`, `conductor/product.md`, the generated manifest, and all
   `store/` release documents.
5. Explain why broad optional capability is needed while making clear that no
   origin is granted by default.
6. Keep the link checker and its network behavior out of version 1.0.

### FR5 — Automated store-readiness checks

1. Preserve and extend manifest and bundle checks.
2. Add a release-readiness check that detects unresolved release placeholders,
   version mismatches, missing required asset sizes, missing homepage/support/
   privacy URLs, permission/disclosure drift, stale release-scope statements,
   missing Limited Use language, prohibited remote-code constructs, and
   accidental inclusion of credentials or private evaluation data.
3. Keep code, permission inventory, consent scopes, data inventory, listing
   claims, and privacy statements synchronized.
4. Run release checks in CI without provider keys.
5. Keep live provider smoke and quality-evaluation commands key-gated.

### FR6 — GitHub Pages website and privacy policy

1. Add a static project homepage and public privacy-policy page suitable for
   GitHub Pages.
2. Keep `store/privacy-policy.md` as the canonical policy source or verify that
   the published page is materially equivalent.
3. Make the privacy policy reachable in one click from the homepage.
4. Include real publisher identity and contact, locally stored data, every
   third-party recipient and trigger, custom-provider behavior, API-key
   handling, deletion controls, security practices, provider-policy links,
   effective date, policy version, and the required Limited Use statement.
5. Publish stable homepage, support, and privacy URLs.
6. Add an automated link/content check for the generated site.
7. Treat deployment as an explicit user-authorized action; do not claim
   success until public URLs resolve.

### FR7 — Store listing and visual assets

1. Finalize name, short description, full description, and "What's new" copy
   for version 1.0.
2. State clearly that core features work without an account or API key, AI
   features are optional, users supply provider credentials, custom providers
   are supported, and data leaves the device only after feature-specific
   consent.
3. Produce and validate packaged icons at 16x16, 32x32, 48x48, and 128x128;
   at least one real-UI screenshot at 1280x800 or 640x400; and a 440x280
   promotional tile.
4. Do not use third-party logos, endorsement implications, keyword stuffing,
   or unverifiable privacy claims.
5. Store source and export assets under `store/assets/` with reproducible
   generation instructions where practical.

### FR8 — Dashboard and reviewer materials

1. Finalize a dashboard worksheet containing the single-purpose statement,
   per-permission justifications, remote-code answer, conservative data-use
   declarations, Limited Use certifications, public URLs, and trader status.
2. Update reviewer notes with a complete no-key walkthrough, custom-provider
   permission and consent behavior, AI testing instructions, and whether a
   temporary low-credit test credential will be supplied separately.
3. Verify current Chrome Web Store labels and policies immediately before
   upload.
4. Require manual confirmation of developer-account registration, 2-Step
   Verification, monitored contact email, and trader status at the final
   verification.
5. Never commit dashboard credentials, test keys, recovery codes, or private
   account details.

### FR9 — Version 1.0 release candidate

1. Set extension and package release versions consistently to `1.0.0`.
2. Produce the release candidate from a clean checkout.
3. Run lint, typecheck, unit/component tests, production build, manifest and
   bundle checks, store-readiness checks, headed Playwright end-to-end tests,
   accessibility and zero-egress gates, live provider smokes, and quality
   evals.
4. Produce a Chrome Web Store upload ZIP from the verified build.
5. Record artifact name, size, SHA-256 checksum, source commit, build command,
   and gate results.
6. Verify the ZIP contains only required extension files and no secrets, local
   databases, sensitive reports, or development artifacts.

### FR10 — Pre-submission audit and trusted-tester release

1. Complete every applicable item in `PROJECT_PLAN.md` section 13.13.
2. Record evidence or a blocking reason for every checklist item.
3. Stop release when any required item is unresolved.
4. Have the user perform authenticated Chrome Web Store dashboard and account
   actions during the final track verification.
5. Upload the verified package to a trusted-tester or equivalent non-public
   channel.
6. Install the distributed build as a trusted tester and verify fresh-install
   zero egress, offline core behavior, install permissions, provider consent
   and exact-origin permission behavior, public links, version, and package
   identity.
7. Verify update behavior when a prior trusted-test build exists.
8. Record the trusted-tester release identifier and verification evidence
   without exposing account secrets.
9. Use automated phase gates throughout the track. The only Conductor manual
   verification task is the final task after all automatable work is complete.

## Non-Functional Requirements

### Privacy and security

- No account, developer backend, analytics, telemetry, remote code, or default
  network traffic.
- No credentials or real personal bookmark data in fixtures, reports, assets,
  logs, or release packages.
- Broad optional host capability must not become install-time host access.
- Every provider request remains consent-gated and exact-origin checked.
- Existing encryption, redaction, URL minimization, sensitive-site blocking,
  and data-deletion guarantees remain intact.

### Reproducibility

- Offline tests and metric aggregation are deterministic.
- Live evaluations record enough version metadata to compare runs.
- Store assets and site output have validated dimensions and content.
- The release artifact is traceable to one source commit and checksum.

### Accessibility and usability

- Existing accessibility gates remain green.
- Store screenshots and reviewer instructions reflect real, operable UI.
- Website pages are keyboard-accessible, responsive, readable, and include
  appropriate headings, landmarks, contrast, and alternative text.

### Compliance accuracy

- Repository documentation, public policy content, dashboard answers, manifest
  capabilities, and shipped behavior must agree.
- Manual/account-dependent gates are identified explicitly and cannot be
  marked complete without human evidence.
- Current Chrome Web Store and provider policies are re-read before upload.

## Acceptance Criteria

1. Approximately 300 validated labeled fixtures cover all shipped Jev question
   sets.
2. TypeSafe and OpenRouter eval commands produce versioned reports for fixed
   Jev 1.13 identifiers.
3. Release thresholds and question-set versions are pinned and supported by
   reviewed evidence.
4. Safety invariants prohibit automatic move, merge, or restructure mutations.
5. Version 1.0 custom-provider and broad optional-host behavior is consistently
   documented and justified.
6. Automated checks detect manifest, disclosure, version, URL, placeholder,
   and asset drift.
7. A GitHub Pages homepage and privacy policy are publicly reachable at
   approved stable URLs.
8. Required icons, screenshot assets, and promotional tile pass automated
   dimension checks.
9. Listing, dashboard worksheet, privacy materials, and reviewer notes contain
   no unresolved release placeholders.
10. Publisher/account prerequisites are manually confirmed at the final
    verification.
11. All required quality gates pass from a clean checkout.
12. A `1.0.0` upload ZIP and SHA-256 checksum are recorded against the source
    commit.
13. Every applicable section 13.13 checklist item has evidence and no
    unresolved blocker.
14. A trusted tester installs the distributed build and completes the release
    smoke test.
15. No public submission or general-availability publication occurs as part of
    this track.

## Out of Scope

- Public Chrome Web Store submission, review correspondence, and
  general-availability publication.
- Store-review calendar time.
- The version 1.1 link checker.
- New AI decision features or provider protocols.
- Scheduled maintenance, smart collections, threshold-tuning UI, and other
  version 2 work.
- Developer-hosted services, analytics, telemetry, accounts, or cloud sync.
- Automated manipulation of authenticated Chrome Web Store account settings.
