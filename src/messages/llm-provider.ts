import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  revokeConsentsAtOrigin,
  revokeConsentAtOrigin,
} from "../consent/records";
import { db } from "../db/database";
import {
  monthlyBudgetSnapshot,
  type MonthlyBudgetSnapshot,
} from "../llm/budget";
import { createLlmClient, LlmHttpError } from "../llm/client";
import { resolveLlmDestination } from "../llm/providers";
import {
  readActiveLlmProvider,
  readLlmProvider,
  saveLlmProvider,
} from "../llm/settings";
import { LlmCapabilityError } from "../llm/structured";
import {
  ChatCompletionResponse,
  type ChatCompletionRequest,
} from "../llm/wire";
import {
  LlmProviderRecord,
  LlmProviderSettings,
  StructuredOutputTier,
  LlmAuthMode,
} from "../schemas/llm";
import { z } from "../schemas/z";
import {
  CredentialError,
  deleteCredential,
  saveCredential,
} from "../security/credentials";
import { LlmGateError } from "../net/llm-send";

/**
 * The worker side of the Options LLM-provider flow (plan Phase 2 Task 4).
 * The Options page is the only trusted caller — it obtains the Chrome host
 * permission from a direct Enable click, then sends one of these messages.
 * The worker re-verifies the sender and the granted permission itself and
 * never trusts the page's claim.
 *
 * Unlike `handleProviderMessage` (the Jev protocol's terminal handler),
 * `handleLlmProviderMessage` returns `undefined` for messages outside this
 * protocol so `background.ts` can chain it before the terminal handler.
 * For every `LLM_*` type the handler is total: each path resolves to an
 * `LlmProviderMessageResult`, never rejects.
 *
 * `chrome` is the lazy-slice house pattern so `vi.stubGlobal` works in
 * tests.
 */
declare const chrome: {
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
    remove(permissions: { origins?: string[] }): Promise<boolean>;
  };
  runtime: {
    getURL(path: string): string;
  };
};

/** Messages the Options page may send — validated at the trust boundary. */
export const LlmProviderMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("LLM_CONFIGURE"),
    settings: LlmProviderSettings,
    key: z.string().min(1).optional(),
    monthlyBudgetUsd: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("LLM_PROVIDER_STATUS"),
    providerId: z.string().min(1).optional(),
  }),
  // The Test-connection action. It carries only an optional provider id —
  // model, endpoint, and the synthetic payload all come from the stored
  // record, never the message, so the page cannot steer content or keys.
  z.strictObject({
    type: z.literal("LLM_TEST"),
    providerId: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("LLM_REVOKE"),
    providerId: z.string().min(1),
    deleteKey: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("LLM_BUDGET_SNAPSHOT"),
    providerId: z.string().min(1).optional(),
  }),
]);
export type LlmProviderMessage = z.infer<typeof LlmProviderMessage>;

/** Dispatch table membership — messages whose `type` this module owns. */
const LLM_MESSAGE_TYPES = new Set([
  "LLM_CONFIGURE",
  "LLM_PROVIDER_STATUS",
  "LLM_TEST",
  "LLM_REVOKE",
  "LLM_BUDGET_SNAPSHOT",
]);

/**
 * Machine-readable failure codes for the LLM provider protocol. The
 * `LlmGateError` codes (`unregistered_scope`, `no_provider`,
 * `invalid_provider`, `request_not_allowed`, `unlisted_model`,
 * `no_consent`, `no_permission`, `no_key`, `pricing_required`,
 * `confirmation_required`, `budget_exceeded`, `timeout`, `transport`),
 * `http_error`, the credential store's `reconnect`, and
 * `capability_unsupported` (every structured-output tier rejected) reach
 * the page verbatim.
 */
export const LlmProviderErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "not_configured",
  "key_required",
  "configure_failed",
  "revoke_failed",
  "not_enabled",
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
  "reconnect",
  "internal_error",
]);
export type LlmProviderErrorCode = z.infer<typeof LlmProviderErrorCode>;

