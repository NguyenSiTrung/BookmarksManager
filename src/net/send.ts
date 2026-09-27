import { hasConsent, type ConsentScope } from "../consent/records";
import { db } from "../db/database";
import { makeSyntheticRequest, SystemOneRequest } from "../jev/wire";
import type { PresetId } from "../schemas/provider";
import { readProviderKey } from "../security/keys";
import { resolvePreset, type PresetDestination } from "./presets";

/**
 * The extension's single consented egress point (PROJECT_PLAN.md §Global
 * Constraints): this module is the only `src/` code allowed to call `fetch`
 * (enforced by eslint). It reaches only the fixed `PRESETS` destinations, and
 * only after the scope's request guard, the versioned consent grant, the
 * Chrome host permission, and stored key material all check out — re-verified
 * on every call. The `jev_test` scope's guard admits nothing but the fixed
 * synthetic request, so test consent can never carry bookmark content; the
 * `jev_decisions` scope is registered fail-closed until Phase 2 Task 2 adds
 * its strict `DecisionState` guard.
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
 * transport failures. HTTP status mapping is the client's job, not the
 * gate's. */
export type NetworkGateErrorCode =
  | "unregistered_scope"
  | "request_not_allowed"
  | "unlisted_model"
  | "https_only"
  | "unlisted_origin"
  | "no_consent"
  | "no_permission"
  | "no_key"
  | "timeout"
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
 * Structural equality over JSON values — the scope guard compares an inbound
 * request against a freshly built synthetic request key-by-key so key order
 * in the caller's object cannot matter.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepEqual(value, (b as unknown[])[index]))
    );
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    )
  );
}

/**
 * A registered consent scope: the canonical scope id used for consent reads
 * and the sentLog `feature` field, plus the request guard that decides which
 * payloads this scope may carry. The guard is re-evaluated on every call and
 * runs before any consent, permission, or key read.
 */
interface ScopeRegistration {
  readonly scope: ConsentScope;
  readonly admits: (request: unknown, model: string) => boolean;
}

/**
 * The frozen scope registry. `jev_test` admits exactly one payload: a
 * request deep-equal to `makeSyntheticRequest(model)`, so no caller-supplied
 * state, questions, or headers can leave under test consent. `jev_decisions`
 * is registered **fail-closed**: Phase 2 Task 2 replaces this placeholder
 * guard with the strict `DecisionState` guard, and until then no
 * `jev_decisions` request is admitted.
 */
const SCOPES = Object.freeze({
  jev_test: Object.freeze({
    scope: "jev_test" as ConsentScope,
    admits(request: unknown, model: string): boolean {
      return deepEqual(request, makeSyntheticRequest(model));
    },
  } satisfies ScopeRegistration),
  jev_decisions: Object.freeze({
    scope: "jev_decisions" as ConsentScope,
    // Phase 2 Task 2 replaces this with the strict DecisionState guard.
    admits(): boolean {
      return false;
    },
  } satisfies ScopeRegistration),
} satisfies Record<ConsentScope, ScopeRegistration>);

function resolveScope(scope: string): ScopeRegistration {
  const entry = (SCOPES as Record<string, ScopeRegistration | undefined>)[
    scope
  ];
  if (entry === undefined) {
    throw new NetworkGateError(
      "unregistered_scope",
      `Scope "${scope}" is not a registered consent scope.`,
    );
  }
  return entry;
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

function isAbortError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Send a scoped, consented request to a preset destination.
 *
 * Gate order (all before any network activity): registered scope → valid
 * preset → model is in the preset allowlist → URL is `https:` with an origin
 * equal to the registry origin → the scope's request guard admits the exact
 * payload → the body parses as a `SystemOneRequest` → current versioned
 * consent for (scope, origin) → Chrome host permission → stored provider
 * key. Only then is `fetch` invoked with `credentials: "omit"` (no cookies)
 * and `redirect: "error"` (redirects refused); auth is exactly
 * `Authorization: Bearer <key>` plus `Content-Type: application/json`.
 *
 * `options.signal` is forwarded to `fetch`; an aborted (or pre-aborted) send
 * maps to `timeout` and writes no log row. Resolves with the raw `Response`
 * for any HTTP status; throws `NetworkGateError` for every pre-flight
 * refusal and transport failure, and propagates `ProviderKeyError` (already
 * redacted) as-is. A `sentLog` audit row — time, origin, feature, and
 * top-level field names only — is appended after `fetch` resolves; a
 * rejected or aborted fetch logs nothing.
 */
export async function sendConsented(
  scope: string,
  preset: PresetId,
  model: string,
  request: unknown,
  options?: { signal?: AbortSignal },
): Promise<Response> {
  const scopeEntry = resolveScope(scope);
  const destination = resolvePreset(preset);

  if (!destination.models.includes(model)) {
    throw new NetworkGateError(
      "unlisted_model",
      `Model "${model}" is not in the allowlist for preset "${preset}".`,
    );
  }

  assertPresetUrl(destination);

  if (!scopeEntry.admits(request, model)) {
    throw new NetworkGateError(
      "request_not_allowed",
      `Scope "${scope}" does not admit this request payload.`,
    );
  }

  // The guard constrained the payload but did not parse it — a malformed
  // body still cannot leave the extension.
  const parsed = SystemOneRequest.safeParse(request);
  if (!parsed.success) {
    throw new NetworkGateError(
      "request_not_allowed",
      `Scope "${scope}" request is not a valid System One payload.`,
    );
  }

  if (!(await hasConsent(scopeEntry.scope, preset))) {
    throw new NetworkGateError(
      "no_consent",
      `No current ${scopeEntry.scope} consent grant for preset "${preset}".`,
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

  const signal = options?.signal;
  if (signal?.aborted === true) {
    throw new NetworkGateError(
      "timeout",
      `Outbound ${scopeEntry.scope} request for preset "${preset}" was aborted before it left.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(destination.url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: signal ?? null,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.data),
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      throw new NetworkGateError(
        "timeout",
        `Outbound ${scopeEntry.scope} request for preset "${preset}" was aborted.`,
      );
    }
    throw new NetworkGateError(
      "transport",
      `Outbound ${scopeEntry.scope} request for preset "${preset}" failed in transport.`,
      { cause },
    );
  }

  // The request left the extension — record the audit row before inspecting
  // the response. Only metadata is stored: never bodies, headers, or keys.
  await db.sentLog.add({
    sentAt: new Date().toISOString(),
    destination: destination.origin,
    feature: scopeEntry.scope,
    fieldNames: Object.keys(parsed.data),
  });

  if (response.type === "opaqueredirect") {
    throw new NetworkGateError(
      "transport",
      `Outbound ${scopeEntry.scope} request for preset "${preset}" answered with an opaque redirect.`,
    );
  }

  return response;
}

/**
 * Send the fixed synthetic `jev_test` request to a preset destination — a
 * thin wrapper over `sendConsented` under the only registered scope, kept
 * for the existing Options Test-connection callers.
 */
export async function sendConsentedTest(
  preset: PresetId,
  model: string,
): Promise<Response> {
  return sendConsented("jev_test", preset, model, makeSyntheticRequest(model));
}
