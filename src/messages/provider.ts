import {
  grantTestConsent,
  hasTestConsent,
  revokeTestConsent,
} from "../consent/records";
import { db } from "../db/database";
import { JevConnectionError, testJevConnection } from "../jev/connection";
import { resolvePreset } from "../net/presets";
import { NetworkGateError } from "../net/send";
import { PresetId, ProviderSettings } from "../schemas/provider";
import { z } from "../schemas/z";
import {
  deleteProviderKey,
  ProviderKeyError,
  saveProviderKey,
} from "../security/keys";

/**
 * The worker side of the Options provider-consent flow (plan Phase 2 Task 4).
 * The Options page is the only trusted caller — it obtains the Chrome host
 * permission from a direct Enable click, then sends one of these messages.
 * This module re-verifies the sender and the granted permission itself and
 * never trusts the page's claim.
 *
 * `handleProviderMessage` is total: every path resolves to a
 * `ProviderMessageResult`, so the `chrome.runtime.onMessage` adapter in
 * `background.ts` can answer `sendResponse` exactly once after `return true`.
 *
 * `chrome` is provided by the extension runtime; as in `security/keys.ts`,
 * only the used slice is declared so access stays lazy and
 * `vi.stubGlobal("chrome", ...)` works in tests.
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
export const ProviderMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ENABLE_PROVIDER"),
    preset: PresetId,
    model: z.string().min(1),
    key: z.string().min(1),
  }),
  z.object({
    type: z.literal("REVOKE_PROVIDER"),
    preset: PresetId,
    deleteKey: z.boolean(),
  }),
  z.object({ type: z.literal("PROVIDER_STATUS"), preset: PresetId }),
  // The Test-connection action (Phase 3): it carries only the preset — the
  // model always comes from the stored ProviderSettings, never the message,
  // so the page cannot pick a per-test model or attach key material.
  z.object({ type: z.literal("TEST_PROVIDER"), preset: PresetId }),
]);
export type ProviderMessage = z.infer<typeof ProviderMessage>;

/** Machine-readable failure codes for the provider protocol. The
 * `JevConnectionError`/`JevClientError` surface —
 * `auth`/`incompatible`/`retry_later`/`timeout`/`invalid_response`/
 * `answer_mismatch`/`model_mismatch`/`too_large`/`invalid_request`/
 * `http_error` plus the `NetworkGateError` codes it relays (`https_only`,
 * `unlisted_origin`, `no_consent`, `no_permission`, `no_key`, `transport`,
 * `unlisted_model`, `unregistered_scope`, `request_not_allowed`) — and
 * `ProviderKeyError`'s `reconnect` reach the page verbatim. */
export const ProviderErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "unlisted_model",
  "no_permission",
  "enable_failed",
  "revoke_failed",
  "not_enabled",
  "auth",
  "incompatible",
  "retry_later",
  "timeout",
  "invalid_response",
  "answer_mismatch",
  "model_mismatch",
  "too_large",
  "invalid_request",
  "http_error",
  "unregistered_scope",
  "request_not_allowed",
  "https_only",
  "unlisted_origin",
  "no_consent",
  "no_key",
  "transport",
  "reconnect",
  "internal_error",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCode>;

/**
 * What Options needs to restore its UI for one preset. `enabled` requires
 * all three: stored settings, a current `jev_test` consent grant, and the
 * host permission still held — so a permission removed outside the app flips
 * it to false. `model`/`keySuffix` are the masked display hints; raw key
 * material is never part of any response.
 */
