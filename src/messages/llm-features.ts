import { db } from "../db/database";
import { monthlyBudgetSnapshot } from "../llm/budget";
import type { MonthlyBudgetSnapshot } from "../llm/budget";
import { ExplainError, explainDecision } from "../llm/explain";
import {
  readLlmEscalationSettings,
  writeLlmEscalationSettings,
} from "../llm/escalate";
import { LlmHttpError } from "../llm/client";
import { readActiveLlmProvider, readLlmProvider } from "../llm/settings";
import { LlmCapabilityError } from "../llm/structured";
import type { TokenUsage } from "../llm/wire";
import { LlmGateError } from "../net/llm-send";
import { z } from "../schemas/z";

/**
 * The worker side of the Phase-3 feature intents (plan Phase 3 Task 3):
 * Explain a pending decision, read/write the automatic-escalation settings,
 * and report the escalation budget. Trusted callers are the extension's own
 * pages (the sidepanel's review queue for Explain, Options for the
 * escalation toggles); the sender is re-verified here.
 *
 * `handleLlmFeatureMessage` returns `undefined` for messages outside this
 * protocol so `background.ts` can chain it before the terminal handler; for
 * owned `LLM_*` types the handler is total — every path resolves to an
 * `LlmFeatureMessageResult`, never rejects.
 *
 * Redaction boundary: replies carry verdicts, codes, ids, and counts — never
 * bookmark titles/URLs, prompts, response bodies, or key material.
 *
 * `chrome` is the lazy-slice house pattern so `vi.stubGlobal` works in tests.
 */
declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** Messages extension pages may send — validated at the trust boundary. */
export const LlmFeatureMessage = z.discriminatedUnion("type", [
  // Explain one pending decision. `unknownCostConfirmed` is ONLY honored on
  // this manual intent — it is the CostConfirmationDialog resend flag;
  // automatic escalation can never carry it (spec FR7.8).
  z.strictObject({
    type: z.literal("LLM_EXPLAIN"),
    decisionId: z.string().min(1),
    unknownCostConfirmed: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("LLM_ESCALATION_STATUS") }),
  z.strictObject({
    type: z.literal("LLM_ESCALATION_SET"),
    enabled: z.boolean(),
    providerId: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal("LLM_FEATURE_BUDGET") }),
]);
export type LlmFeatureMessage = z.infer<typeof LlmFeatureMessage>;

/** Dispatch table membership — messages whose `type` this module owns. */
const LLM_FEATURE_TYPES = new Set([
  "LLM_EXPLAIN",
  "LLM_ESCALATION_STATUS",
  "LLM_ESCALATION_SET",
  "LLM_FEATURE_BUDGET",
]);

/**
 * Machine-readable failure codes. The `LlmGateError` codes reach the page
 * verbatim — `confirmation_required` is how the CostConfirmationDialog knows
 * to prompt, `budget_exceeded`/`pricing_required` how the escalation row
 * explains a block — plus the explain-service codes and the protocol's own
 * trust/malformed codes.
 */
export const LlmFeatureErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "not_configured",
  "not_found",
  "not_pending",
  "stale",
  "provider",
  "capability_unsupported",
  "unregistered_scope",
  "no_provider",
  "invalid_provider",
  "request_not_allowed",
  "unlisted_model",
  "no_consent",
  "no_permission",
  "no_key",
  "pricing_required",
  "confirmation_required",
  "budget_exceeded",
  "timeout",
  "transport",
  "http_error",
  "internal_error",
]);
export type LlmFeatureErrorCode = z.infer<typeof LlmFeatureErrorCode>;

/** The escalation state Options renders (plus what gates it downstream). */
export const LlmEscalationStatusResult = z.object({
  enabled: z.boolean(),
  providerId: z.string().optional(),
  /** A stored provider record exists for `providerId`. */
  providerConfigured: z.boolean(),
  /** The configured monthly cap; `null` when none — escalation cannot run. */
  monthlyBudgetUsd: z.number().nonnegative().nullable(),
});
export type LlmEscalationStatusResult = z.infer<
  typeof LlmEscalationStatusResult
>;

