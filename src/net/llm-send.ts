import { beginSentLog } from "./sent-log";
import { classifyAbort } from "./abort";
import { parseRetryAfter, retryDelay } from "../jev/retry";
import {
  hasConsentAtOrigin,
  type ConsentScope,
} from "../consent/records";
import { readLlmProvider } from "../llm/settings";
import {
  reconcileBudget,
  releaseBudget,
  reserveBudget,
  type ActualUsage,
  type BudgetReservation,
  type RequestKind,
} from "../llm/budget";
import { resolveLlmDestination } from "../llm/providers";
import { resolveProviderPricing } from "../llm/pricing";
import { ChatCompletionRequest, ChatCompletionResponse, TokenBound, firstText } from "../llm/wire";
import {
  FEATURE_CONTRACTS, jsonSchemaOf, tierSystemPrompt, pingRequest,
  repairForResponse, MAX_REPAIRS, type FeatureScope,
} from "../llm/prompt-contracts";
import { z } from "../schemas/z";
import { readCredential } from "../security/credentials";
import { db } from "../db/database";
import { BlocklistReadError, readBlocklist } from "../decisions/blocklist";
import { isSensitiveUrl } from "../decisions/minimize";

/**
 * `chrome` is provided by the extension runtime; as in `net/send.ts`,
 * only the used slice is declared so access stays lazy and
 * `vi.stubGlobal("chrome", ...)` works in tests.
 */
declare const chrome: {
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
  };
};

/**
 * Refusal codes the LLM gate can produce. Every pre-flight failure is one of
 * these — never a raw error — so callers can surface a stable reason without
 * leaking internals.
 */
export type LlmGateCode =
  | "unregistered_scope"
  | "no_provider"
  | "invalid_provider"
  | "request_not_allowed"
  | "unlisted_model"
  | "no_consent"
  | "no_permission"
  | "no_key"
  | "pricing_required"
  | "confirmation_required"
  | "budget_exceeded"
  | "timeout"
  | "aborted"
  | "transport";

export class LlmGateError extends Error {
  readonly code: LlmGateCode;
  constructor(
    code: LlmGateCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmGateError";
    this.code = code;
  }
}

/** What a gated LLM request declares up front. */
export interface LlmSendInput {
  /** The stored provider record id (`preset:<id>` or `custom:<baseUrl>`). */
  readonly providerId: string;
  /** An LLM consent scope — Jev verification never authorizes LLM egress. */
  readonly scope: ConsentScope;
  /** The outbound body; must strict-parse as `ChatCompletionRequest`. */
  readonly request: unknown;
  /** Positive safe-integer token bounds for the budget reservation. */
  readonly maxInputTokens: number;
  /** Gate-owned generation ceiling; a lower request.max_tokens tightens it
   * in both the reservation and every serialized attempt. */
  readonly maxOutputTokens: number;
  /** `automatic` runs under the budget rules only; `manual` may carry the
   *  user's unknown-cost confirmation. */
  readonly kind: RequestKind;
}

export interface LlmSendOptions {
  /** Manual-mode only: user explicitly confirmed a request whose cost cannot
   *  be estimated. Ignored for `automatic` requests. */
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
  /** Wall-clock timeout per attempt (default 30s). */
  readonly timeoutMs?: number;
  /** Extra attempts after a transient failure (default 1). */
  readonly retries?: number;
  readonly now?: () => Date;
  /** Feature admission before EACH fetch attempt, including internal retries.
   * Throw a typed, content-free refusal; this does not bypass the origin gate. */
  readonly beforeSend?: () => Promise<void>;
}

export interface LlmSendResult {
  /** The raw response (any HTTP status — the caller maps non-2xx). */
  readonly response: Response;
  /** The persisted active reservation — settle it via `settleLlmUsage`. */
  readonly reservation: BudgetReservation;
  /** Read the actual response and derive private, input-bound repair authority.
   * There is deliberately no caller-supplied raw-response registration API. */
  readonly readResponse: () => Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
/** Both jitter and Retry-After retain the gate's existing 5-second ceiling. */
const MAX_RETRY_WAIT_MS = 5_000;

/**
 * Historical stale threshold, retained for compatibility. Age alone cannot
 * prove a request was never sent or free: active exposure and its pricing
 * snapshot remain durable until explicit settlement or a never-sent release.
 * In particular, worker eviction must not free paid exposure at this age.
 */
export const STALE_RESERVATION_TTL_MS = 15 * 60_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Shared bounded reader for retry accounting and final error classification. */
const MAX_ERROR_BODY_BYTES = 4096;
export async function readLlmErrorBody(response: Response): Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    reader = response.body?.getReader();
    if (reader === undefined) return null;
    const bytes = new Uint8Array(MAX_ERROR_BODY_BYTES);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      }
      if (value.byteLength > MAX_ERROR_BODY_BYTES - length) return null;
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return null;
  } finally {
    if (reader !== undefined && !completed) {
      try {
        await reader.cancel();
      } catch {
        // Untrusted cancellation failures must never become native causes.
      }
    }
    reader?.releaseLock();
  }
}

