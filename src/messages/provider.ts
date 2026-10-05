import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  revokeConsentAtOrigin,
  revokeConsentsAtOrigin,
} from "../consent/records";
import { db } from "../db/database";
import { JevConnectionError, testJevConnection } from "../jev/connection";
import {
  presetJevDestination,
  resolveJevDestination,
  type JevDestination,
} from "../jev/providers";
import { readJevProvider } from "../jev/settings";
import { NetworkGateError } from "../net/send";
import { LlmBaseUrl } from "../schemas/llm";
import {
  CONSENT_SCOPE,
  JevProviderId,
  ProviderApiKey,
  ProviderSettings,
} from "../schemas/provider";
import { z } from "../schemas/z";
import {
  deleteProviderKey,
  ProviderKeyError,
  readProviderKey,
  saveProviderKey,
} from "../security/keys";

/**
 * The worker side of the Options provider-consent flow (plan Phase 2 Task 4).
 * The Options page is the only trusted caller — it obtains the Chrome host
 * permission from a direct Enable click, then sends one of these messages.
 * This module re-verifies the sender and the granted permission itself and
 * never trusts the page's claim.
 *
 * Providers are addressed by `JevProviderId`: a preset name resolves through
 * the frozen registry, `"custom"` resolves from the stored settings row the
 * Enable flow writes (the base URL lives nowhere else). Consent and the
 * host-permission grant always key off the resolved origin, so a stored row
 * pointing somewhere new cannot ride an old origin's consent.
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
    preset: JevProviderId,
    model: z.string().min(1),
    // Boundary-trimmed and ASCII-checked (H02) — a key with embedded
    // whitespace or a newline is rejected, not silently stored.
    key: ProviderApiKey,
    // The custom provider's canonical API base URL — ignored for presets,
    // required (and re-validated as ProviderSettings) when preset is
    // "custom".
    baseUrl: LlmBaseUrl.optional(),
  }),
  z.object({
    type: z.literal("REVOKE_PROVIDER"),
    preset: JevProviderId,
    deleteKey: z.boolean(),
  }),
  z.object({ type: z.literal("PROVIDER_STATUS"), preset: JevProviderId }),
  // The Test-connection action (Phase 3): it carries only the provider id —
  // the model always comes from the stored ProviderSettings, never the
  // message, so the page cannot pick a per-test model or attach key material.
  z.object({ type: z.literal("TEST_PROVIDER"), preset: JevProviderId }),
]);
export type ProviderMessage = z.infer<typeof ProviderMessage>;

/** Machine-readable failure codes for the provider protocol. The
 * `JevConnectionError`/`JevClientError` surface —
 * `auth`/`incompatible`/`retry_later`/`timeout`/`invalid_response`/
 * `answer_mismatch`/`model_mismatch`/`too_large`/`invalid_request`/
 * `http_error` plus the `NetworkGateError` codes it relays (`https_only`,
 * `unlisted_origin`, `no_consent`, `no_permission`, `no_key`, `aborted`,
 * `transport`,
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
  "aborted",
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
 * What Options needs to restore its UI for one provider. `enabled` requires
 * all three: stored settings, a current `jev_test` consent grant, and the
 * host permission still held — so a permission removed outside the app flips
 * it to false. `model`/`keySuffix` are the masked display hints; `origin`
 * and `baseUrl` describe the resolved endpoint (presets report their
 * registry origin; `baseUrl` only appears for the custom provider). Raw key
 * material is never part of any response.
 */
