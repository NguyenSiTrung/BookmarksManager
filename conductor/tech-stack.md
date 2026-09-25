# Technology Stack

The application stack below is **planned in `PROJECT_PLAN.md`**, not an inventory of installed dependencies. There is no extension source or package manifest yet.

## Platform

- Chrome extension on Manifest V3, built with WXT and Vite.
- Strict TypeScript throughout the extension.
- Native `chrome.bookmarks` as the bookmark tree's source of truth.

## Interface and State

- React, Tailwind CSS, and shadcn/ui for the popup, side panel, and options page.
- Zustand for local interface state and TanStack Query for asynchronous cache state.

## Data and Search

- Zod v4 for runtime schemas, configured in jitless mode for the MV3 content security policy.
- Dexie on IndexedDB for metadata, decisions, audit records, and resumable jobs.
- `chrome.storage.local` for settings and protected provider keys; not Chrome sync storage for secrets.
- MiniSearch for local fuzzy search.
- `@mozilla/readability` for opt-in extraction of a short page excerpt.

## AI and Networking

- A thin, direct TypeScript client for Jev's `/v1/systemone` wire format, supporting the planned TypeSafe and OpenRouter presets.
- An optional OpenAI-compatible LLM client for generation, explanations, and low-confidence second opinions.
- A single network module enforcing transport rules, recipient-specific consent, and a local record of outbound data.
- Pydantic AI informs the typed question-builder design but is not a runtime dependency.

## Quality and Delivery

- Vitest, Testing Library, Playwright, mock provider servers, and labeled decision fixtures.
- GitHub Actions for lint, type checking, tests, extension build, and store-compliance checks.
- No project-owned backend, analytics, or remote code.

See `PROJECT_PLAN.md` for the detailed architecture and staged permission inventory. Verify versions and browser compatibility when dependencies are first installed.
