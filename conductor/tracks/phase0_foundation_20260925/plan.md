# Phase 0 Foundation and Provider Connection Implementation Plan

> **Last Revised: 2026-09-25** — Revision 1: manual phase-verification gates waived for the rest of this track; see `revisions.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable MV3 extension foundation and a consented, testable TypeSafe/OpenRouter connection flow without sending bookmark data.

**Architecture:** WXT bundles React extension surfaces and a service worker. The Options page obtains origin-specific permission from a click, while the worker alone stores/decrypts keys and sends synthetic Jev test traffic through a consent-enforcing network gate. Zod validates storage/message/wire boundaries and Dexie persists metadata, consent, audit, and non-extractable key material.

**Tech Stack:** WXT, React, Tailwind, strict TypeScript, Zod v4 (jitless), Dexie, WebCrypto, Vitest, Testing Library, Playwright, ESLint, GitHub Actions.

**Spec:** `conductor/tracks/phase0_foundation_20260925/spec.md`; product constraints also live in `PROJECT_PLAN.md` §§7, 8, 12, 13, 15, and 18.

## Global Constraints

- Do not send network traffic on install or page load; only an explicit Test connection action can do so.
- The only permitted remote origins are `https://api.typesafe.ai` and `https://openrouter.ai`; no custom, broad, or HTTP host patterns. `CONSENT_VERSION` must increase if fields or recipients change.
- Request the chosen optional host permission from a direct user click. Consent is an unchecked, affirmative, versioned `jev_test` grant for one origin and the synthetic test fields only.
- All application `fetch` calls live in `src/net/`; use HTTPS, `credentials: "omit"`, and `redirect: "error"`. Check consent **and** Chrome permission before every call.
- Keep raw keys inside the Options-to-worker enable message and worker memory only; store AES-GCM ciphertext in `chrome.storage.local` and a non-extractable `CryptoKey` in IndexedDB. Never log or return raw keys.
- Validate external responses and extension messages with Zod. Configure `z.config({ jitless: true })` before defining schemas.
- Add only permissions used by this slice; documentation and the generated manifest must agree. Keep `.beads/issues.jsonl` and other existing user work untouched.
- For each implementation task: first observe a failing behavior test (or verify a missing scaffolding artifact), implement, run the narrowest relevant checks, update this plan and `learnings.md`, commit only intended files locally, add a `git notes` task summary, then close its mapped Beads task. During parallel execution, each worker owns only its annotated implementation files in an isolated worktree; the coordinator serializes edits to shared `plan.md`, `learnings.md`, Beads task status, and commits/notes after each worker reports passing checks. Never push, pull, fetch, or sync Dolt automatically.
- ~~The last task of each phase is manual verification per `conductor/workflow.md`. Do not mark it done until the user verifies that phase.~~ *(Revised 2026-09-25, see `revisions.md`)* Phase-end tasks are **automated evidence checkpoints**: run the full local gate (lint, typecheck, tests, build, e2e, `check:manifest`, `check:bundle`), record evidence in `learnings.md`, and mark complete on green — no user-approval gate. Phase 1 was manually verified by the user on 2026-09-25.

## File and Interface Map