export const ProviderStatus = z.object({
  enabled: z.boolean(),
  consentGranted: z.boolean(),
  model: z.string().optional(),
  keySuffix: z.string().optional(),
  origin: z.string().optional(),
  baseUrl: z.string().optional(),
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
 *
 * The page's own URL can carry a panel hash — `options.html#permissions` is
 * what the redesigned shell writes, and Chrome reports a hashed URL verbatim
 * in `sender.url`, so an exact string match would refuse every message after
 * a reload of a hashed page. Compare protocol/host/path instead; the hash and
 * any query string are ignored.
 */
function isTrustedOptionsSender(sender: ProviderMessageSender): boolean {
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

/**
 * The destination a provider id would egress to today: presets always
 * resolve through the registry (so their permission/consent state is still
 * reported with no settings row), `custom` resolves only while a valid
 * settings row exists — without one there is no origin to check and the
 * status is simply "nothing configured".
 */
async function destinationFor(
  providerId: JevProviderId,
  settings: ProviderSettings | null,
): Promise<JevDestination | null> {
  if (settings !== null) {
    return resolveJevDestination(settings);
  }
  return providerId === "custom" ? null : presetJevDestination(providerId);
}

/** Compose the status Options renders: enabled needs settings AND consent
 * AND a still-held host permission. Settings rows are re-validated because
 * `metadata.value` is untyped at storage. */
async function readStatus(providerId: JevProviderId): Promise<ProviderStatus> {
  const settings = await readJevProvider(providerId);
  const destination = await destinationFor(providerId, settings);
  const [consentGranted, permissionGranted] =
    destination === null
      ? [false, false]
      : await Promise.all([
          hasConsentAtOrigin(CONSENT_SCOPE, destination.origin),
          hasOriginPermission(destination.permissionPattern),
        ]);
  const status: ProviderStatus = {
    enabled: consentGranted && permissionGranted && settings !== null,
    consentGranted,
  };
  if (settings !== null) {
    status.model = settings.model;
    status.keySuffix = settings.keySuffix;
    if (settings.preset === "custom") {
      status.baseUrl = settings.baseUrl;
    }
  }
  if (destination !== null) {
    status.origin = destination.origin;
  }
  return status;
}

/**
 * The provider state a failed enable must restore (H01): the settings row,
 * the credential plaintext, and whether this flow's consent scope already
 * held a grant at the resolved origin — all captured BEFORE the first
 * write. A credential that cannot be read (missing or undecryptable) snaps
 * as `null` and the restore drops whatever the attempt left behind.
 */
interface EnableSnapshot {
  readonly settingsRow: { key: string; value: unknown } | undefined;
  readonly keyPlaintext: string | null;
  readonly consented: boolean;
}

async function snapshotEnable(
  providerId: string,
  origin: string,
): Promise<EnableSnapshot> {
  const [settingsRow, keyPlaintext, consented] = await Promise.all([
    db.metadata.get(providerId).catch(() => undefined),
    readProviderKey(providerId).catch(() => null),
    hasConsentAtOrigin(CONSENT_SCOPE, origin).catch(() => false),
  ]);
  return { settingsRow, keyPlaintext, consented };
}

/**
 * Undo a partial enable so a provider can never appear enabled with missing
 * consent (H01). Rather than deleting unconditionally, each written piece
 * is restored to its pre-attempt state: the settings row goes back (or is
 * dropped when none existed), the credential is re-saved (or dropped when
 * none existed), and the consent row is deleted only when this attempt
 * created it — a prior grant at the origin, and every other consent scope
 * the origin holds, survive the failed enable.
 */
async function unwindEnable(
  providerId: string,
  origin: string,
  prior: EnableSnapshot,
): Promise<void> {
  await Promise.allSettled([
    prior.settingsRow === undefined
      ? db.metadata.delete(providerId)
      : db.metadata.put(prior.settingsRow),
    prior.keyPlaintext === null
      ? deleteProviderKey(providerId)
      : saveProviderKey(providerId, prior.keyPlaintext),
    prior.consented
      ? Promise.resolve()
      : revokeConsentAtOrigin(CONSENT_SCOPE, origin),
  ]);
}

async function enableProvider(message: {
  preset: JevProviderId;
  model: string;
  key: string;
  baseUrl?: string;
}): Promise<ProviderMessageResult> {
  // Re-validate the full settings shape in the worker — the page's fields
  // are not trusted. For presets this pins model to the preset allowlist;
  // for `custom` it re-checks the canonical base URL and a non-empty model.
  const settingsInput =
    message.preset === "custom"
      ? {
          preset: "custom" as const,
          baseUrl: message.baseUrl,
          model: message.model,
          keySuffix: keyDisplaySuffix(message.key),
        }
      : {
          preset: message.preset,
          model: message.model,
          keySuffix: keyDisplaySuffix(message.key),
        };
  const parsed = ProviderSettings.safeParse(settingsInput);
  if (!parsed.success) {
    return message.preset === "custom"
      ? failure(
          "malformed_message",
          "The custom provider settings are invalid — the base URL must be a canonical https (or loopback http) API root and the model id must be non-empty.",
        )
      : failure(
          "unlisted_model",
          `Model "${message.model}" is not offered by preset "${message.preset}".`,
        );
  }
  const settings = parsed.data;
  const destination = resolveJevDestination(settings);

  // The Options page already prompted via chrome.permissions.request; the
  // worker re-verifies the grant rather than trusting the message.
  if (!(await hasOriginPermission(destination.permissionPattern))) {
    return failure(
      "no_permission",
      `The host permission for ${destination.origin} was not granted; the provider was not enabled.`,
    );
  }

  // Snapshot the provider's current state before the first write: a
  // re-enable of a working provider must restore it on failure, not strip
  // it (H01).
  const prior = await snapshotEnable(
    destination.providerId,
    destination.origin,
  );

  try {
    await db.metadata.put({ key: destination.providerId, value: settings });
    await saveProviderKey(destination.providerId, message.key);
    // The consent row is written last so nothing is "enabled" until every
    // piece landed. Consent keys off the resolved origin: reconfiguring the
    // custom provider to a different origin grants at the new origin, and
    // per-origin consent records mean a later switch back resumes exactly
    // what the user had consented to there.
    await grantConsentAtOrigin(CONSENT_SCOPE, destination.origin);
  } catch {
    await unwindEnable(destination.providerId, destination.origin, prior);
    return failure(
      "enable_failed",
      "Setup could not finish; nothing was saved and the provider was not enabled.",
    );
  }
  return { ok: true, status: await readStatus(destination.providerId) };
}

async function revokeProvider(message: {
  preset: JevProviderId;
  deleteKey: boolean;
}): Promise<ProviderMessageResult> {
  const settings = await readJevProvider(message.preset);
  const destination = await destinationFor(message.preset, settings);

  // Consent comes off first: if permission removal then fails, the gate still
  // blocks every request because no current consent row remains. Revoking
  // deletes every scope the origin holds (`jev_test`, `jev_decisions`, and
  // `jev_summary_verify`), not just the synthetic test grant. A `custom`
  // provider whose row is already gone/invalid has no resolvable origin —
  // its consent rows, if any, die with the settings row below.
  if (destination !== null) {
    try {
      await revokeConsentsAtOrigin(destination.origin);
    } catch {
      return failure(
        "revoke_failed",
        "The recorded consent could not be removed; nothing else was changed.",
      );
    }
  }

  const failures: string[] = [];
  if (destination !== null) {
    try {
      const removed = await chrome.permissions.remove({
        origins: [destination.permissionPattern],
      });
      // `remove` can report false (e.g. the grant was already gone); count
      // the step as done only when the permission is not held afterwards.
      const released =
        removed === true ||
        !(await hasOriginPermission(destination.permissionPattern));
      if (!released) failures.push("browser permission");
    } catch {
      failures.push("browser permission");
    }
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
 * Run the synthetic Jev connection test for a fully enabled provider — the
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
  preset: JevProviderId;
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