export const ProviderStatus = z.object({
  enabled: z.boolean(),
  consentGranted: z.boolean(),
  model: z.string().optional(),
  keySuffix: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

/**
 * What a successful TEST_PROVIDER reports back: the response's versioned
 * model id, wall-clock `latencyMs` around the gated send, and `cost` only
 * when the provider's `usage.cost` reported one (OpenRouter). No raw
 * response body ever crosses into this result.
 */
export const ProviderTestResult = z.object({
  // `model` matches the SystemOneResponse wire contract — `z.string()`, no
  // minimum — so a provider's empty id still validates instead of surfacing
  // as a generic "unexpected response".
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResult>;

/**
 * Every worker response is one of these three shapes. This is a plain union
 * rather than a `z.discriminatedUnion("ok", ...)` because two success wire
 * shapes share `ok: true` — status replies carry `status`, test replies
 * carry `code: "test_ok"` + `result` — and Zod rejects duplicate
 * discriminator values. Readers narrow with `"status" in data` /
 * `"result" in data` after `data.ok`.
 */
export const ProviderMessageResult = z.union([
  z.object({ ok: z.literal(true), status: ProviderStatus }),
  z.object({
    ok: z.literal(true),
    code: z.literal("test_ok"),
    result: ProviderTestResult,
  }),
  z.object({
    ok: z.literal(false),
    code: ProviderErrorCode,
    message: z.string(),
  }),
]);
export type ProviderMessageResult = z.infer<typeof ProviderMessageResult>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface ProviderMessageSender {
  url?: string;
}

/**
 * Trailing characters of the API key exposed as the masked display hint.
 * A key this short or shorter would be revealed in full by `slice`, so the
 * worker stores a fixed placeholder instead — a persisted `keySuffix` must
 * never contain the raw key itself (`ProviderSettings` contract).
 */
const KEY_SUFFIX_LENGTH = 4;
const MASKED_KEY_SUFFIX = "****";

function keyDisplaySuffix(key: string): string {
  return key.length > KEY_SUFFIX_LENGTH
    ? key.slice(-KEY_SUFFIX_LENGTH)
    : MASKED_KEY_SUFFIX;
}

function failure(
  code: ProviderErrorCode,
  message: string,
): ProviderMessageResult {
  return { ok: false, code, message };
}

/**
 * True only for the built Options page of this extension. WXT emits it as
 * `options.html`; a content script's `sender.url` is the host page URL and
 * another extension's pages carry a different extension id, so all of them
 * fail this comparison.
 */
function isTrustedOptionsSender(sender: ProviderMessageSender): boolean {
  try {
    return sender.url === chrome.runtime.getURL("options.html");
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

/** Compose the status Options renders: enabled needs settings AND consent
 * AND a still-held host permission. Settings rows are re-validated because
 * `metadata.value` is untyped at storage. */
async function readStatus(preset: PresetId): Promise<ProviderStatus> {
  const { permissionPattern } = resolvePreset(preset);
  const [consentGranted, permissionGranted, row] = await Promise.all([
    hasTestConsent(preset),
    hasOriginPermission(permissionPattern),
    db.metadata.get(preset),
  ]);
  const parsed = ProviderSettings.safeParse(row?.value);
  const settings = parsed.success ? parsed.data : undefined;
  const status: ProviderStatus = {
    enabled: consentGranted && permissionGranted && settings !== undefined,
    consentGranted,
  };
  if (settings !== undefined) {
    status.model = settings.model;
    status.keySuffix = settings.keySuffix;
  }
  return status;
}

/**
 * Undo a partial enable so a provider can never appear enabled with missing
 * consent: drop the consent row, the encrypted key material, and the settings
 * row. Every step is a safe no-op when its record was never written.
 */
async function unwindEnable(preset: PresetId): Promise<void> {
  await Promise.allSettled([
    revokeTestConsent(preset),
    deleteProviderKey(preset),
    db.metadata.delete(preset),
  ]);
}

async function enableProvider(message: {
  preset: PresetId;
  model: string;
  key: string;
}): Promise<ProviderMessageResult> {
  const destination = resolvePreset(message.preset);

  // Re-check the preset/model pairing in the worker — the page's choice is
  // not trusted.
  if (!destination.models.includes(message.model)) {
    return failure(
      "unlisted_model",
      `Model "${message.model}" is not offered by preset "${message.preset}".`,
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

  const settings = ProviderSettings.parse({
    preset: message.preset,
    model: message.model,
    keySuffix: keyDisplaySuffix(message.key),
  });
  try {
    await db.metadata.put({ key: message.preset, value: settings });
    await saveProviderKey(message.preset, message.key);
    // The consent row is written last so nothing is "enabled" until every
    // piece landed.
    await grantTestConsent(message.preset);
  } catch {
    await unwindEnable(message.preset);
    return failure(
      "enable_failed",
      "Setup could not finish; nothing was saved and the provider was not enabled.",
    );
  }
  return { ok: true, status: await readStatus(message.preset) };
}

async function revokeProvider(message: {
  preset: PresetId;
  deleteKey: boolean;
}): Promise<ProviderMessageResult> {
  const destination = resolvePreset(message.preset);

  // Consent comes off first: if permission removal then fails, the gate still
  // blocks every request because no current consent row remains.
  try {
    await revokeTestConsent(message.preset);
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
    // `remove` can report false (e.g. the grant was already gone); count the
    // step as done only when the permission is not held afterwards.
    const released =
      removed === true || !(await hasOriginPermission(destination.permissionPattern));
    if (!released) failures.push("browser permission");
  } catch {
    failures.push("browser permission");
  }

  try {
    await db.metadata.delete(message.preset);
  } catch {
    failures.push("saved settings");
  }

  if (message.deleteKey) {
    try {
      await deleteProviderKey(message.preset);
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
  return { ok: true, status: await readStatus(message.preset) };
}

/**
 * Run the synthetic Jev connection test for a fully enabled preset — the
 * only message variant that can produce network traffic. The not-enabled
 * refusal happens BEFORE `testJevConnection` is invoked, so a missing
 * settings row, revoked consent, or a permission removed outside the app
 * never reaches transport. The tested model is always the stored
 * `ProviderSettings.model`, not anything the message carries.
 *
 * Failure mapping: `JevConnectionError` code/message are relayed verbatim
 * (already redacted — including the `NetworkGateError` codes the client
 * relays unflattened); a `NetworkGateError` or `ProviderKeyError` that
 * somehow escaped the client's wrap surfaces with its own redacted code —
 * `reconnect` tells the user to re-enter the key — and message; anything
 * else — ZodError, non-Error rejections — collapses to a static
 * `internal_error` so internals never cross the message boundary. The test
 * is read-only: a failure changes no consent, settings, or key state.
 */
async function testProvider(message: {
  preset: PresetId;
}): Promise<ProviderMessageResult> {
  const status = await readStatus(message.preset);
  if (!status.enabled || status.model === undefined) {
    return failure(
      "not_enabled",
      `Provider "${message.preset}" is not fully enabled — enable it before testing the connection.`,
    );
  }
  try {
    const result = await testJevConnection(message.preset, status.model);
    return { ok: true, code: "test_ok", result };
  } catch (cause) {
    if (cause instanceof JevConnectionError) {
      return failure(cause.code, cause.message);
    }
    if (cause instanceof NetworkGateError) {
      return failure(cause.code, cause.message);
    }
    if (cause instanceof ProviderKeyError) {
      return failure(cause.code, cause.message);
    }
    return failure(
      "internal_error",
      "The connection test failed unexpectedly; nothing was changed on purpose.",
    );
  }
}

/**
 * Validate and dispatch one provider-protocol message. Exported so the
 * behavior is testable without standing up a service worker; `background.ts`
 * wires it to `chrome.runtime.onMessage` unchanged.
 */
export async function handleProviderMessage(
  message: unknown,
  sender: ProviderMessageSender,
): Promise<ProviderMessageResult> {
  try {
    if (!isTrustedOptionsSender(sender)) {
      return failure(
        "untrusted_sender",
        "Provider messages are only handled from the extension's Options page.",
      );
    }
    const parsed = ProviderMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the provider protocol.",
      );
    }
    switch (parsed.data.type) {
      case "PROVIDER_STATUS":
        return { ok: true, status: await readStatus(parsed.data.preset) };
      case "ENABLE_PROVIDER":
        return await enableProvider(parsed.data);
      case "REVOKE_PROVIDER":
        return await revokeProvider(parsed.data);
      case "TEST_PROVIDER":
        return await testProvider(parsed.data);
    }
  } catch {
    return failure(
      "internal_error",
      "The provider request failed unexpectedly; nothing was changed on purpose.",
    );
  }
}