const UsageEnvelope = z.object({
  usage: z.object({
    prompt_tokens: z.unknown().optional(),
    completion_tokens: z.unknown().optional(),
    cost: z.unknown().optional(),
  }).optional(),
});
const UsageFields = ChatCompletionResponse.shape.usage.unwrap().shape;

/** Usage fields validate independently; absent/invalid never means zero. */
export function parseLlmUsage(raw: unknown): ActualUsage {
  const parsed = UsageEnvelope.safeParse(raw);
  if (!parsed.success || parsed.data.usage === undefined) return {};
  const usage = parsed.data.usage;
  const input = UsageFields.prompt_tokens.safeParse(usage.prompt_tokens);
  const output = UsageFields.completion_tokens.safeParse(usage.completion_tokens);
  const cost = UsageFields.cost.safeParse(usage.cost);
  return {
    ...(input.success && input.data !== undefined ? { inputTokens: input.data } : {}),
    ...(output.success && output.data !== undefined ? { outputTokens: output.data } : {}),
    ...(cost.success && typeof cost.data === "number" && cost.data >= 0
      ? { reportedCostUsd: cost.data }
      : {}),
  };
}

function isRegisteredScope(scope: string): scope is ConsentScope {
  return scope === "llm_test" || Object.hasOwn(FEATURE_CONTRACTS, scope);
}

interface SendSession {
  binding?: string;
  /** Exact transcripts derived only from consumed, actual provider responses. */
  readonly repairs: Set<string>;
}

function rejectPayload(): never {
  throw new LlmGateError("request_not_allowed", "This scope does not admit the request payload.");
}

/** Stable structural JSON equality, independent of the caller's key order. */
function canonical(value: unknown, depth = 0): string {
  // Schemas are untrusted unknown records at the outer wire boundary. Refuse
  // cyclic/deep/non-JSON values with a redacted gate error, never a native cause.
  if (depth > 32) rejectPayload();
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, depth + 1)}`).join(",")}}`;
  }
  if (value !== null && !["string", "number", "boolean", "undefined"].includes(typeof value)) rejectPayload();
  if (typeof value === "number" && !Number.isFinite(value)) rejectPayload();
  return JSON.stringify(value) ?? "undefined";
}

function admitPayload(
  input: LlmSendInput,
  request: ChatCompletionRequest,
  origin: string,
  userBlocklist: readonly string[],
  session?: SendSession,
): { binding: string; contract?: (typeof FEATURE_CONTRACTS)[FeatureScope] } {
  const tier = request.response_format?.type ?? "prompt_only";
  if (input.scope === "llm_test") {
    const expected = pingRequest(request.model, tier);
    // A gate-supplied or caller-lowered ceiling may only tighten the fixed 16.
    expected.max_tokens = Math.min(16, request.max_tokens ?? 16);
    if (canonical(expected) !== canonical(request)) rejectPayload();
    return { binding: canonical([input.providerId, input.scope, origin, request.model, "ping"]) };
  }
  const contract = FEATURE_CONTRACTS[input.scope as FeatureScope];
  const [system, user] = request.messages;
  if (system?.role !== "system" || user?.role !== "user" ||
      request.messages.length < 2 || request.messages.length > 2 + MAX_REPAIRS * 2 ||
      request.messages.length % 2 !== 0) rejectPayload();
  const schema = jsonSchemaOf(contract.output);
  const augmentation = tierSystemPrompt(tier, schema);
  if (system.content !== (augmentation === null ? contract.prompt : `${augmentation}\n\n${contract.prompt}`)) {
    rejectPayload();
  }
  if (tier === "json_schema" && canonical(request.response_format) !== canonical({
    type: "json_schema", json_schema: { name: contract.name, strict: true, schema },
  })) rejectPayload();
  let payload: unknown;
  try { payload = JSON.parse(user.content); } catch { rejectPayload(); }
  const parsed = contract.payload.safeParse(payload);
  if (!parsed.success) rejectPayload();
  const facts = parsed.data;
  if ("bookmarks" in facts) {
    if (facts.bookmarks.some((bookmark) => isSensitiveUrl(bookmark.url, userBlocklist))) rejectPayload();
  } else if ("url" in facts) {
    if (isSensitiveUrl(facts.url, userBlocklist)) rejectPayload();
  } else {
    for (const { domain } of facts.domains) {
      try {
        const url = new URL(`https://${domain}/`);
        if (url.hostname !== domain || url.pathname !== "/" || url.search !== "" ||
            url.hash !== "" || url.username !== "" || url.password !== "" ||
            isSensitiveUrl(url.href, userBlocklist)) rejectPayload();
      } catch { rejectPayload(); }
    }
  }
  const binding = canonical([
    input.providerId, input.scope, origin, request.model, input.kind,
    input.maxInputTokens, request.max_tokens, parsed.data,
  ]);
  if (session?.binding !== undefined && session.binding !== binding) rejectPayload();
  if (request.messages.length > 2 && !session?.repairs.has(canonical(request))) rejectPayload();
  // Claim synchronously before subsequent awaited consent/permission/budget
  // preflight, so concurrent callers cannot change one session's original input.
  if (session !== undefined) session.binding ??= binding;
  return { binding, contract };
}

