# Track Revisions: ui_ux_redesign_20261014

## Revision 1 — 2026-10-14 (Both Spec & Plan)

- **Triggered by:** Inspection of existing popup regression suites (`tests/components/popup-search.test.tsx`, `tests/components/popup-suggestions.test.tsx`, `tests/e2e/decisions.spec.ts`) and store-disclosed privacy constants (`DECISIONS_TRIGGERS` in `src/consent/disclosure.ts`).
- **Phase / Task:** Phase 4, Task 3 (`UX-02`, `UX-12`).
- **Changes made & rationale:**
  1. **Preserve disclosed `SAVE_SUGGEST` trigger (`DECISIONS_TRIGGERS`):** Store/site privacy disclosures and E2E tests (`decisions.spec.ts` / `popup-suggestions.test.tsx`) mandate that opening the popup never dispatches `SAVE_SUGGEST` automatically, even when `jev_decisions` consent is granted; requests start only when the user focuses `Tags` or clicks `Suggest`. Revised `UX-12` so `popup/App.tsx` preserves this trigger while surfacing a clear consent-ready state.
  2. **Preserve lazy `db.tags` read (`P-10`):** `tests/components/popup-search.test.tsx` (`P-10`) asserts that `db.tags.toArray` is not called during initial popup prefill. Revised `UX-02` / `UX-12` so `listTags()` loads lazily when the user focuses `TagField` (`suggestionRequested`) or opens popup search (`searchOpen`), feeding `availableTags={tagDefs}` into `TagField`.
  3. **Preserve mounted `<form>` while `searchQuery === ""`:** `tests/components/popup-search.test.tsx` asserts that `<form>` (`Title` input) remains mounted while `searchOpen === true` and `searchQuery === ""` and swaps out once `searchQuery !== ""`. Revised `UX-12` so `PopupSearch` renders an inline filter-syntax helper bar (`tag:`, `folder:`, `in:`, `has:`) when `query === ""` while keeping `<form>` mounted until `searchQuery !== ""`.
