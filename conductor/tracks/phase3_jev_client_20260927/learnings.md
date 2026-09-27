# Track Learnings: phase3_jev_client_20260927

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

Full list in `conductor/patterns.md`. The phase0 connection-slice learnings are already elevated there;
the ones most relevant to this track:

- `fetch` is ESLint-banned in `src/**` except `src/net/**` (tests are outside the ban, so a Node mock server may use `fetch`).
- Fail-closed gates re-verify per call; prove short-circuiting with dependency-spy call counts (key store untouched on earlier refusals).
- Never read a response body on non-2xx. Omit `cause` when it can hold response content (SyntaxError snippets, ZodError `input`).
- Message handlers are total `{ok:true,…} | {ok:false,code,message}` Zod unions; two `ok: true` shapes need `z.union`, not `discriminatedUnion`.
- All Zod through `src/schemas/z.ts` (jitless); Zod 4 refines still run after a failed base check — guard throwing ops.
- `vi.mock(path, async (importOriginal) => ({ ...actual, dep: vi.fn() }))` keeps real error classes for `instanceof` assertions.
- `chrome.permissions.request` needs a synchronous user gesture; trusted-page check uses `sender.url`.
- RTL here: `globals: false` → set `IS_REACT_ACT_ENVIRONMENT`, call `cleanup()` manually; no jest-dom.
- Playwright: `channel: "chromium"`; extension pages drive `chrome.*` via `page.evaluate`; egress assertions filter out internal schemes and assert after `context.close()`.
- Store disclosures must match `consent/disclosure.ts` constants nearly verbatim; data-flow changes need `CONSENT_VERSION` + `store/` updates in the same change (not expected in this track).

---

<!-- Learnings from implementation will be appended below -->

## [2026-09-27 03:22] - Phase 1 Task 2: Noul margin and answer confidence
- **Implemented:** `src/jev/confidence.ts` — `noulMargin(p, t=0.5)` per §10.1 `(p−t)/(1−t)` / `(t−p)/t` with RangeError bounds (0≤p≤1, 0<t<1, NaN rejected); `answerConfidence` uses `answer.confidence` for choice/score.
- **Files changed:** `src/jev/confidence.ts`, `tests/unit/jev-confidence.test.ts` (18 tests)
- **Commit:** `4216692` (landed from worktree `wt/p3-p1t2`, worker commit `677a7fa`)
- **Learnings:**
  - Patterns: pure `src/jev/` modules take `import type { Answer } from "./wire"` only — no chrome/DOM/fetch.
  - Context: `answerConfidence` deliberately does NOT validate `threshold` for choice/score answers — the field is returned verbatim per spec; noul invalid-t propagates RangeError.
---
