import { hasConsent, type ConsentScope } from "../consent/records";
import { readBlocklist } from "../decisions/blocklist";
import { isSensitiveUrl } from "../decisions/minimize";
import { makeSyntheticRequest, SystemOneRequest } from "../jev/wire";
import { DecisionState } from "../schemas/decision-state";
import { SummaryVerificationState } from "../schemas/summary-verification";
import type { PresetId } from "../schemas/provider";
import { readProviderKey } from "../security/keys";
import { resolvePreset, type PresetDestination } from "./presets";
import { appendSentLog } from "./sent-log";

/**
 * The extension's single consented egress point (PROJECT_PLAN.md §Global
 * Constraints): this module is the only `src/` code allowed to call `fetch`
 * (enforced by eslint). It reaches only the fixed `PRESETS` destinations, and
 * only after the scope's request guard, the versioned consent grant, the
 * Chrome host permission, and stored key material all check out — re-verified
 * on every call. The `jev_test` scope's guard admits nothing but the fixed
 * synthetic request, so test consent can never carry bookmark content; the
 * `jev_decisions` scope's guard strict-parses the request state against the
 * closed `DecisionState` schema and refuses unknown fields, uncleaned URLs
 * (query/fragment/userinfo), and blocklisted URLs.
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
  readonly admits: (
    request: unknown,
    model: string,
    userBlocklist: readonly string[],
  ) => boolean;
}

/**
 * Every URL-bearing field of a parsed `DecisionState`, in a stable order, so
 * the guard runs the blocklist over the whole state — not just the primary
 * `bookmark`. `candidateBookmarks` may hold many; `pairPartner` carries the
 * second bookmark of a near-duplicate pair.
 */
function decisionStateUrls(state: DecisionState): string[] {
  const urls: string[] = [];
  if (state.bookmark !== undefined) {
    urls.push(state.bookmark.url);
  }
  if (state.pairPartner !== undefined) {
    urls.push(state.pairPartner.url);
  }
  for (const candidate of state.candidateBookmarks ?? []) {
    urls.push(candidate.url);
  }
  return urls;
}

/**
 * The `jev_decisions` request guard: strict-parse the request's `state`
 * against the closed `DecisionState` schema — refusing unknown fields and any
 * URL that is not already cleaned (a query, fragment, or userinfo fails
 * `CleanedUrl`) — then run every URL-bearing field through the sensitive-site
 * blocklist (the built-in list AND the user's own persisted blocklist, so ANY
 * caller is covered even if a service-level check is bypassed). Also pins the
 * request's `model` to the allowlist-checked `model` argument, so the model
 * the gate vetted is the model that is serialized (mirroring `jev_test`'s
 * deep-equal guard). Fails closed: a non-object request, a `model` mismatch, a
 * missing/!DecisionState state, or any blocklisted URL is refused. Runs before
 * the wire-schema parse and before any consent, permission, or key read.
 */
function admitsDecisionState(
  request: unknown,
  model: string,
  userBlocklist: readonly string[],
): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const candidate = request as { model?: unknown; state?: unknown };
  if (candidate.model !== model) {
    return false;
  }
  const parsed = DecisionState.safeParse(candidate.state);
  if (!parsed.success) {
    return false;
  }
  return decisionStateUrls(parsed.data).every(
    (url) => !isSensitiveUrl(url, userBlocklist),
  );
}

/**
 * The `jev_summary_verify` request guard (spec FR10): strict-parse the
 * request's `state` against the closed `SummaryVerificationState` schema —
 * the only state shape page text may travel in — refusing unknown fields
 * (notes can never arrive here) and any uncleaned or blocklisted
 * `bookmark.url`. Model pin identical to `jev_decisions`. Fails closed,
 * before consent/permission/key reads.
 */
function admitsSummaryVerifyState(
  request: unknown,
  model: string,
  userBlocklist: readonly string[],
): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const candidate = request as { model?: unknown; state?: unknown };
  if (candidate.model !== model) {
    return false;
  }
  const parsed = SummaryVerificationState.safeParse(candidate.state);
  if (!parsed.success) {
    return false;
  }
  return !isSensitiveUrl(parsed.data.bookmark.url, userBlocklist);
}

/**
 * The frozen scope registry. `jev_test` admits exactly one payload: a
 * request deep-equal to `makeSyntheticRequest(model)`, so no caller-supplied
 * state, questions, or headers can leave under test consent. `jev_decisions`
 * admits only a request whose `model` equals the allowlist-checked `model`
 * argument and whose `state` strict-parses as a `DecisionState` with every
 * URL already cleaned and off the sensitive-site blocklist.
 * `jev_summary_verify` admits the same envelope whose state strict-parses
 * as a `SummaryVerificationState` (spec FR10's page-text-carrying request).
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
    admits: admitsDecisionState,
  } satisfies ScopeRegistration),
  jev_summary_verify: Object.freeze({
    scope: "jev_summary_verify" as ConsentScope,
    admits: admitsSummaryVerifyState,
  } satisfies ScopeRegistration),
} satisfies Record<
  "jev_test" | "jev_decisions" | "jev_summary_verify",
  ScopeRegistration
>);

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

  // Defense-in-depth: re-read the user's persisted blocklist on every call so
  // ANY `jev_decisions` caller is covered, even if a service-level check were
  // bypassed. `readBlocklist` fails closed to `[]`, so a broken lookup can
  // never block every send.
  const userBlocklist = await readBlocklist();
  if (!scopeEntry.admits(request, model, userBlocklist)) {
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
  // `appendSentLog` also enforces the retention cap (see `./sent-log.ts`).
  await appendSentLog({
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
