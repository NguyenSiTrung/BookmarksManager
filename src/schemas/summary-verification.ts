import { z } from "./z";
import { SentBookmark } from "./decision-state";

/**
 * The strict state schema for the `jev_summary_verify` consent scope
 * (spec FR10.5): a saved bookmark's cleaned URL + title, the bounded page
 * excerpt/headings extracted under `llm_summary` consent, and the
 * LLM-written summary under review. Jev answers whether the summary is
 * supported by the page.
 *
 * Deliberately NOT a `DecisionState`: that schema is metadata-only and
 * must never carry page text. This one exists so the verify request's
 * page content is scoped, capped, and audited as its own feature.
 */

/** Deterministic wire caps — the same numbers `PageExtract` enforces. */
export const SUMMARY_VERIFY_LIMITS = {
  title: 500,
  excerpt: 20_000,
  headings: 50,
  heading: 200,
  summary: 2_000,
} as const;

export const SummaryVerificationState = z.strictObject({
  bookmark: SentBookmark,
  /** Bounded extracted page text (Readability excerpt, capped upstream). */
  excerpt: z.string().min(1).max(SUMMARY_VERIFY_LIMITS.excerpt),
  /** Extracted heading outline; capped upstream. */
  headings: z.array(
    z.string().min(1).max(SUMMARY_VERIFY_LIMITS.heading),
  ).max(SUMMARY_VERIFY_LIMITS.headings),
  /** The LLM-written summary under verification (spec FR10.4 cap). */
  summary: z.string().min(1).max(SUMMARY_VERIFY_LIMITS.summary),
});
export type SummaryVerificationState = z.infer<
  typeof SummaryVerificationState
>;

/** Jev's verdict on whether `state.summary` is supported by the page. */
export const SummaryVerdict = z.enum([
  "supported",
  "unsupported",
  "uncertain",
]);
export type SummaryVerdict = z.infer<typeof SummaryVerdict>;
