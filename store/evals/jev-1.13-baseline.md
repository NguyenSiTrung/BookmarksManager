# Jev 1.13 Evaluation Baseline — Release Policy Evidence

Phase 6 (store-readiness) records the evidence behind the release-pinned
Jev models and confidence thresholds here. This document is the auditable
link between the eval harness output (`test-results/eval/*.json|.md`) and
the values compiled into `src/decisions/release-policy.ts`.

## Pinned models

| Preset     | Request id          | Accepted response ids |
| ---------- | ------------------- | --------------------- |
| TypeSafe   | `jev-1.13.0`        | `jev-1.13.0`          |
| OpenRouter | `typesafe/jev-1.13` | `typesafe/jev-1.13`   |

Owned by `RELEASE_JEV_MODELS` in `src/decisions/release-policy.ts` and
consumed by the picker default (`DEFAULT_PROVIDER_MODEL` in
`src/schemas/provider.ts`) and by the eval harness
(`tests/eval/provider.ts`). Moving aliases (`jev-latest`, `jev-preview`,
`jev-1.13`) are never accepted: a response `model` outside the accepted
list is recorded as an `unexpected_model` error, never silently scored.

## Corpus

- Fixture: `tests/eval/fixtures/corpus.json` — 315 bookmarks / 294 labeled
  cases across all six question sets (categorize, tags, placement,
  misfiled, near-duplicate, rerank), generated deterministically by
  `scripts/generate-eval-corpus.mjs`.
- Question-set versions are pinned in the corpus (`questionSetVersions`)
  and the report embeds them for provenance.
- ~15 fixtures are excluded by design (sensitive or unparseable); their
  cases produce `skipped` observations — coverage is reported separately
  from accuracy so the never-send path stays visible.

## Thresholds under evaluation

`RELEASE_THRESHOLDS` (same module) holds the bars the eval scores
against:

| Bar                | Value | Used by                                             |
| ------------------ | ----- | --------------------------------------------------- |
| `reviewFloor`      | 0.50  | `unsure` cutoff for every decision kind             |
| `movePreselect`    | 0.70  | `move` on-save folder pre-select band               |
| `autoApply`        | 0.85  | `add_tags`/`set_category` auto-apply (toggle-gated) |
| `rerankNoMatchBar` | 0.50  | "no match" verdict for search re-rank               |
| `tagSelect`        | 0.50  | per-tag noul selection cutoff                       |

## How to reproduce

```bash
export TYPESAFE_API_KEY=…   # and/or OPENROUTER_API_KEY=…
npm run test:eval           # writes test-results/eval/jev-eval-<preset>.{json,md}
# optional: JEV_EVAL_LIMIT=50 npm run test:eval   # dev cap on cases
```

Without a key the suite skips the provider cleanly; plumbing tests still
run unconditionally.

## Results

**Status: baseline pending first keyed run.** The harness, corpus, scoring
(§10.2 replay incl. auto-apply bands scored as-if-toggles-on), and report
format landed in Phase 1 Tasks 1–3; this document will be updated with the
measured per-kind accuracy, tag/rerank micro P/R/F1, near-duplicate
within-one accuracy and MAE, misfiled detection precision/recall, and the
unanswered/skipped counts once the keys are available to CI or a
maintainer run.

## Threshold decisions

Per the plan's rule — *when evidence is insufficient, retain the safer
current value and record uncertainty* — all five bars retain the §10.2
defaults. Recorded uncertainties to re-examine after the first keyed run:

- `autoApply` 0.85: keep unless measured exact-match accuracy on
  categorize/tags at ≥0.85 falls below 0.95; auto-apply additionally
  requires its per-kind toggle, which defaults off, so the risk of a
  slightly permissive bar is bounded.
- `movePreselect` 0.70: keep unless placement accuracy at ≥0.70 falls
  below 0.9; the band only pre-fills a suggestion the user confirms.
- `reviewFloor` 0.50 / `rerankNoMatchBar` 0.50 / `tagSelect` 0.50: floors —
  review cost rises if raised; revisit only if review-queue precision is
  poor.
