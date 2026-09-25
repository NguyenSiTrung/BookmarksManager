import {
  grantTestConsent,
  hasTestConsent,
  revokeTestConsent,
} from "../consent/records";
import { db } from "../db/database";
import { resolvePreset } from "../net/presets";
import { PresetId, ProviderSettings } from "../schemas/provider";
import { z } from "../schemas/z";
import { deleteProviderKey, saveProviderKey } from "../security/keys";

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
]);
export type ProviderMessage = z.infer<typeof ProviderMessage>;

/** Machine-readable failure codes for the provider protocol. */
export const ProviderErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "unlisted_model",
  "no_permission",
  "enable_failed",
  "revoke_failed",
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

/** Every worker response is one of these two shapes. */
export const ProviderMessageResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: ProviderStatus }),
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
    keySuffix: message.key.slice(-4),
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
    }
  } catch {
    return failure(
      "internal_error",
      "The provider request failed unexpectedly; nothing was changed on purpose.",
    );
  }
}
