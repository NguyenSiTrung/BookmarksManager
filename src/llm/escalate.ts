import { z } from "../schemas/z";
import { db } from "../db/database";
import { REVIEW_FLOOR } from "../decisions/policy";
import type { Decision } from "../schemas/decision";
import type { SentBookmark } from "../schemas/decision-state";
import { createLlmClient } from "./client";
import { runStructured } from "./structured";
import { resolveLlmDestination } from "./providers";
import { readLlmProvider } from "./settings";
import type { ChatMessage } from "./wire";

/**
 * Automatic low-confidence escalation (spec FR6). When — and only when — the
 * user has configured a priced LLM provider, granted `llm_escalate` consent,
 * switched the feature on, and set a monthly cap, a Jev decision below
 * `REVIEW_FLOOR` may get a second opinion during the user-started operation
 * that produced it.
 *
 * Every refusal is silent: the function returns `null` and the decision
 * falls back to the ordinary review queue. Escalation NEVER changes the
 * decision's status and never applies anything — the verdict, model,
 * optional allowed alternative, and rationale are advisory fields the
 * caller persists on the row.
 */

/** One allowed option: `id` is what the model must echo back; `label` is shown. */
export interface EscalationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** The minimized inputs a second opinion may see — nothing else leaves. */
export interface EscalationContext {
  readonly bookmarks: readonly SentBookmark[];
  readonly question: string;
  readonly options: readonly EscalationOption[];
  readonly probabilities: Record<string, number>;
  readonly jevAnswer: string;
  readonly signal?: AbortSignal;
}

/** The validated second opinion, or nothing when escalation did not run. */
export interface LlmEscalation {
  readonly verdict: "agree" | "disagree" | "unsure";
  /** A `context.options` id — present only on `disagree`. */
  readonly alternative?: string;
  readonly rationale: string;
  /** Model identifier the provider reported. */
  readonly model: string;
  /** The budget reservation this call settled — the usage trail's anchor. */
  readonly usageRef?: string;
}

// ---------------------------------------------------------------------------
// Escalation settings (metadata key `llmEscalation`)
// ---------------------------------------------------------------------------

const ESCALATION_KEY = "llmEscalation";

export const LlmEscalationSettings = z
  .strictObject({
    enabled: z.boolean(),
    /** Required when `enabled` — the configured provider that answers. */
    providerId: z.string().min(1).optional(),
  })
  .refine((s) => !s.enabled || s.providerId !== undefined, {
    message: "providerId is required when escalation is enabled.",
  });
export type LlmEscalationSettings = z.infer<typeof LlmEscalationSettings>;

/** The stored escalation config; `{enabled:false}` when absent or malformed. */
export async function readLlmEscalationSettings(): Promise<LlmEscalationSettings> {
  const row = await db.metadata.get(ESCALATION_KEY);
  const parsed = LlmEscalationSettings.safeParse(row?.value);
  return parsed.success ? parsed.data : { enabled: false };
}

/** Persist the escalation config; `providerId` is required when enabling. */
export async function writeLlmEscalationSettings(
  settings: LlmEscalationSettings,
): Promise<void> {
  const parsed = LlmEscalationSettings.parse(settings);
  await db.metadata.put({ key: ESCALATION_KEY, value: parsed });
}

// ---------------------------------------------------------------------------
// The second-opinion call
// ---------------------------------------------------------------------------

const EscalationResponse = z.strictObject({
  verdict: z.enum(["agree", "disagree", "unsure"]),
  /** Must echo one of the offered option ids; required on `disagree`. */
  alternative: z.string().min(1).max(64).optional(),
  rationale: z.string().min(1).max(1_000),
});

const MAX_INPUT_TOKENS = 8_192;
const MAX_OUTPUT_TOKENS = 1_024;

const ESCALATE_SYSTEM_PROMPT =
  "You are a second opinion for an automated bookmark organizer. Its " +
  "first-pass engine answered a question about the shown bookmark data; " +
  "judge whether that answer is right. Reply only with the JSON object the " +
  "schema requests: verdict is 'agree', 'unsure', or 'disagree' — and on " +
  "'disagree' you must also echo back the `id` of one of the offered " +
  "options as `alternative`. Never invent an option or an action that is " +
  "not listed.";

/**
 * Maybe get a second opinion on `decision`. Returns `null` for every
 * ineligible or failed path — not-yet-enabled settings, confidence at or
 * above the review floor, a missing/unpriced/uncapped provider, a refused
 * gate check, an invalid response, or an alternative that is not an offered
 * option id. This function never throws.
 */
export async function maybeEscalateDecision(
  decision: Decision,
  context: EscalationContext,
): Promise<LlmEscalation | null> {
  try {
    if (decision.confidence >= REVIEW_FLOOR) return null;
    const settings = await readLlmEscalationSettings();
    if (!settings.enabled || settings.providerId === undefined) return null;
    const record = await readLlmProvider(settings.providerId);
    if (record === null || record.monthlyBudgetUsd === undefined) return null;

    const payload = {
      question: context.question,
      options: context.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description !== undefined
          ? { description: option.description }
          : {}),
      })),
      probabilities: context.probabilities,
      jevAnswer: context.jevAnswer,
      bookmarks: context.bookmarks,
    };
    const messages: ChatMessage[] = [
      { role: "system", content: ESCALATE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ];
    const client = createLlmClient(settings.providerId, {
      scope: "llm_escalate",
      kind: "automatic",
      maxInputTokens: MAX_INPUT_TOKENS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    const run = await runStructured({
      tier: "json_schema",
      model: resolveLlmDestination(record.provider).model,
      schema: EscalationResponse,
      schemaName: "second_opinion",
      messages,
      send: client.send,
    });
    const { verdict, alternative, rationale } = run.value;
    // Candidate cross-check: an alternative must be one of the offered ids,
    // and `disagree` must carry one. Anything else is an invented action.
    if (
      alternative !== undefined &&
      !context.options.some((option) => option.id === alternative)
    ) {
      return null;
    }
    if (verdict === "disagree" && alternative === undefined) return null;
    const result: LlmEscalation = {
      verdict,
      ...(verdict === "disagree" && alternative !== undefined
        ? { alternative }
        : {}),
      rationale,
      model: run.model,
      ...(client.lastReservationId !== undefined
        ? { usageRef: client.lastReservationId }
        : {}),
    };
    return result;
  } catch {
    return null;
  }
}