/**
 * What Options needs to render one provider's state. `enabled` requires
 * all of: a stored record, a current `llm_test` consent grant at the
 * resolved origin, and the host permission still held — so a permission
 * removed outside the app flips it to false. A missing credential is NOT
 * folded in: it surfaces from the gate as `no_key`, mirroring the Jev
 * protocol. Only the masked `keySuffix` crosses the wire; raw key material
 * is never part of any response.
 */
export const LlmProviderStatus = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  consentGranted: z.boolean(),
  permissionGranted: z.boolean(),
  active: z.boolean(),
  providerId: z.string().optional(),
  origin: z.string().optional(),
  model: z.string().optional(),
  auth: LlmAuthMode.optional(),
  keySuffix: z.string().optional(),
  tier: StructuredOutputTier.optional(),
  monthlyBudgetUsd: z.number().nonnegative().optional(),
});
export type LlmProviderStatus = z.infer<typeof LlmProviderStatus>;

/**
 * What a successful LLM_TEST reports: the response's model id, wall-clock
 * `latencyMs` around the gated send, the discovered structured-output tier,
 * and token/cost usage when the provider reported it. No raw response body
 * ever crosses into this result.
 */
export const LlmTestResult = z.object({
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  tier: StructuredOutputTier,
  usage: z
    .object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type LlmTestResult = z.infer<typeof LlmTestResult>;

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

/**
 * Every worker response is one of these four shapes. A plain union, not a
 * discriminated union, because two success shapes share `ok: true` — status
 * replies carry `status`, test replies `code: "test_ok"`, budget replies
 * `code: "budget_snapshot"` — and Zod rejects duplicate discriminators.
 * Readers narrow with `"status" in data` / `"result" in data` /
 * `"snapshot" in data` after `data.ok`.
 */
export const LlmProviderMessageResult = z.union([
  z.object({ ok: z.literal(true), status: LlmProviderStatus }),
  z.object({
    ok: z.literal(true),
    code: z.literal("test_ok"),
    result: LlmTestResult,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("budget_snapshot"),
    snapshot: LlmBudgetSnapshotResult,
  }),
  z.object({
    ok: z.literal(false),
    code: LlmProviderErrorCode,
    message: z.string(),
  }),
]);
export type LlmProviderMessageResult = z.infer<
  typeof LlmProviderMessageResult
>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface LlmProviderMessageSender {
  url?: string;
}

const KEY_SUFFIX_LENGTH = 4;
const MASKED_KEY_SUFFIX = "****";

function keyDisplaySuffix(key: string): string {
  return key.length > KEY_SUFFIX_LENGTH
    ? key.slice(-KEY_SUFFIX_LENGTH)
    : MASKED_KEY_SUFFIX;
}

function failure(
  code: LlmProviderErrorCode,
  message: string,
): LlmProviderMessageResult {
  return { ok: false, code, message };
}

/**
 * True only for this extension's Options page. The page's URL can carry a
 * panel hash (`options.html#permissions` — the redesigned shell's deep links,
 * and any reload of a hashed URL), which Chrome reports verbatim in
 * `sender.url`, so compare protocol/host/path rather than the whole string.
 */
function isTrustedOptionsSender(sender: LlmProviderMessageSender): boolean {
  try {
    if (typeof sender.url !== "string") return false;
    const expected = new URL(chrome.runtime.getURL("options.html"));
    const actual = new URL(sender.url);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/** Fail-closed permission check: any API error counts as "not granted". */
async function hasOriginPermission(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function recordFor(
  providerId: string | undefined,
): Promise<LlmProviderRecord | null> {
  return providerId === undefined
    ? readActiveLlmProvider()
    : readLlmProvider(providerId);
}

/** Compose the status Options renders for one provider record. */
async function readStatus(
  providerId: string | undefined,
): Promise<LlmProviderStatus> {
  const record = await recordFor(providerId);
  if (record === null) {
    return {
      configured: false,
      enabled: false,
      consentGranted: false,
      permissionGranted: false,
      active: false,
    };
  }
  const destination = resolveLlmDestination(record.provider);
  const [consentGranted, permissionGranted, active] = await Promise.all([
    hasConsentAtOrigin("llm_test", destination.origin),
    hasOriginPermission(destination.permissionPattern),
    readActiveLlmProvider(),
  ]);
  const status: LlmProviderStatus = {
    configured: true,
    enabled: consentGranted && permissionGranted,
    consentGranted,
    permissionGranted,
    active: active?.providerId === record.providerId,
    providerId: record.providerId,
    origin: destination.origin,
    model: destination.model,
    auth: destination.auth,
  };
  if (record.keySuffix !== undefined) status.keySuffix = record.keySuffix;
  if (record.tier !== undefined) status.tier = record.tier;
  if (record.monthlyBudgetUsd !== undefined) {
    status.monthlyBudgetUsd = record.monthlyBudgetUsd;
  }
  return status;
}

/** Undo a partial configure: drop only the rows this flow just wrote. */
async function unwindConfigure(
  providerId: string,
  origin: string,
): Promise<void> {
  await Promise.allSettled([
    db.metadata.delete(`llmProvider:${providerId}`),
    db.metadata.get("llmActiveProvider").then(async (row) => {
      if (row?.value === providerId) {
        await db.metadata.delete("llmActiveProvider");
      }
    }),
    deleteCredential(providerId),
    revokeConsentAtOrigin("llm_test", origin),
  ]);
}

async function configureProvider(message: {
  settings: LlmProviderSettings;
  key?: string;
  monthlyBudgetUsd?: number;
}): Promise<LlmProviderMessageResult> {
  let destination;
  try {
    destination = resolveLlmDestination(message.settings);
  } catch {
    return failure("malformed_message", "The provider settings are invalid.");
  }

  if (destination.auth !== "none" && message.key === undefined) {
    return failure(
      "key_required",
      `Provider auth "${destination.auth}" needs an API key to enable.`,
    );
  }

  // The Options page already prompted via chrome.permissions.request; the
  // worker re-verifies the grant rather than trusting the message.
  if (!(await hasOriginPermission(destination.permissionPattern))) {
    return failure(
      "no_permission",
      `The host permission for ${destination.origin} was not granted; the provider was not enabled.`,
    );
  }

  const record = LlmProviderRecord.parse({
    providerId: destination.providerId,
    provider: message.settings,
    ...(message.key !== undefined
      ? { keySuffix: keyDisplaySuffix(message.key) }
      : {}),
    ...(message.monthlyBudgetUsd !== undefined
      ? { monthlyBudgetUsd: message.monthlyBudgetUsd }
      : {}),
    configuredAt: new Date().toISOString(),
  });

  try {
    await saveLlmProvider(record);
    if (message.key !== undefined && destination.auth !== "none") {
      await saveCredential(record.providerId, message.key);
    } else if (destination.auth === "none") {
      // A credential stored by an earlier keyed configuration of this same
      // providerId would sit orphaned once the record flips to `auth:
      // "none"` — the gate skips credential reads for keyless providers, so
      // nothing would ever delete it. Drop it (a no-op when none exists).
      await deleteCredential(record.providerId);
    }
    // The consent row is written last so nothing is "enabled" until every
    // piece landed.
    await grantConsentAtOrigin("llm_test", destination.origin);
  } catch {
    await unwindConfigure(record.providerId, destination.origin);
    return failure(
      "configure_failed",
      "Setup could not finish; nothing was saved and the provider was not enabled.",
    );
  }
  return { ok: true, status: await readStatus(record.providerId) };
}

/**
 * The synthetic connectivity-check request. Bounded output (`max_tokens`
 * 16), temperature 0, and a fixed prompt — no user data, no bookmark
 * content, nothing derived from the library.
 */
function pingRequest(
  model: string,
  tier: StructuredOutputTier,
): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a connectivity check for a browser extension. Reply with the JSON object {\"ok\":true} and nothing else.",
      },
      { role: "user", content: "ping" },
    ],
    max_tokens: 16,
    temperature: 0,
  };
  if (tier === "json_schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: {
        name: "connectivity_check",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    };
  } else if (tier === "json_object") {
    request.response_format = { type: "json_object" };
  }
  return request;
}

const TIER_PROBE_ORDER = [
  "json_schema",
  "json_object",
  "prompt_only",
] as const satisfies readonly StructuredOutputTier[];

/**
 * Run the synthetic connection test for a fully enabled provider — the only
 * message variant that can produce network traffic. The not-enabled refusal
 * happens BEFORE any gated send, so a missing consent row, a permission
 * removed outside the app, or a missing credential never reaches transport.
 *
 * Tier discovery (spec FR4.2): probe `json_schema` → `json_object` →
 * `prompt_only` in order; a `LlmCapabilityError` (provider explicitly
 * rejects the structured-output field) advances to the next tier, the first
 * success is persisted on the record, and any other failure ends the probe.
 * Every attempt runs through `sendLlmConsented` under `llm_test` consent —
 * a manual request with the enable gesture counting as the unknown-cost
 * confirmation.
 *
 * Failure mapping mirrors the Jev protocol: `LlmGateError` codes are relayed
 * verbatim, `LlmHttpError` becomes `http_error`, `CredentialError` becomes
 * `reconnect`, and anything else collapses to a static `internal_error` —
 * internals never cross the message boundary.
 */
async function testProvider(message: {
  providerId?: string;
}): Promise<LlmProviderMessageResult> {
  const record = await recordFor(message.providerId);
  if (record === null) {
    return failure(
      "not_configured",
      "No LLM provider is configured for that id.",
    );
  }

  const status = await readStatus(record.providerId);
  if (!status.enabled) {
    return failure(
      "not_enabled",
      "The LLM provider is not fully enabled — configure it and grant consent before testing the connection.",
    );
  }

  const destination = resolveLlmDestination(record.provider);
  const client = createLlmClient(record.providerId, {
    scope: "llm_test",
    kind: "manual",
    maxInputTokens: 64,
    maxOutputTokens: 16,
    // The enable click is the user's explicit confirmation for the small
    // synthetic probe — per-request unknown-cost prompts would make Test
    // unusable for unpriced providers.
    unknownCostConfirmed: true,
  });

  const started = Date.now();
  for (const tier of TIER_PROBE_ORDER) {
    try {
      const raw = await client.send(pingRequest(destination.model, tier));
      const parsed = ChatCompletionResponse.safeParse(raw);
      if (!parsed.success) {
        return failure(
          "invalid_provider",
          "The provider answered but the response was not a valid chat completion.",
        );
      }
      const latencyMs = Math.max(0, Date.now() - started);
      const next = LlmProviderRecord.parse({ ...record, tier });
      await db.metadata.put({
        key: `llmProvider:${record.providerId}`,
        value: next,
      });
      const result: LlmTestResult = {
        model: parsed.data.model,
        latencyMs,
        tier,
      };
      const usage = parsed.data.usage;
      if (usage !== undefined) {
        result.usage = {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          ...(usage.cost !== null && usage.cost !== undefined
            ? { costUsd: usage.cost }
            : {}),
        };
      }
      return { ok: true, code: "test_ok", result };
    } catch (cause) {
      // Reaching the loop end means every tier hit LlmCapabilityError —
      // any other failure returns immediately.
      if (cause instanceof LlmCapabilityError) {
        continue;
      }
      if (cause instanceof LlmGateError) {
        return failure(cause.code, cause.message);
      }
      if (cause instanceof LlmHttpError) {
        return failure("http_error", cause.message);
      }
      if (cause instanceof CredentialError) {
        return failure("reconnect", cause.message);
      }
      return failure(
        "internal_error",
        "The connection test failed unexpectedly; nothing was changed on purpose.",
      );
    }
  }
  return failure(
    "capability_unsupported",
    "The provider rejected every structured-output tier; it cannot be used for LLM features.",
  );
}

/**
 * Revoke a provider (spec FR2.8): consent comes off first — if a later step
 * fails the gate still blocks every request because no current consent row
 * remains. `revokeConsentsAtOrigin` sweeps every scope the origin holds
 * (llm_test plus any feature scopes), then the host permission is released,
 * then the record/reservations/active pointer, and the stored credential
 * only when `deleteKey` is set.
 */
async function revokeProvider(message: {
  providerId: string;
  deleteKey: boolean;
}): Promise<LlmProviderMessageResult> {
  const record = await readLlmProvider(message.providerId);
  if (record === null) {
    return failure(
      "not_configured",
      "No LLM provider is configured for that id.",
    );
  }
  const destination = resolveLlmDestination(record.provider);

  try {
    await revokeConsentsAtOrigin(destination.origin);
  } catch {
    return failure(
      "revoke_failed",
      "The recorded consent could not be removed; nothing else was changed.",
    );
  }

  const failures: string[] = [];
  try {
    const removed = await chrome.permissions.remove({
      origins: [destination.permissionPattern],
    });
    const released =
      removed === true ||
      !(await hasOriginPermission(destination.permissionPattern));
    if (!released) failures.push("browser permission");
  } catch {
    failures.push("browser permission");
  }

  try {
    await db.transaction(
      "rw",
      db.metadata,
      db.llmReservations,
      async () => {
        await db.metadata.delete(`llmProvider:${record.providerId}`);
        const pointer = await db.metadata.get("llmActiveProvider");
        if (pointer?.value === record.providerId) {
          await db.metadata.delete("llmActiveProvider");
        }
        await db.llmReservations
          .where("providerId")
          .equals(record.providerId)
          .delete();
      },
    );
  } catch {
    failures.push("saved settings");
  }

  if (message.deleteKey) {
    try {
      await deleteCredential(record.providerId);
    } catch {
      failures.push("stored key");
    }
  }

  if (failures.length > 0) {
    return failure(
      "revoke_failed",
      `Consent was removed, but the following could not be removed: ${failures.join(
        ", ",
      )}.`,
    );
  }
  return { ok: true, status: await readStatus(record.providerId) };
}

async function budgetSnapshot(message: {
  providerId?: string;
}): Promise<LlmProviderMessageResult> {
  const record = await recordFor(message.providerId);
  if (record === null) {
    return failure(
      "not_configured",
      "No LLM provider is configured for that id.",
    );
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

/**
 * Validate and dispatch one LLM provider-protocol message. Returns
 * `undefined` when `message.type` is not one of this module's `LLM_*`
 * types so `background.ts` can chain handlers; for owned types the handler
 * is total — every path resolves to an `LlmProviderMessageResult`.
 */
export async function handleLlmProviderMessage(
  message: unknown,
  sender: LlmProviderMessageSender,
): Promise<LlmProviderMessageResult | undefined> {
  const type =
    typeof message === "object" && message !== null
      ? (message as { type?: unknown }).type
      : undefined;
  if (typeof type !== "string" || !LLM_MESSAGE_TYPES.has(type)) {
    return undefined;
  }
  try {
    if (!isTrustedOptionsSender(sender)) {
      return failure(
        "untrusted_sender",
        "LLM provider messages are only handled from the extension's Options page.",
      );
    }
    const parsed = LlmProviderMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the LLM provider protocol.",
      );
    }
    switch (parsed.data.type) {
      case "LLM_CONFIGURE":
        return await configureProvider(parsed.data);
      case "LLM_PROVIDER_STATUS":
        return { ok: true, status: await readStatus(parsed.data.providerId) };
      case "LLM_TEST":
        return await testProvider(parsed.data);
      case "LLM_REVOKE":
        return await revokeProvider(parsed.data);
      case "LLM_BUDGET_SNAPSHOT":
        return await budgetSnapshot(parsed.data);
    }
  } catch {
    return failure(
      "internal_error",
      "The LLM provider request failed unexpectedly; nothing was changed on purpose.",
    );
  }
}
