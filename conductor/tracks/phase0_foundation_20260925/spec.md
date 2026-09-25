# Phase 0 Foundation and Provider Connection

## Overview

Establish the first runnable Manifest V3 extension and its quality and privacy
foundations. This track includes all of Phase 0 in `PROJECT_PLAN.md` §15, plus
the early network gate from §18 and a **focused TypeSafe/OpenRouter connection
slice**. The latter extends beyond the original four-day Phase 0 estimate.
There is no bookmark-management or AI decision feature in this track.

The result is an extension with placeholder popup and side-panel shells and a
working Options-page flow to configure either Jev preset, consent to its data
flow, grant its narrow host permission, and test the connection with synthetic
data. Provider setup does not send a real bookmark.

## Functional Requirements

### 1. Extension and development baseline

- Scaffold WXT with React, Tailwind, strict TypeScript, and separately bundled
  popup, side-panel, Options page, and service worker. The Options page hosts
  the provider flow; the other surfaces need only accessible placeholders.
- Set up linting, formatting, Vitest, Testing Library, and Playwright with an
  unpacked-extension smoke-test path. Forbid direct `fetch` outside `src/net/`;
  all application requests must pass through the gate.
- Add CI for lint, type checking, unit/component tests, extension end-to-end
  smoke tests where the runner supports Chrome, build, a generated-manifest
  permissions check against `store/permissions.md`, and a built-bundle scan
  rejecting `eval(`, `new Function`, and remote scripts.
- Begin with only permissions required by this *implemented* slice
  (`storage` and `sidePanel`, plus any other permission justified by actual
  functionality). Declare optional, narrow origins for
  `https://api.typesafe.ai/*` and `https://openrouter.ai/*`. Add other core
  permissions only when the corresponding later feature ships, even though
  §13.3 lists the intended permissions for the completed 1.0 release. Do not
  declare broad patterns, local HTTP hosts, or future-release permissions now.

### 2. Data foundations

- Define and test the base Bookmark, Tag, and discriminated Decision Zod v4
  schemas from `PROJECT_PLAN.md` §7, with valid and invalid fixtures. Define
  only the settings/consent schemas needed for this slice. Configure Zod in
  jitless mode for MV3 CSP compatibility.
- Create a versioned Dexie/IndexedDB baseline for extension metadata and
  consent/audit records; keep native Chrome bookmarks as the planned source of
  truth for the tree. Do not build bookmark sync, search, or a job processor.
- Store API-key ciphertext in `chrome.storage.local`, encrypted with WebCrypto
  AES-GCM using a non-extractable key in IndexedDB. Only the service worker
  decrypts keys; keys do not enter content scripts, error messages, logs, or
  exports. Handle missing or unusable stored key material with a clear
  reconnect path. A passphrase mode is not part of this track.

### 3. Consent and network boundary

- Implement a single service-worker network gate with HTTPS-only preset
  destinations, an origin allowlist, `credentials: "omit"`, a current,
  scope-and-origin-specific versioned consent record, and a check that the
  matching optional Chrome host permission still exists. Reject requests
  before `fetch` if any requirement is unmet.
- The Options page must name the provider, literal origin, exact synthetic
  test-request fields, purpose, trigger, and provider privacy-policy link
  before consent. Make the extension's draft privacy policy available locally
  from Options until a public policy URL exists. The agreement checkbox starts
  unchecked. Only the user's Enable action can request the origin-specific
  Chrome permission. Cancellation or denial leaves the provider disabled and
  makes no request.
- Persist consent and the encrypted key only after permission is granted and
  the user has affirmatively agreed. Provide revocation that removes the
  consent and host permission and offers to delete the key. The gate must also
  reject requests after revocation or a permission removed outside the app.
- Record the time, destination, feature, and field names of each actual
  outbound request locally. Never store request contents, authentication
  headers, keys, or full bookmark data in the sent log. A fresh install sends
  no network requests; neither opening Options nor storing a key initiates a
  test request.

### 4. Narrow Jev preset setup and test

- Support the two fixed Jev destinations from `PROJECT_PLAN.md` §8.1:
  TypeSafe at `https://api.typesafe.ai/v1/systemone` and OpenRouter at
  `https://openrouter.ai/api/v1/systemone`. Keep preset endpoints fixed;
  custom base URLs and OpenRouter's alpha Decisions API are out of scope.
- Offer provider/key/model configuration with the limited model choices
  described for these presets. Mask a stored key in the UI. The only live
  action is an explicit **Test connection** button that sends one small,
  schema-validated Noul request using synthetic state, through the gate.
- Validate both request and response, including the matching answer key and
  type. Show returned model, latency, and usage cost when present; report
  actionable, non-sensitive messages for authentication errors, incompatible
  payloads, and rate limiting/overload. Never send a bookmark or page excerpt
  from the test flow.
- Keep the wire/client and provider settings modular enough for the later
  Phase 3 track to add analysis, retries, budgets, and other Jev tasks without
  bypassing this gate. Do not implement those later behaviors in this track.

### 5. Store documents

- Create `store/` skeleton documents for permission justifications, privacy
  policy, privacy practices, listing, and reviewer notes. Describe *shipped*
  behavior and recipients accurately, distinguishing this foundation from the
  planned full extension. Mark any publisher identity, contact, and public
  policy URL as release prerequisites rather than inventing them.
- Keep the in-product disclosure, permission inventory, and draft privacy
  documents consistent with the code and the versioned consent scope.

## Non-Functional Requirements

- The extension works without a provider key; the provider flow is optional.
  A fresh install has no outbound traffic.
- No developer backend, analytics, remote scripts, or remote configuration.
  Never expose API keys to the UI after entry, except a masked indication.
- Use accessible controls, clear failure/retry states, and plain language.
- Follow `conductor/workflow.md`: test-first for behaviors, verify scaffolding
  and documents, and use local per-task commits with notes during implementation.

## Acceptance Criteria

1. A clean install builds and loads in Chrome; the popup, side panel, and
   Options page render. The extension makes zero outbound requests before a
   user explicitly tests a configured provider.
2. Strict type checking, lint, relevant unit/component/E2E tests, manifest
   permission snapshot, bundle scan, and build run through documented scripts
   and CI. No broad or unused permissions appear in the generated manifest.
3. Bookmark, Tag, Decision, settings, and consent schemas have valid/invalid
   fixture coverage and run under MV3-compatible jitless Zod.
4. TypeSafe and OpenRouter setup can be exercised against mock endpoints in
   tests. The production Test connection flow uses only its chosen fixed
   endpoint, requires consent and granted permission, validates the response,
   and never transmits actual bookmark content.
5. Denied consent, denied/revoked Chrome permission, unsupported destination,
   non-HTTPS URL, malformed answer, and 401/422/429/529 responses are covered
   by tests and fail safely without disclosing keys.
6. The sent log contains metadata only; key storage uses the documented
   encryption split, and revocation stops future requests.
7. Draft store documents and the Options disclosure accurately match the
   manifest and current data flow; missing publication details are explicitly
   identified as release prerequisites.

## Out of Scope

- Bookmark sync, save, categories/tags UI, search, imports/exports, duplicate
  detection, link checking, and all Jev decisions or review/undo workflows.
- Custom provider origins, LLM providers, OpenRouter alpha, local HTTP
  providers, page-text extraction, background AI jobs, live tests using real
  credentials, and Chrome Web Store publication.
- Full Phase 3 Jev orchestration, including retry/backoff, token budgets,
  candidate filtering, typed question sets, and cost accounting across jobs.