/** A client gets private repair provenance, never an injectable transport.
 * Provider and scope are captured and cannot be overridden by runtime input. */
export function createLlmSendSession(providerId: string, scope: ConsentScope): (
  input: Omit<LlmSendInput, "providerId" | "scope">,
  options?: LlmSendOptions,
) => Promise<LlmSendResult> {
  const session: SendSession = { repairs: new Set() };
  return (input, options) => sendLlmRequest({ ...input, providerId, scope }, options, session);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Settle an active reservation with actual usage — reconciles the row
 * (reported cost > configured-rate estimate > unknown) and persists the
 * usage record in one Dexie transaction. Idempotent: a missing or already
 * settled/released reservation is a no-op.
 */
export async function settleLlmUsage(
  reservationId: string,
  feature: ConsentScope,
  usage: ActualUsage,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(
    "rw",
    db.llmReservations,
    db.llmUsage,
    async () => {
      const reservation = await db.llmReservations.get(reservationId);
      if (reservation === undefined || reservation.status !== "active") {
        return;
      }
      const { reservation: settled, usageRow } = reconcileBudget(
        reservation,
        usage,
        now,
      );
      await db.llmReservations.put(settled);
      const { provenance, ...row } = usageRow;
      void provenance; // derivable, never persisted (schemas/usage.ts)
      await db.llmUsage.add({
        ...row,
        feature,
        configuredModel: reservation.model,
      });
    },
  );
}

/**
 * Send a scoped, consented request to the configured LLM provider.
 *
 * Gate order (all before any network activity): registered scope → stored
 * provider record → destination re-resolved and canonical → closed wire
 * schema + configured-model pin + token bounds → current versioned consent at the exact
 * origin → Chrome host permission → stored credential (when auth requires
 * one) → budget reservation persisted as
 * `active`, all inside one `rw` transaction. Only then does `fetch`
 * run — `credentials: "omit"`, `redirect: "error"`, per-attempt timeout, and
 * at most `retries` extra attempts on transport failures and 408/429/5xx
 * (honoring a bounded Retry-After). A `sentLog` metadata row — timestamp,
 * origin, feature, top-level field names, safe outcome — starts at every
 * dispatch without awaiting IO after final admission. Refused/pre-aborted
 * attempts are not logged; failed logging never changes the request result.
 * Feature admission runs before each fetch attempt and propagates
 * its typed refusal unchanged, conservatively settling prior exposure.
 * Gate refusals throw `LlmGateError`; bodies, headers, and credentials never
 * appear in errors.
 */
export async function sendLlmConsented(
  input: LlmSendInput,
  options?: LlmSendOptions,
): Promise<LlmSendResult> {
  return sendLlmRequest(input, options);
}

async function sendLlmRequest(
  input: LlmSendInput,
  options?: LlmSendOptions,
  session?: SendSession,
  retryIndex = 0,
): Promise<LlmSendResult> {
  const now = options?.now ?? (() => new Date());

  if (!isRegisteredScope(input.scope)) {
    throw new LlmGateError(
      "unregistered_scope",
      `Scope "${input.scope}" is not a registered LLM consent scope.`,
    );
  }

  const record = await readLlmProvider(input.providerId);
  if (record === null) {
    throw new LlmGateError(
      "no_provider",
      "No stored LLM provider configuration for this request.",
    );
  }

  let destination;
  try {
    destination = resolveLlmDestination(record.provider);
  } catch (cause) {
    throw new LlmGateError(
      "invalid_provider",
      "Stored provider configuration does not resolve to a valid destination.",
      { cause },
    );
  }
  if (destination.providerId !== record.providerId) {
    throw new LlmGateError(
      "invalid_provider",
      "Provider record id does not match its resolved destination.",
    );
  }

  const parsed = ChatCompletionRequest.safeParse(input.request);
  if (!parsed.success) {
    throw new LlmGateError(
      "request_not_allowed",
      `Scope "${input.scope}" request is not a valid chat-completions payload.`,
    );
  }
  if (parsed.data.model !== destination.model) {
    throw new LlmGateError(
      "unlisted_model",
      "Request model does not match the provider's configured model.",
    );
  }
  if (
    !TokenBound.safeParse(input.maxInputTokens).success ||
    !TokenBound.safeParse(input.maxOutputTokens).success
  ) {
    throw new LlmGateError(
      "request_not_allowed",
      "Request token bounds must be positive safe integers.",
    );
  }
  const maxOutputTokens = Math.min(
    parsed.data.max_tokens ?? input.maxOutputTokens,
    input.maxOutputTokens,
  );
  // Validate the caller's closed payload before adding a gate-owned control.
  // Never mutate the caller or allow another limit key to evade this ceiling.
  const request = { ...parsed.data, max_tokens: maxOutputTokens };

  // Independent of feature admission: an unreadable privacy policy refuses
  // every attempt, including internal retries, before credentials or budget.
  let userBlocklist: string[];
  try {
    userBlocklist = await readBlocklist();
  } catch (cause) {
    if (!(cause instanceof BlocklistReadError)) throw cause;
    throw new LlmGateError("request_not_allowed", cause.message);
  }
  const admission = admitPayload(input, request, destination.origin, userBlocklist, session);

  if (!(await hasConsentAtOrigin(input.scope, destination.origin))) {
    throw new LlmGateError(
      "no_consent",
      `No current ${input.scope} consent grant at the configured origin.`,
    );
  }

  if (!(await hasOriginPermission(destination.permissionPattern))) {
    throw new LlmGateError(
      "no_permission",
      "Missing host permission for the configured origin.",
    );
  }

  let key: string | null = null;
  if (destination.auth !== "none") {
    key = await readCredential(record.providerId);
    if (key === null) {
      throw new LlmGateError(
        "no_key",
        "No stored credential for the configured LLM provider.",
      );
    }
  }

  // Budget: the reservation is persisted BEFORE any network activity so a
  // crash mid-request cannot spend unrecorded. Manual requests may carry the
  // user's unknown-cost confirmation; automatic ones cannot.
  //
  // The whole read → check → write runs inside ONE Dexie `rw`
  // transaction — IndexedDB serializes `rw` transactions on these stores,
  // so two parallel sends (a `library_scan` batch fanning out) can never
  // each pass the cap check against the other's pre-reservation state and
  // overshoot the monthly cap together (TOCTOU). Never reap active rows by
  // age: an orphaned request may have incurred cost and a late response must
  // still be able to settle honestly and exactly once.
  const unknownCostConfirmed =
    input.kind === "manual" && options?.unknownCostConfirmed === true;
  const reservationId = crypto.randomUUID();
  const reservationResult = await db.transaction(
    "rw",
    db.llmUsage,
    db.llmReservations,
    async () => {
      const [usageRows, reservationRows] = await Promise.all([
        db.llmUsage.where("providerId").equals(record.providerId).toArray(),
        db.llmReservations
          .where("providerId")
          .equals(record.providerId)
          .toArray(),
      ]);
      const nowDate = now();
      const pricing = resolveProviderPricing(record.provider);
      const result = reserveBudget({
        reservationId,
        providerId: record.providerId,
        model: destination.model,
        maxInputTokens: input.maxInputTokens,
        maxOutputTokens,
        ...(pricing !== undefined ? { pricing } : {}),
        kind: input.kind,
        ...(record.monthlyBudgetUsd !== undefined
          ? { monthlyBudgetUsd: record.monthlyBudgetUsd }
          : {}),
        usage: usageRows,
        reservations: reservationRows,
        now: nowDate,
        unknownCostConfirmed,
      });
      if (result.status === "reserved") {
        await db.llmReservations.put(result.reservation);
      }
      return result;
    },
  );

  // Refusals throw AFTER the transaction.
  if (reservationResult.status === "refused") {
    throw new LlmGateError(
      reservationResult.reason,
      `The request was refused by the monthly budget (${reservationResult.reason}).`,
    );
  }
  if (reservationResult.status === "confirmation_required") {
    throw new LlmGateError(
      "confirmation_required",
      "This request needs an explicit unknown-cost confirmation.",
    );
  }
  const reservation = reservationResult.reservation;

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (destination.auth === "bearer") {
    headers.Authorization = `Bearer ${key}`;
  } else if (destination.auth === "api-key") {
    headers["api-key"] = key!;
  }
  const body = JSON.stringify(request);

  // One durable reservation per attempt. Prior attempts are already settled
  // when the full gate reserves again, so both budget and current admission
  // include their exposure. Keep the normalized, clamped request immutable.
  const retry = () => sendLlmRequest(
    { ...input, request, maxInputTokens: reservation.maxInputTokens, maxOutputTokens },
    { ...options, retries: retries - 1 },
    session,
    retryIndex + 1,
  );
  try {
    await options?.beforeSend?.();
  } catch (cause) {
    await db.llmReservations.put(releaseBudget(reservation, now()));
    throw cause;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal !== undefined
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  if (signal.aborted) {
    await db.llmReservations.put(releaseBudget(reservation, now()));
    throw new LlmGateError(classifyAbort(signal)!, "Outbound LLM request was aborted before dispatch.");
  }
  // No awaited bookkeeping between final feature admission and fetch.
  const finishLog = beginSentLog({
    sentAt: now().toISOString(),
    destination: destination.origin,
    feature: input.scope,
    fieldNames: Object.keys(request),
  });
  let response: Response;
  try {
    response = await fetch(destination.chatCompletionsUrl, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal,
      headers,
      body,
    });
  } catch (cause) {
    // Capture at transport failure, not after awaited settlement: a deadline
    // expiring during bookkeeping must not relabel an earlier socket failure.
    const abortCode = classifyAbort(signal, cause);
    await settleLlmUsage(reservation.id, input.scope, {}, now());
    if (cause instanceof LlmGateError) {
      await finishLog("transport");
      throw cause;
    }
    if (abortCode !== undefined) {
      await finishLog("timeout");
      throw new LlmGateError(abortCode, abortCode === "timeout"
        ? "Outbound LLM request timed out." : "Outbound LLM request was aborted.");
    }
    if (retries > 0) {
      await finishLog("retried");
      await sleep(retryDelay(retryIndex, { maxMs: MAX_RETRY_WAIT_MS }));
      return retry();
    }
    await finishLog("transport");
    throw new LlmGateError("transport", "Outbound LLM request failed in transport.");
  }

  if (response.type === "opaqueredirect") {
    await settleLlmUsage(reservation.id, input.scope, {}, now());
    await finishLog("redirect");
    throw new LlmGateError("transport", "Outbound LLM request answered with an opaque redirect.");
  }
  if (RETRYABLE_STATUS.has(response.status) && retries > 0) {
    const text = await readLlmErrorBody(response);
    let usage: ActualUsage = {};
    if (text !== null) {
      try {
        usage = parseLlmUsage(JSON.parse(text));
      } catch {
        // A malformed retry body leaves conservative unknown usage.
      }
    }
    await settleLlmUsage(reservation.id, input.scope, usage, now());
    await finishLog("retried");
    const wait = retryDelay(retryIndex, {
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now().getTime()),
      maxMs: MAX_RETRY_WAIT_MS,
    });
    if (wait > 0) await sleep(wait);
    return retry();
  }

  await finishLog(response.ok ? "ok" : `http_${response.status}`);
  // Bind the reader now, before exposing Response to the client/caller.
  // Supplying a fabricated parsed result cannot register a repair transcript.
  const readJson = response.json.bind(response);
  return { response, reservation, readResponse: async () => {
    const raw: unknown = await readJson();
    if (session !== undefined && admission.contract !== undefined && response.status < 400 &&
        request.messages.length < 2 + MAX_REPAIRS * 2) {
      const parsedResponse = ChatCompletionResponse.safeParse(raw);
      if (parsedResponse.success) {
        const repair = repairForResponse(admission.contract.output, firstText(parsedResponse.data));
        if (repair !== null) {
          const next = { ...request, messages: [...request.messages,
            { role: "assistant", content: repair.echo },
            { role: "user", content: repair.instruction },
          ] };
          session.repairs.add(canonical(next));
        }
      }
    }
    return raw;
  } };
}
