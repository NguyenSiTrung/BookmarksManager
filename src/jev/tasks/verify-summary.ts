import { choice, defineDecision } from "../define";
import type { QuestionSet } from "./index";
import type { JevClient } from "../client";
import type {
  SummaryVerificationState,
  SummaryVerdict,
} from "../../schemas/summary-verification";

/**
 * The `verify-summary` question set (spec FR10.5): Jev is asked whether the
 * LLM-written `summary` in the state is supported by the extracted page
 * text (`excerpt` + `headings`) of `bookmark`. The choice answer maps to a
 * persisted-or-shown outcome upstream:
 *
 * - `supported` → the summary may be persisted to `bookmarkMeta.summary`;
 * - `unsupported`/`uncertain` → shown to the user as unverified, never
 *   written (spec FR10.6–7).
 *
 * This runs under the `jev_summary_verify` consent scope — page text never
 * travels under `jev_decisions`.
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "verify-summary-v1";

/** Field name for the verdict — the question's output key. */
export const VERDICT_FIELD = "verdict";

const verdictOptions = {
  supported:
    "Every factual claim in the summary is directly backed by the page text.",
  unsupported:
    "The summary contains claims contradicted by or absent from the page text.",
  uncertain:
    "The page text is insufficient to confirm or deny the summary.",
} as const;

type VerifyFields = {
  verdict: ReturnType<typeof choice<typeof verdictOptions>>;
};

/**
 * Pair the three-way verdict choice with `state`. Option texts tell Jev
 * exactly what each verdict means so "supported" is a positive claim, not
 * a default.
 */
export function verifySummary(
  state: SummaryVerificationState,
): QuestionSet<VerifyFields> {
  const decision = defineDecision({
    goal: "Verify that a generated summary of a saved bookmark's page is faithful to the extracted page text.",
    fields: {
      verdict: choice(
        "Is `summary` supported by the extracted page text in `excerpt` and `headings` for `bookmark`?",
        verdictOptions,
      ),
    },
  });
  return { questionSetVersion, decision, state };
}

export interface SummaryVerificationResult {
  /** Jev's answer to the verify question. */
  verdict: SummaryVerdict;
  /** API-reported confidence in the chosen option. */
  confidence: number;
}

/**
 * Ask Jev whether `state.summary` is supported by the page text in
 * `state`. `client` must be created under the `jev_summary_verify` scope —
 * the send gate refuses otherwise. Throws whatever the client throws;
 * callers map failures to "show unverified, persist nothing".
 */
export async function verifySummaryRun(
  client: JevClient,
  state: SummaryVerificationState,
): Promise<SummaryVerificationResult> {
  const { decision } = verifySummary(state);
  const result = await decision.run(client, state);
  return {
    verdict: result.values[VERDICT_FIELD] as SummaryVerdict,
    confidence: result.confidence[VERDICT_FIELD] ?? 0,
  };
}