/** A successful Explain reply: the rationale, model, and usage when known. */
export const LlmExplainResult = z.object({
  decisionId: z.string(),
  rationale: z.string().max(1_000),
  model: z.string(),
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const LlmBudgetSnapshotResult = z.object({
  month: z.string(),
  requestCount: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reportedCostUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  unknownCostRequests: z.number().nonnegative(),
  hasUnknownCost: z.boolean(),
  reservedUsd: z.number().nonnegative(),
  committedUsd: z.number().nonnegative(),
  budgetUsd: z.number().nullable(),
  remainingUsd: z.number().nullable(),
});

/** Every worker response is one of these shapes; see llm-provider.ts. */
export const LlmFeatureMessageResult = z.union([
  z.object({
    ok: z.literal(true),
    code: z.literal("explain_ok"),
    result: LlmExplainResult,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("escalation_status"),
    escalation: LlmEscalationStatusResult,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("budget_snapshot"),
    snapshot: LlmBudgetSnapshotResult,
  }),
  z.object({
    ok: z.literal(false),
    code: LlmFeatureErrorCode,
    message: z.string(),
  }),
]);
export type LlmFeatureMessageResult = z.infer<typeof LlmFeatureMessageResult>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface LlmFeatureMessageSender {
  url?: string;
}

function failure(
  code: LlmFeatureErrorCode,
  message: string,
): LlmFeatureMessageResult {
  return { ok: false, code, message };
}

function isTrustedExtensionSender(sender: LlmFeatureMessageSender): boolean {
  try {
    const base = chrome.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(base);
  } catch {
    return false;
  }
}

/** Map a thrown error to a stable code without leaking its content. */
function mapError(cause: unknown): LlmFeatureMessageResult {
  if (cause instanceof ExplainError) {
    return failure(cause.code, cause.message);
  }
  if (cause instanceof LlmGateError) {
    return failure(cause.code, cause.message);
  }
  if (cause instanceof LlmCapabilityError) {
    return failure(
      "capability_unsupported",
      "The configured provider rejected structured output.",
    );
  }
  if (cause instanceof LlmHttpError) {
    return failure(
      "http_error",
      `The LLM provider answered HTTP ${cause.status}.`,
    );
  }
  return failure(
    "internal_error",
    "The request failed unexpectedly; nothing was sent or changed on purpose.",
  );
}

/** Compose the escalation status: settings + whether its provider exists. */
async function escalationStatus(): Promise<LlmFeatureMessageResult> {
  const settings = await readLlmEscalationSettings();
  const record =
    settings.providerId === undefined
      ? null
      : await readLlmProvider(settings.providerId);
  const escalation: LlmEscalationStatusResult = {
    enabled: settings.enabled,
    providerConfigured: record !== null,
    monthlyBudgetUsd: record?.monthlyBudgetUsd ?? null,
    ...(settings.providerId !== undefined
      ? { providerId: settings.providerId }
      : {}),
  };
  return { ok: true, code: "escalation_status", escalation };
}

/**
 * Enable or disable automatic escalation. Enabling needs a provider — the
 * message's `providerId`, or the active provider as the default — and the
 * stored record must exist, else `no_provider`.
 */
async function setEscalation(message: {
  enabled: boolean;
  providerId?: string;
}): Promise<LlmFeatureMessageResult> {
  let providerId = message.providerId;
  if (providerId === undefined) {
    // Disabling keeps the previously stored provider; enabling falls back
    // to the active provider.
    const existing = await readLlmEscalationSettings();
    providerId = existing.providerId;
  }
  if (message.enabled && providerId === undefined) {
    const active = await readActiveLlmProvider();
    providerId = active?.providerId;
  }
  if (message.enabled) {
    if (
      providerId === undefined ||
      (await readLlmProvider(providerId)) === null
    ) {
      return failure(
        "no_provider",
        "Enable escalation needs a configured LLM provider.",
      );
    }
  }
  try {
    await writeLlmEscalationSettings({
      enabled: message.enabled,
      ...(providerId !== undefined ? { providerId } : {}),
    });
  } catch {
    return failure(
      "malformed_message",
      "The escalation settings were rejected by the store.",
    );
  }
  return escalationStatus();
}

/** The monthly budget for the escalation provider (active as fallback). */
async function featureBudget(): Promise<LlmFeatureMessageResult> {
  const settings = await readLlmEscalationSettings();
  const record =
    settings.providerId !== undefined
      ? await readLlmProvider(settings.providerId)
      : await readActiveLlmProvider();
  if (record === null) {
    return failure("no_provider", "No LLM provider is configured.");
  }
  const [usage, reservations] = await Promise.all([
    db.llmUsage.toArray(),
    db.llmReservations.toArray(),
  ]);
  const snapshot: MonthlyBudgetSnapshot = monthlyBudgetSnapshot({
    providerId: record.providerId,
    usage,
    reservations,
    now: new Date(),
    ...(record.monthlyBudgetUsd !== undefined
      ? { monthlyBudgetUsd: record.monthlyBudgetUsd }
      : {}),
  });
  return { ok: true, code: "budget_snapshot", snapshot };
}

/** Explain one pending decision via the configured provider. */
async function explain(message: {
  decisionId: string;
  unknownCostConfirmed?: boolean;
}): Promise<LlmFeatureMessageResult> {
  const active = await readActiveLlmProvider();
  if (active === null) {
    return failure("no_provider", "No LLM provider is configured.");
  }
  const result = await explainDecision(message.decisionId, active.providerId, {
    ...(message.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: message.unknownCostConfirmed }
      : {}),
  });
  const usage: TokenUsage | undefined = result.usage;
  return {
    ok: true,
    code: "explain_ok",
    result: {
      decisionId: result.decisionId,
      rationale: result.rationale,
      model: result.model,
      ...(usage !== undefined &&
      usage.promptTokens !== undefined &&
      usage.completionTokens !== undefined
        ? {
            usage: {
              inputTokens: usage.promptTokens,
              outputTokens: usage.completionTokens,
              ...(usage.reportedCostUsd !== undefined
                ? { costUsd: usage.reportedCostUsd }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Validate and dispatch one feature message. `undefined` when `message.type`
 * is not owned so `background.ts` can chain handlers; total otherwise.
 */
export async function handleLlmFeatureMessage(
  message: unknown,
  sender: LlmFeatureMessageSender,
): Promise<LlmFeatureMessageResult | undefined> {
  const type =
    typeof message === "object" && message !== null
      ? (message as { type?: unknown }).type
      : undefined;
  if (typeof type !== "string" || !LLM_FEATURE_TYPES.has(type)) {
    return undefined;
  }
  try {
    if (!isTrustedExtensionSender(sender)) {
      return failure(
        "untrusted_sender",
        "LLM feature messages are only handled from this extension's own pages.",
      );
    }
    const parsed = LlmFeatureMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the LLM feature protocol.",
      );
    }
    switch (parsed.data.type) {
      case "LLM_EXPLAIN":
        return await explain(parsed.data).catch(mapError);
      case "LLM_ESCALATION_STATUS":
        return await escalationStatus();
      case "LLM_ESCALATION_SET":
        return await setEscalation(parsed.data);
      case "LLM_FEATURE_BUDGET":
        return await featureBudget();
    }
  } catch {
    return failure(
      "internal_error",
      "The LLM feature request failed unexpectedly; nothing was changed on purpose.",
    );
  }
}