| Area | Files | Responsibility |
|---|---|---|
| Build/surfaces | `package.json`, `wxt.config.ts`, `tsconfig.json`, `src/entrypoints/{background.ts,popup/,sidepanel/,options/}`, `src/ui/styles.css` | MV3 bundle and accessible extension shells |
| Tests/tooling | `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `tests/{unit,components,e2e}/`, `.github/workflows/ci.yml` | Local and CI checks, Chrome smoke tests |
| Schemas/storage | `src/schemas/{z,bookmark,decision,provider}.ts`, `src/db/database.ts` | Validated records and versioned IndexedDB tables |
| Secrets/consent | `src/security/keys.ts`, `src/consent/{records,disclosure}.ts`, `src/messages/provider.ts` | Encrypted keys, scope/origin/version grants, typed worker messages |
| Network/Jev | `src/net/{presets,send}.ts`, `src/jev/{wire,connection}.ts` | Closed destination list, enforced transport, synthetic test and response validation |
| Compliance | `store/{permissions,privacy-policy,privacy-practices,listing,reviewer-notes}.md`, `scripts/{check-manifest,check-bundle}.mjs` | Actual-slice disclosures and build compliance checks |

`PresetId` is `"typesafe" | "openrouter"`. The TypeSafe model choices are `jev-latest`, `jev-preview`, and `jev-1.13.0`; OpenRouter choices are `jev-latest`, `jev-1.13`, and `typesafe/jev-1.13` as listed in `PROJECT_PLAN.md` §8.1. `ProviderSettings` stores `preset`, `model`, and a masked `keySuffix`, never a raw key, in the Dexie `metadata` table keyed by preset. `ConsentRecord` stores `scope: "jev_test"`, `origin`, `consentVersion`, and `acceptedAt`. The preset registry maps each `PresetId` to its immutable origin, URL, Chrome permission pattern, and allowed model names. The later Jev provider track may extend these interfaces but must not reuse this synthetic-only consent for bookmark analysis.

---

## Phase 1: Runnable Extension and Data Baseline
<!-- execution: parallel -->

- [x] Task: Scaffold the WXT extension, linting, and test runners
  <!-- files: package.json, package-lock.json, wxt.config.ts, tsconfig.json, eslint.config.mjs, vitest.config.ts, playwright.config.ts, src/entrypoints/background.ts, src/entrypoints/popup/index.html, src/entrypoints/popup/main.tsx, src/entrypoints/sidepanel/index.html, src/entrypoints/sidepanel/main.tsx, src/entrypoints/options/index.html, src/entrypoints/options/main.tsx, src/ui/styles.css, tests/unit/scaffold.test.ts, tests/e2e/shell.spec.ts -->

  **Files:** Create `package.json`, `package-lock.json`, `wxt.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `src/entrypoints/background.ts`, popup/sidepanel/options HTML and React entry files, `src/ui/styles.css`, `tests/unit/scaffold.test.ts`, `tests/e2e/shell.spec.ts`. Install all Phase 1 dependencies now, including Zod v4, Dexie, and fake-indexeddb, to avoid package/lockfile edits in concurrent tasks.

  **Interfaces:** Produces `npm run lint`, `typecheck`, `test`, `test:e2e`, `build`, `check:manifest`, and `check:bundle` scripts; the last two are invoked only after the scripts are authored in Task 3. WXT uses `srcDir: "src"`. The manifest initially has required `storage` and `sidePanel` and optional TypeSafe/OpenRouter origins only.

  - [x] Step 1: Add a Vitest scaffold contract that expects popup, side-panel, options, and background entrypoints and the narrow manifest patterns. For example:
    ```ts
    import { existsSync } from "node:fs";
    import { describe, expect, it } from "vitest";
    import config from "../../wxt.config";

    describe("extension scaffold", () => {
      it("declares only the initial host patterns", () => {
        expect(config.manifest?.optional_host_permissions).toEqual([
          "https://api.typesafe.ai/*",
          "https://openrouter.ai/*",
        ]);
      });
      it("has an Options entrypoint", () => {
        expect(existsSync("src/entrypoints/options/index.html")).toBe(true);
      });
    });
    ```
  - [x] Step 2: Run `test -f package.json && test -f src/entrypoints/options/index.html`; observe a failing scaffold precondition because no project files exist yet. The Vitest contract runs after the runner is installed in Step 3.
  - [x] Step 3: Install compatible WXT/React/Tailwind/TS/Vitest/Testing Library/Playwright/ESLint/Zod v4/Dexie/fake-indexeddb dependencies with npm (do not replace existing repository files). Run the Vitest contract while `wxt.config.ts`/entrypoints are missing and observe a failure; then create the manifest config and extension shells:
    ```ts
    import { defineConfig } from "wxt";
    export default defineConfig({
      srcDir: "src",
      manifest: {
        name: "Bookmarks Manager",
        version: "0.1.0",
        permissions: ["storage", "sidePanel"],
        optional_host_permissions: [
          "https://api.typesafe.ai/*",
          "https://openrouter.ai/*",
        ],
      },
    });
    ```
    Use `@wxt-dev/module-react` and Tailwind's local build plugin; do not use CDN styles/scripts. Add the ESLint `no-restricted-globals` rule for `fetch` in app code, scoped exception for `src/net/`, and a rule preventing `globalThis.fetch` elsewhere. Add `check:manifest` and `check:bundle` npm scripts pointing to `scripts/check-manifest.mjs` and `scripts/check-bundle.mjs`, but do not invoke them before Task 3 creates those files. Add a WXT `background.ts` with no startup requests and accessible shell content on all three pages.
  - [x] Step 4: Configure scripts (`typecheck` runs `wxt prepare && tsc --noEmit`) and a Playwright persistent Chromium extension smoke test; run `npm run test -- --run`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:e2e`. Verify the built manifest contains no `bookmarks`, `activeTab`, `scripting`, wildcard hosts, or unused provider patterns.
  - [x] Step 5: Mark this task complete in this plan, record setup/version gotchas in `learnings.md`, stage only this task's files, inspect `git diff --cached --check` and status, commit `chore(setup): Scaffold extension and test harness`, add a specific `git notes add -m "Scaffolded WXT and validated initial test runners" HEAD` task summary, and close its mapped Beads task.

- [x] Task: Add base Zod schemas and versioned Dexie storage
  <!-- files: src/schemas/z.ts, src/schemas/bookmark.ts, src/schemas/decision.ts, src/schemas/provider.ts, src/db/database.ts, tests/unit/schemas.test.ts, tests/unit/database.test.ts, tests/fixtures/base-records.ts -->
  <!-- depends: task1 -->

  **Files:** Create `src/schemas/z.ts`, `src/schemas/bookmark.ts`, `src/schemas/decision.ts`, `src/schemas/provider.ts`, `src/db/database.ts`, `tests/unit/schemas.test.ts`, `tests/unit/database.test.ts`, `tests/fixtures/base-records.ts`. Consume the Phase 1 Task 1 dependencies; do not edit `package.json` or the lockfile.

  **Interfaces:** Exports `Bookmark`, `Tag`, `Decision`, `ProviderSettings`, and `ConsentRecord` schemas with inferred types. Exports `db` with version 1 tables `metadata`, `decisions`, `consents`, `sentLog`, and `keyMaterials`; no bookmark-tree sync.

  - [x] Step 1: Write table-driven valid/invalid fixture tests for URL, title length, default health, tag length, confidence range, discriminated decision kinds, `jev_test` consent, and the preset-specific model allowlists. Write a Dexie test with fake-indexeddb that round-trips one consent and rejects duplicate scope/origin keys:
    ```ts
    expect(Bookmark.safeParse({ ...validBookmark, url: "not a url" }).success).toBe(false);
    expect(Decision.safeParse({ ...validDecision, kind: "move" }).success).toBe(false);
    expect(ConsentRecord.safeParse({ ...validConsent, scope: "bookmark_analysis" }).success).toBe(false);
    ```
  - [x] Step 2: Run `npm run test -- --run tests/unit/schemas.test.ts tests/unit/database.test.ts` and observe missing schemas/database.
  - [x] Step 3: Implement the §7 Bookmark/Tag/Decision fields and the minimal provider/consent records. Centralize Zod configuration:
    ```ts
    import { z } from "zod";
    z.config({ jitless: true });
    export { z };
    ```
    Use Dexie version 1 with `consents: "[scope+origin],acceptedAt"` as a compound primary key, auto-incremented `sentLog` entries, and `keyMaterials` indexed by a stable ID; put only metadata in the bookmark table.
  - [x] Step 4: Run those two tests, `npm run typecheck`, `npm run lint`, and `npm run build`. Inspect the database schema and test that an IndexedDB `CryptoKey` can be structured-cloned in the browser before relying on it in Phase 2.
  - [x] Step 5: Update plan/learnings, review staged files, commit `feat(storage): Add validated data foundations`, add a task git note, and close the mapped Beads task.

- [x] Task: Add store skeleton and CI compliance baseline
  <!-- files: store/permissions.md, store/privacy-policy.md, store/privacy-practices.md, store/listing.md, store/reviewer-notes.md, scripts/check-manifest.mjs, scripts/check-bundle.mjs, .github/workflows/ci.yml, tests/unit/compliance-scripts.test.ts -->
  <!-- depends: task1 -->

  **Files:** Create `store/permissions.md`, `store/privacy-policy.md`, `store/privacy-practices.md`, `store/listing.md`, `store/reviewer-notes.md`, `scripts/check-manifest.mjs`, `scripts/check-bundle.mjs`, `.github/workflows/ci.yml`, `tests/unit/compliance-scripts.test.ts`. Consume Task 1's npm scripts; do not edit `package.json`.

  **Interfaces:** `npm run check:manifest` checks `.output/chrome-mv3/manifest.json` against permission rows in `store/permissions.md`; `npm run check:bundle` scans emitted JS/HTML for `eval(`, `new Function`, and external script tags. CI runs both after build, plus lint, typecheck, tests, and Chromium E2E smoke.

  - [x] Step 1: Write tests that create a fake manifest with an extra required permission, one with a missing optional host, and a matching one. Feed the bundle scanner one `eval(`, one `new Function`, one remote `<script src>`, and a clean bundle; assert the first three fail and the clean bundle passes.
  - [x] Step 2: Run `npm run test -- --run tests/unit/compliance-scripts.test.ts` and observe missing scanner modules.
  - [x] Step 3: Create truthful draft `store/` files for the *current foundation*: `storage`/`sidePanel`, two optional Jev origins, no provider traffic yet, and publication details as release prerequisites. Write permission table rows shaped like `| \`storage\` | required | local settings |` and `| \`https://api.typesafe.ai/*\` | optional | Jev test |`. Parse these rows in `check-manifest.mjs`; compare sorted required permissions, optional hosts, and host permissions from the generated manifest, failing with the differing name. Scan emitted JS/HTML with `check-bundle.mjs`, report the offending file, and reject dynamic evaluation and remote scripts. Add CI `npm ci`, lint, typecheck, tests, build, both checks, and Chrome/Playwright smoke using Task 1's scripts.
  - [x] Step 4: Run compliance fixture tests and `npm run lint && npm run typecheck && npm run test -- --run && npm run build && npm run check:manifest && npm run check:bundle && npm run test:e2e`. Correct any mismatches between WXT's generated manifest and the inventory.
  - [x] Step 5: Update plan/learnings, review staged files, commit `chore(ci): Add store and compliance baseline`, add a task git note, and close the mapped Beads task.

- [x] Task: Conductor - User Manual Verification 'Runnable Extension and Data Baseline' (Protocol in workflow.md)
  <!-- files: conductor/tracks/phase0_foundation_20260925/plan.md, conductor/tracks/phase0_foundation_20260925/learnings.md, conductor/patterns.md -->
  <!-- depends: task2, task3 -->

  **Files:** Update this plan and `learnings.md` after approval. **Evidence:** clean extension load; popup, side panel, and Options render; unit tests, lint, typecheck, build, E2E smoke; generated permissions and CI/compliance scripts.

  - [x] Step 1: Summarize phase results and limitations to the user; request manual verification of the extension shells.
  - [x] Step 2: Record approval/feedback and useful reusable patterns in `conductor/patterns.md`; mark verification complete only after approval, then commit the documentation checkpoint with a task note and close its mapped Beads task. *(User approved Phase 1 on 2026-09-25.)*

## Phase 2: Protected Keys, Consent, and Network Gate
<!-- execution: parallel -->

- [x] Task: Implement service-worker-only encrypted provider keys
  <!-- files: src/security/keys.ts, tests/unit/keys.test.ts -->

  **Files:** Create `src/security/keys.ts`, `tests/unit/keys.test.ts`. Use the Phase 1 `keyMaterials` store and masked suffix schema; if they prove insufficient, stop for a plan revision instead of changing a parallel task's files.

  **Interfaces:** `saveProviderKey(preset: PresetId, plaintext: string): Promise<void>`, `readProviderKey(preset: PresetId): Promise<string | null>`, and `deleteProviderKey(preset: PresetId): Promise<void>` are worker-only. Options receives only `keySuffix` via a worker response.

  - [x] Step 1: Write tests for save/read of each preset, distinct random IVs for repeated saves, absent and corrupted ciphertext, orphaned ciphertext after removal of the IndexedDB `CryptoKey`, deletion, and no plaintext in `chrome.storage.local`:
    ```ts
    await saveProviderKey("typesafe", "secret-example");
    expect(await readProviderKey("typesafe")).toBe("secret-example");
    expect(JSON.stringify(storageWrites)).not.toContain("secret-example");
    ```
  - [x] Step 2: Run `npm run test -- --run tests/unit/keys.test.ts` and observe missing functions.
  - [x] Step 3: Generate a non-extractable AES-GCM 256-bit `CryptoKey` via `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])`, persist it in Dexie, and store ciphertext plus a unique 12-byte IV in `chrome.storage.local`. Scope storage keys by preset, expose only the last four key characters as a display hint, and map missing/unusable material to a reconnect error without echoing contents.
  - [x] Step 4: Run key tests, typecheck, lint, and build. Inspect `chrome.storage.local` in a local test for ciphertext-only values.
  - [x] Step 5: Update plan/learnings, review staged files, commit `feat(security): Protect provider keys locally`, add a task git note, and close the mapped Beads task.

- [x] Task: Define preset destinations and versioned consent records
  <!-- files: src/consent/records.ts, src/net/presets.ts, tests/unit/consent.test.ts, tests/unit/presets.test.ts -->

  **Files:** Create `src/consent/records.ts`, `src/net/presets.ts`, `tests/unit/consent.test.ts`, `tests/unit/presets.test.ts`. Reuse Phase 1's `ConsentRecord` schema and Dexie `consents` table.

  **Interfaces:** `CONSENT_VERSION = 1`; `grantTestConsent(preset: PresetId): Promise<void>`, `revokeTestConsent(preset: PresetId): Promise<void>`, and `hasTestConsent(preset: PresetId): Promise<boolean>`. `PRESETS[preset]` supplies a fixed origin, System One URL, Chrome permission pattern, and allowed model choices.

  - [x] Step 1: Add tests for current and stale consent versions, origin/scope mismatches, grant/revoke round-trips, exactly the TypeSafe/OpenRouter URLs and models listed in §8.1, and rejection of an unknown preset or a non-HTTPS URL.
  - [x] Step 2: Run `npm run test -- --run tests/unit/consent.test.ts tests/unit/presets.test.ts` and observe missing records/presets.
  - [x] Step 3: Implement the fixed registry and Dexie helpers. Construct consent records with `{ scope: "jev_test", origin: PRESETS[preset].origin, consentVersion: CONSENT_VERSION, acceptedAt: new Date().toISOString() }`; compare all three fields during every `hasTestConsent` call. Limit the two preset URLs to `https://api.typesafe.ai/v1/systemone` and `https://openrouter.ai/api/v1/systemone`, with no caller-supplied origin/path.
  - [x] Step 4: Run consent/preset tests, typecheck, lint, and build. Inspect records for no key or bookmark content.
  - [x] Step 5: Have the coordinator serialize plan/learnings updates; review owned files, commit `feat(consent): Define preset grants`, add a task git note, and close the mapped Beads task.

- [ ] Task: Enforce versioned consent and permission in the network gate
  <!-- files: src/net/send.ts, tests/unit/network-gate.test.ts -->
  <!-- depends: task1, task2 -->

  **Files:** Create `src/net/send.ts`, `tests/unit/network-gate.test.ts`. Use the key/consent helpers from Tasks 1 and 2 and Phase 1's sent-log table.

  **Interfaces:** `sendConsentedTest(preset: PresetId, model: string): Promise<Response>` is the only app call to `fetch`; it constructs a fixed synthetic state/question internally. Fixed preset URLs/permission patterns come from `PRESETS`.

  - [ ] Step 1: Write gate tests with mocked `chrome.permissions.contains`, `readProviderKey`, and `fetch`. Assert **no fetch** for missing/stale consent, missing permission, missing key, non-HTTPS URL, unlisted origin, and revoked consent; assert cookies omitted and redirects rejected on success. Assert no caller-supplied state or questions can enter the request because the function takes only a preset and model. Assert sent-log entries contain only time, origin, feature `"jev_test"`, and top-level payload field names:
    ```ts
    await expect(sendConsentedTest("typesafe", "jev-latest")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    ```
  - [ ] Step 2: Run `npm run test -- --run tests/unit/network-gate.test.ts`; observe failures before implementation.
  - [ ] Step 3: Implement the immutable preset registry and `jev_test` consent checks. Derive the URL from `PRESETS`, not caller input. Check `new URL(url).protocol === "https:"`, exact origin, current scoped grant, and `chrome.permissions.contains({ origins: [pattern] })` before reading the key and invoking `fetch(url, { method: "POST", credentials: "omit", redirect: "error", ... })`. Build the body internally with the fixed `test` Noul question and literal synthetic state in the example in Phase 3; only `model` varies. Record only `["model", "state", "questions"]` when an outbound request is attempted; map transport failures to redacted errors. No arbitrary body, headers, endpoint, or redirect override.
  - [ ] Step 4: Run network-gate and consent tests, typecheck, lint, and build. Check `rg 'fetch\\(' src` and document the sole approved app call in `src/net/`.
  - [ ] Step 5: Update plan/learnings, review staged files, commit `feat(net): Gate provider requests on consent`, add a task git note, and close the mapped Beads task.

- [ ] Task: Build the Options consent, permission, and revocation flow
  <!-- files: src/consent/disclosure.ts, src/messages/provider.ts, src/entrypoints/options/ProviderSetup.tsx, src/entrypoints/options/PrivacyDraft.tsx, src/entrypoints/options/main.tsx, src/entrypoints/background.ts, store/privacy-policy.md, tests/components/provider-setup.test.tsx, tests/unit/provider-messages.test.ts -->
  <!-- depends: task3 -->

  **Files:** Create `src/consent/disclosure.ts`, `src/messages/provider.ts`, `src/entrypoints/options/ProviderSetup.tsx`, `src/entrypoints/options/PrivacyDraft.tsx`, `tests/components/provider-setup.test.tsx`, `tests/unit/provider-messages.test.ts`. Modify `src/entrypoints/options/main.tsx`, `src/entrypoints/background.ts`, and `store/privacy-policy.md`. Use the Phase 1 `metadata` table for settings without modifying `src/db/database.ts`.

  **Interfaces:** The Options page sends schema-validated `{ type: "ENABLE_PROVIDER", preset, model, key }` after a direct-click `chrome.permissions.request`; the worker confirms trusted extension Options sender and permission, then saves `ProviderSettings` in Dexie, calls `saveProviderKey` and `grantTestConsent`. `{ type: "REVOKE_PROVIDER", preset, deleteKey }` revokes consent; the permission is removed, and the key is deleted when selected. `PrivacyDraft` displays a bundled copy of `store/privacy-policy.md` without a network request.

  - [ ] Step 1: Add component/worker tests: unchecked box disables Enable; permission denial causes no key/consent write; approval triggers exactly one permission request for the selected preset; an unlisted model, content-script, or malformed message is rejected; selected model and masked suffix persist across Options reload; a failed consent write leaves no enabled provider; revoke removes consent and permission and lets the user keep/delete the encrypted key; the screen names recipient, origin, synthetic fields, authorization header, reason, trigger, and privacy links.
  - [ ] Step 2: Run `npm run test -- --run tests/components/provider-setup.test.tsx tests/unit/provider-messages.test.ts` and observe failures.
  - [ ] Step 3: Render the provider choices and disclosure. Invoke `chrome.permissions.request({ origins: [PRESETS[preset].permissionPattern] })` synchronously in the Enable click handler once the unchecked checkbox becomes checked; only after it resolves true send the enable message to the worker. Define messages as a Zod discriminated union:
    ```ts
    export const ProviderMessage = z.discriminatedUnion("type", [
      z.object({ type: z.literal("ENABLE_PROVIDER"), preset: PresetIdSchema, model: z.string().min(1), key: z.string().min(1) }),
      z.object({ type: z.literal("REVOKE_PROVIDER"), preset: PresetIdSchema, deleteKey: z.boolean() }),
      z.object({ type: z.literal("PROVIDER_STATUS"), preset: PresetIdSchema }),
    ]);
    ```
    Reject worker messages unless `sender.url` equals the built Options page URL from `chrome.runtime.getURL("options.html")`; confirm the actual WXT output path in Phase 1. Re-check permission and preset/model pairing in the worker; save settings in Dexie. If storing consent fails, revoke the partial grant and clear the saved key/settings so no provider is enabled. Show the key suffix only, link provider policies, and render the locally bundled draft with no external fetch. On revoke, first remove consent so any permission-removal failure still blocks traffic.
  - [ ] Step 4: Run component/worker tests, typecheck, lint, build, and browser smoke; check cancel, denied permission, and revoke in Options manually. Do not call the provider from this phase.
  - [ ] Step 5: Update plan/learnings, review staged files, commit `feat(consent): Add provider permission flow`, add a task git note, and close the mapped Beads task.

- [ ] Task: Automated phase verification 'Protected Keys, Consent, and Network Gate' *(manual gate waived — Revision 1)*
  <!-- files: conductor/tracks/phase0_foundation_20260925/plan.md, conductor/tracks/phase0_foundation_20260925/learnings.md, conductor/patterns.md -->
  <!-- depends: task4 -->

  **Files:** Update this plan, `learnings.md`, and reusable `patterns.md`. **Evidence:** key, gate, message, and component tests; permission deny/revoke behavior; zero requests without consent.

  - [ ] Step 1: Run the full local gate (`npm run lint && npm run typecheck && npm run test -- --run && npm run build && npm run check:manifest && npm run check:bundle && npm run test:e2e`); record the evidence and known limitations in `learnings.md`.
  - [ ] Step 2: On green, mark this task done — no user approval required (manual gate waived per Revision 1); commit the documentation checkpoint locally with a git note and close the mapped Beads task.

## Phase 3: Synthetic Jev Test and Compliance Checks
<!-- execution: parallel -->

- [ ] Task: Validate Jev wire data and implement the synthetic connection test
  <!-- files: src/jev/wire.ts, src/jev/connection.ts, src/net/send.ts, tests/unit/jev-wire.test.ts, tests/unit/jev-connection.test.ts, tests/fixtures/jev-responses.ts -->

  **Files:** Create `src/jev/wire.ts`, `src/jev/connection.ts`, `tests/unit/jev-wire.test.ts`, `tests/unit/jev-connection.test.ts`, `tests/fixtures/jev-responses.ts`. Modify `src/net/send.ts` only if tests identify a missing transport boundary.

  **Interfaces:** `testJevConnection(preset: PresetId, model: string): Promise<{ model: string; latencyMs: number; cost?: number }>` validates the fixed synthetic `SystemOneRequest` built by the gate, calls `sendConsentedTest(preset, model)`, parses `SystemOneResponse`, and verifies its `test` answer is type `noul`. The gate retains ownership of keys/auth/transport.

  - [ ] Step 1: Add tests for Noul/Choice/Score request/response shapes, 2–255 Choice options, 2–10 Score levels, missing or mismatched `test` answer, TypeSafe response and OpenRouter extra `id`, `provider`, and `usage.cost`, plus 401/422/429/529 and malformed JSON. Assert synthetic state and question are constant and do not contain bookmark fields.
  - [ ] Step 2: Run `npm run test -- --run tests/unit/jev-wire.test.ts tests/unit/jev-connection.test.ts`; observe missing schemas/client.
  - [ ] Step 3: Implement the §8.2 discriminated wire schemas. Export `makeSyntheticRequest(model: string): SystemOneRequest` from `src/jev/wire.ts`, move the gate's fixed body construction to this factory, and have the gate parse it before sending. Parse responses on return. The factory returns:
    ```ts
    const request = {
      model,
      state: "This is a synthetic connection test with no bookmark content.",
      questions: {
        test: { type: "noul", instructions: "Is this a synthetic connection test?" },
      },
    } as const;
    ```
    Map 401 to key error, 422 to incompatibility, and 429/529 to retry-later guidance without including response bodies or credentials. Measure elapsed time and show the returned versioned model/cost if valid. No bulk jobs, retry loop, or real-key automated test.
  - [ ] Step 4: Run both test files, typecheck, lint, and build. Check TypeSafe and OpenRouter mock fixtures separately.
  - [ ] Step 5: Update plan/learnings, review staged files, commit `feat(jev): Add synthetic connection test`, add a task git note, and close the mapped Beads task.

- [ ] Task: Wire Test connection into Options and cover failure states
  <!-- files: src/messages/provider.ts, src/entrypoints/background.ts, src/entrypoints/options/ProviderSetup.tsx, tests/components/test-connection.test.tsx, tests/unit/connection-message.test.ts -->
  <!-- depends: task1 -->

  **Files:** Modify `src/messages/provider.ts`, `src/entrypoints/background.ts`, `src/entrypoints/options/ProviderSetup.tsx`; create `tests/components/test-connection.test.tsx`, `tests/unit/connection-message.test.ts`.

  **Interfaces:** `{ type: "TEST_PROVIDER", preset }` triggers `testJevConnection` only in the worker. A typed result contains returned `model`, `latencyMs`, and optional `cost`; a failure contains a redacted error code/message. No raw response or key enters the UI.

  - [ ] Step 1: Write worker/UI tests: no test button until enabled; pressing Test sends one message and one synthetic request; the UI shows returned model/latency/optional cost; 401/422/429/529 and invalid payload show safe guidance; failed permission/consent blocks before transport.
  - [ ] Step 2: Run `npm run test -- --run tests/components/test-connection.test.tsx tests/unit/connection-message.test.ts`; observe failures.
  - [ ] Step 3: Extend the Zod message union with `z.object({ type: z.literal("TEST_PROVIDER"), preset: PresetIdSchema })`; route it in the worker only for a trusted Options sender. Render an explicit Test connection button and a non-sensitive success/error state. Ensure returning to Options never auto-tests.
  - [ ] Step 4: Run these tests, relevant gate tests, typecheck, lint, build, and the offline browser smoke. Verify the data-sent log shows only `"model"`, `"state"`, and `"questions"` as field names.
  - [ ] Step 5: Update plan/learnings, review staged files, commit `feat(options): Test configured Jev providers`, add a task git note, and close the mapped Beads task.

- [ ] Task: Harden CI and browser privacy checks
  <!-- files: scripts/check-manifest.mjs, scripts/check-bundle.mjs, .github/workflows/ci.yml, tests/unit/compliance-scripts.test.ts, tests/e2e/shell.spec.ts -->

  **Files:** Modify `scripts/check-manifest.mjs`, `scripts/check-bundle.mjs`, `.github/workflows/ci.yml`, `tests/unit/compliance-scripts.test.ts`, and `tests/e2e/shell.spec.ts`. Do not edit `store/` docs or package scripts while the provider flow is built in parallel.

  **Interfaces:** `npm run check:manifest` parses a permissions table in `store/permissions.md` and compares sets with `.output/chrome-mv3/manifest.json`; `npm run check:bundle` scans emitted JS/HTML for `eval(`, `new Function`, and remote `<script src>`. CI runs both after `npm run build`.

  - [ ] Step 1: Extend compliance fixture tests with a missing TypeSafe permission row, an unexpected required permission, an unlisted external script, and fresh-install browser network observation; expect the first three to fail their checks and zero requests in the last.
  - [ ] Step 2: Run `npm run test -- --run tests/unit/compliance-scripts.test.ts` and `npm run test:e2e` to observe the new cases fail before finalizing docs/checks.
  - [ ] Step 3: Strengthen the existing manifest/bundle scanners to reject every new negative fixture and make the E2E smoke assert no outbound traffic on a fresh install. Ensure CI runs npm clean install, lint, typecheck, Vitest, Chrome/Playwright smoke, build, manifest check, and bundle check. Keep the docs and permission table owned by the next task.
  - [ ] Step 4: Run `npm run lint && npm run typecheck && npm run test -- --run && npm run build && npm run check:manifest && npm run check:bundle && npm run test:e2e`; resolve failures and verify no fresh-install traffic.
  - [ ] Step 5: Update plan/learnings through the coordinator, review staged files, commit `chore(ci): Guard extension bundle and traffic`, add a task git note, and close the mapped Beads task.

- [ ] Task: Align store disclosures with the completed test flow
  <!-- files: store/permissions.md, store/privacy-policy.md, store/privacy-practices.md, store/listing.md, store/reviewer-notes.md -->
  <!-- depends: task2, task3 -->

  **Files:** Modify only the five `store/` draft documents. The Phase 1 manifest check already parses the permissions table and the Phase 3 CI task has hardened the script.

  **Interfaces:** The permission table names exactly `storage`, `sidePanel`, and the two narrow optional preset patterns. The policy/practices/listing/reviewer notes describe the implemented synthetic `jev_test` flow rather than future bookmark analysis.

  - [ ] Step 1: Run `npm run check:manifest` as the baseline. Compare the existing privacy-practices and privacy-policy claims to `CONSENT_VERSION`, the Options disclosure, and the actual `["model", "state", "questions"]` payload fields.
  - [ ] Step 2: Observe the existing draft documents still describe the pre-connection foundation by reading all five and record missing statements about chosen recipient, bearer key, synthetic fields, explicit test trigger, revocation, local key storage, and release prerequisites.
  - [ ] Step 3: Update drafts with the exact current data flow and deny claims of a finished bookmark manager or published privacy URL. Keep the Limited Use statement in the privacy policy, specify that publisher identity/contact/public website are release prerequisites, and explain that no user bookmark is sent in this track.
  - [ ] Step 4: Run `npm run test -- --run && npm run build && npm run check:manifest && npm run check:bundle`; inspect the generated permission inventory and spot-check the Options copy against the draft privacy policy.
  - [ ] Step 5: Update plan/learnings through the coordinator, review staged docs, commit `docs(store): Align provider test disclosures`, add a task git note, and close the mapped Beads task.

- [ ] Task: Automated phase verification 'Synthetic Jev Test and Compliance Checks' *(manual gate waived — Revision 1)*
  <!-- files: conductor/tracks/phase0_foundation_20260925/plan.md, conductor/tracks/phase0_foundation_20260925/learnings.md, conductor/patterns.md -->
  <!-- depends: task4 -->

  **Files:** Update this plan, `learnings.md`, and reusable `patterns.md`. **Evidence:** full local/CI-equivalent checks; fresh-install no-traffic smoke; a mock TypeSafe/OpenRouter test; current-slice store inventory.

  - [ ] Step 1: Run the full local gate (`npm run lint && npm run typecheck && npm run test -- --run && npm run build && npm run check:manifest && npm run check:bundle && npm run test:e2e`); record evidence and known limitations in `learnings.md`. A real API key is optional and must not be requested for automated tests.
  - [ ] Step 2: On green, mark this task done — no user approval required (manual gate waived per Revision 1); checkpoint documentation locally with a git note and close the mapped Beads task. Leave any unfinished implementation tasks open until actually completed.

## Dependency and Execution Analysis

- Phases are sequential: Phase 1 establishes entrypoints, scripts, schemas, and Dexie; Phase 2 depends on them for consent and key storage; Phase 3 depends on the gate and Options workflow for the Jev test and truthful store documents. Unannotated phase order yields Phase 2 depending on Phase 1 and Phase 3 depending on Phase 2.
- Within Phase 1, Tasks 2 (schemas/DB) and 3 (store/CI) can run together after Task 1 (scaffold); Task 4 waits for both. Within Phase 2, Tasks 1 (keys) and 2 (preset/consent records) can run together; Task 3 (gate) waits for both, Task 4 (UI) for the gate, and Task 5 for the UI. Within Phase 3, Tasks 1 (wire/client) and 3 (CI/browser checks) can run together; Task 2 (Options) waits for the wire/client, Task 4 (docs) waits for the Options and checks, and Task 5 waits for the docs. All tasks have exclusive implementation file ownership within their phase; coordinator-owned plan/learnings updates are serialized.
- ~~Each manual-verification task blocks the next phase until the user approves the phase.~~ *(Revised 2026-09-25)* Phase-end checkpoints are automated evidence tasks and do not block the next phase. After this track, future tracks can implement bookmark management and the rest of Jev Phase 3 without reusing `jev_test` consent for new data.
