# TypeScript and React Style Guide

This guide applies to the planned WXT/Manifest V3 extension. Follow established codebase conventions once implementation exists; avoid introducing rules that conflict with working patterns.

## TypeScript and Schemas

- Keep TypeScript strict and define explicit boundaries for messages, storage, and provider payloads.
- Parse untrusted inputs and persisted records with Zod before use. Use inferred types from schemas instead of maintaining parallel interfaces.
- Configure Zod v4 in jitless mode for the MV3 content security policy.
- Represent AI outcomes as a closed set of validated decision types, never as commands to execute.

## Components and Boundaries

- Keep popup, side panel, and options UI focused on presentation and user actions. Put bookmark synchronization, provider credentials, and provider requests in the service worker.
- Keep Chrome bookmarks as the tree's source of truth; store additional metadata and resumable jobs in their designated local stores.
- Use accessible controls, clear labels, keyboard navigation, and visible status for asynchronous or risky actions.
- Prefer small modules with one responsibility and typed messages between extension contexts.

## Network and Privacy

- Route outbound requests through `src/net/`; do not call `fetch` elsewhere. Enforce HTTPS except permitted loopback, destination allowlists, consent checks, and `credentials: "omit"`.
- Never send notes, API keys in exports or logs, or bookmark/page fields beyond what the user consented to send.
- Keep permissions, data disclosures, consent versions, and `store/` documentation aligned with any data-flow change.
- Require explicit review for moves, merges, and restructuring; provide undo and audit records where the plan calls for them.

## Tests

- Write valid and invalid schema fixtures, mock provider interactions, and tests for consent gates and confidence boundaries.
- Cover user-facing workflows with component and extension end-to-end tests where practical.
- Run lint, type checks, tests, and a build for changed code before marking a task complete.

See `PROJECT_PLAN.md` for feature-specific requirements and `conductor/workflow.md` for task and commit procedure.
