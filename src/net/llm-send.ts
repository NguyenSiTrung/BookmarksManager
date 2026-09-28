import { appendSentLog } from "./sent-log";
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
import { ChatCompletionRequest } from "../llm/wire";
import { LLM_CONSENT_SCOPES } from "../schemas/provider";
import { readCredential } from "../security/credentials";
import { db } from "../db/database";

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
  /** One of the six LLM consent scopes — also the sentLog feature label. */
  readonly scope: ConsentScope;
  /** The outbound body; must strict-parse as `ChatCompletionRequest`. */
  readonly request: unknown;
  /** Conservative token bounds for the budget reservation. */
  readonly maxInputTokens: number;
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
  /** Test seam; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface LlmSendResult {
  /** The raw response (any HTTP status — the caller maps non-2xx). */
  readonly response: Response;
  /** The persisted active reservation — settle it via `settleLlmUsage`. */
  readonly reservation: BudgetReservation;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 1;
/** Retry-After is honored but bounded — a hostile header cannot stall the gate. */
const MAX_RETRY_AFTER_MS = 5_000;

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRegisteredScope(scope: string): scope is ConsentScope {
  return (LLM_CONSENT_SCOPES as readonly string[]).includes(scope);
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

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (raw === null) return 0;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
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
 * schema + configured-model pin → current versioned consent at the exact
 * origin → Chrome host permission → stored credential (when auth requires
 * one) → budget reservation persisted as `active`. Only then does `fetch`
 * run — `credentials: "omit"`, `redirect: "error"`, per-attempt timeout, and
 * at most `retries` extra attempts on transport failures and 408/429/5xx
 * (honoring a bounded Retry-After). A `sentLog` metadata row — timestamp,
 * origin, feature, top-level field names — is appended only after `fetch`
 * resolves. Every refusal throws `LlmGateError`; bodies, headers, and
 * credentials never appear in errors.
 */
export async function sendLlmConsented(
  input: LlmSendInput,
  options?: LlmSendOptions,
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
  const unknownCostConfirmed =
    input.kind === "manual" && options?.unknownCostConfirmed === true;
  const reservationId = crypto.randomUUID();
  const [usageRows, reservationRows] = await Promise.all([
    db.llmUsage.where("providerId").equals(record.providerId).toArray(),
    db.llmReservations.where("providerId").equals(record.providerId).toArray(),
  ]);
  const reservationResult = reserveBudget({
    reservationId,
    providerId: record.providerId,
    model: destination.model,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    ...(record.provider.kind === "custom" &&
    record.provider.pricing !== undefined
      ? { pricing: record.provider.pricing }
      : {}),
    kind: input.kind,
    ...(record.monthlyBudgetUsd !== undefined
      ? { monthlyBudgetUsd: record.monthlyBudgetUsd }
      : {}),
    usage: usageRows,
    reservations: reservationRows,
    now: now(),
    unknownCostConfirmed,
  });

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
  await db.llmReservations.put(reservation);

  const fetchImpl = options?.fetchImpl ?? fetch;
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
  const body = JSON.stringify(parsed.data);

  let attempt = 0;
  for (;;) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      options?.signal !== undefined
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
    try {
      const response = await fetchImpl(destination.chatCompletionsUrl, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        signal,
        headers,
        body,
      });

      if (response.type === "opaqueredirect") {
        throw new LlmGateError(
          "transport",
          "Outbound LLM request answered with an opaque redirect.",
        );
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        attempt += 1;
        await response.body?.cancel();
        const wait = retryAfterMs(response);
        if (wait > 0) await sleep(wait);
        continue;
      }

      // The request left the extension — audit metadata only.
      await appendSentLog({
        sentAt: now().toISOString(),
        destination: destination.origin,
        feature: input.scope,
        fieldNames: Object.keys(parsed.data),
      });
      return { response, reservation };
    } catch (cause) {
      if (cause instanceof LlmGateError) {
        throw cause;
      }
      if (isAbortError(cause)) {
        await db.llmReservations.put(releaseBudget(reservation, now()));
        throw new LlmGateError(
          "timeout",
          "Outbound LLM request timed out or was aborted.",
          { cause },
        );
      }
      if (attempt < retries) {
        attempt += 1;
        continue;
      }
      await db.llmReservations.put(releaseBudget(reservation, now()));
      throw new LlmGateError(
        "transport",
        "Outbound LLM request failed in transport.",
        { cause },
      );
    }
  }
}
