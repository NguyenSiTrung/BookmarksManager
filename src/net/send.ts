import { hasTestConsent } from "../consent/records";
import { db } from "../db/database";
import { makeSyntheticRequest, SystemOneRequest } from "../jev/wire";
import type { PresetId } from "../schemas/provider";
import { readProviderKey } from "../security/keys";
import { resolvePreset, type PresetDestination } from "./presets";

/**
 * The extension's single consented egress point (PROJECT_PLAN.md §Global
 * Constraints): this module is the only `src/` code allowed to call `fetch`
 * (enforced by eslint). It reaches only the fixed `PRESETS` destinations, and
 * only after the versioned `jev_test` consent grant, the Chrome host
 * permission, and stored key material all check out — re-verified on every
 * call. Phase 3 builds the Jev wire layer on `sendConsentedTest`; the Options
 * Test-connection button is the only UX that reaches it.
 *
 * `chrome` is provided by the extension runtime; as in `security/keys.ts`,
 * only the used slice is declared so access stays lazy and
 * `vi.stubGlobal("chrome", ...)` works in tests.
 */
declare const chrome: {
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
  };
};

/** Machine-readable rejection reasons for the gate's pre-flight and
 * transport failures. HTTP status mapping is Phase 3's job, not the gate's. */
export type NetworkGateErrorCode =
  | "unlisted_model"
  | "https_only"
  | "unlisted_origin"
  | "no_consent"
  | "no_permission"
  | "no_key"
  | "transport";

/**
 * Every way the gate can refuse a send. Messages are deliberately redacted:
 * they never carry key material, request bodies, or response bodies.
 */
export class NetworkGateError extends Error {
  readonly code: NetworkGateErrorCode;

  constructor(
    code: NetworkGateErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NetworkGateError";
    this.code = code;
  }
}

/**
 * Defense-in-depth on the registry entry itself: even though `PRESETS` is
 * frozen, refuse any destination that is not a valid `https:` URL whose
 * origin is exactly the registry's recorded origin.
 */
function assertPresetUrl(destination: PresetDestination): void {
  let url: URL;
  try {
    url = new URL(destination.url);
  } catch (cause) {
    throw new NetworkGateError(
      "https_only",
      "Preset destination is not a valid absolute URL.",
      { cause },
    );
  }
  if (url.protocol !== "https:") {
    throw new NetworkGateError(
      "https_only",
      "Preset destination must be an https: URL.",
    );
  }
  if (url.origin !== destination.origin) {
    throw new NetworkGateError(
      "unlisted_origin",
      "Preset destination URL does not match its registered origin.",
    );
  }
}

/** Fail-closed permission check: any API error counts as "not granted". */
async function hasOriginPermission(permissionPattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      origins: [permissionPattern],
    });
  } catch {
    return false;
  }
}

/**
 * Send the fixed synthetic `jev_test` request to a preset destination.
 *
 * Gate order (all before any network activity): valid preset → model is in
 * the preset allowlist → URL is `https:` with an origin equal to the
 * registry origin → current versioned `jev_test` consent → Chrome host
 * permission for the preset's pattern → stored provider key. Only then is
 * `fetch` invoked with `credentials: "omit"` (no cookies) and
 * `redirect: "error"` (redirects refused); auth is exactly
 * `Authorization: Bearer <key>` plus `Content-Type: application/json`.
 *
 * Resolves with the raw `Response` for any HTTP status; throws
 * `NetworkGateError` for every pre-flight refusal and transport failure,
 * and propagates `ProviderKeyError` (already redacted) as-is. A `sentLog`
 * audit row — time, origin, feature, and top-level field names only — is
 * appended after `fetch` resolves; a rejected fetch logs nothing.
 */
export async function sendConsentedTest(
  preset: PresetId,
  model: string,
): Promise<Response> {
  const destination = resolvePreset(preset);

  if (!destination.models.includes(model)) {
    throw new NetworkGateError(
      "unlisted_model",
      `Model "${model}" is not in the allowlist for preset "${preset}".`,
    );
  }

  assertPresetUrl(destination);

  if (!(await hasTestConsent(preset))) {
    throw new NetworkGateError(
      "no_consent",
      `No current jev_test consent grant for preset "${preset}".`,
    );
  }

  if (!(await hasOriginPermission(destination.permissionPattern))) {
    throw new NetworkGateError(
      "no_permission",
      `Missing host permission for preset "${preset}".`,
    );
  }

  const key = await readProviderKey(preset);
  if (key === null) {
    throw new NetworkGateError(
      "no_key",
      `No stored provider key for preset "${preset}".`,
    );
  }

  // The synthetic body lives in the Jev wire layer; parse it through the
  // §8.2 schema so a malformed request fails before egress, never after.
  const request = SystemOneRequest.parse(makeSyntheticRequest(model));
  let response: Response;
  try {
    response = await fetch(destination.url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    throw new NetworkGateError(
      "transport",
      `Outbound jev_test request for preset "${preset}" failed in transport.`,
      { cause },
    );
  }

  // The request left the extension — record the audit row before inspecting
  // the response. Only metadata is stored: never bodies, headers, or keys.
  await db.sentLog.add({
    sentAt: new Date().toISOString(),
    destination: destination.origin,
    feature: "jev_test",
    fieldNames: Object.keys(request),
  });

  if (response.type === "opaqueredirect") {
    throw new NetworkGateError(
      "transport",
      `Outbound jev_test request for preset "${preset}" answered with an opaque redirect.`,
    );
  }

  return response;
}
