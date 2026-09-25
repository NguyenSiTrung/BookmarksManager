# Bookmarks Manager

## Vision

Make saving, finding, and organizing Chrome bookmarks faster and clearer than the built-in manager, without requiring an account, API key, or network connection for core features.

## Users

- Researchers with large bookmark libraries who need fast retrieval.
- Developers who want tagged, searchable references and control over AI providers.
- Privacy- and cost-conscious users who want useful offline features and explicit control over any data sent.

## Core Experience

The Manifest V3 extension provides a quick-save popup and a side-panel manager for native Chrome bookmarks. Users organize bookmarks with folders, tags, and categories; search titles, URLs, domains, tags, and notes; import and export their data; and detect duplicates locally. Native Chrome bookmarks remain the source of truth for the bookmark tree.

## Optional AI

Jev proposes classifications, tags, and folder placement with confidence scores. An optional OpenAI-compatible provider supplies explanations and generative work that Jev cannot do. Suggestions pass a confidence policy, and risky changes require explicit user approval. Nothing is sent to a provider without recipient-specific in-product consent.

## Release Scope

- **1.0:** Complete offline core and optional AI through narrow-permission provider presets, with Chrome Web Store disclosures and review readiness.
- **1.1:** Custom provider base URLs and the opt-in link checker, with their additional permissions and disclosures.
- **v2:** Scheduled maintenance, smart collections, threshold tuning, and other advanced workflows.

## Boundaries

No developer backend, analytics, remote code, or data leaving the device by default. Use the least permissions needed for shipped features. Keep data flows, privacy disclosures, and store materials consistent with actual behavior.

`PROJECT_PLAN.md` contains the detailed feature inventory, architecture, milestones, and store policy checklist. This guide summarizes the approved direction without replacing that plan.
