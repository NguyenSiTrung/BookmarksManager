import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { db } from "../../db/database";
import {
  LlmFeatureMessage,
  LlmFeatureMessageResult,
  type LlmEscalationStatusResult,
} from "../../messages/llm-features";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
} from "../../messages/llm-provider";
import {
  ProviderMessage,
  ProviderMessageResult,
} from "../../messages/provider";
import {
  CONSENT_SCOPE,
  CUSTOM_PROVIDER_ID,
  JEV_PROVIDER_IDS,
  LLM_TEST_SCOPE,
  type JevProviderId,
} from "../../schemas/provider";

/**
 * Live provider state for the Options Permissions panel (audit bug B14).
 *
 * The shell keeps every panel mounted, so a provider enabled, reconfigured,
 * or revoked in the Connections panel — or a consent grant made there — has
 * to reach this panel without a reload. The worker stays the only owner of
 * provider state: this hook watches the *revision inputs* it can observe
 * locally (the settings rows and the connectivity consent grants the worker
 * writes into the shared IndexedDB) and re-asks the worker through the
 * existing typed protocols whenever they change.
 *
 * Nothing worker-private crosses into the page: the reads are
 * PROVIDER_STATUS / LLM_PROVIDER_STATUS / LLM_ESCALATION_STATUS, whose
 * replies are already masked. This module imports no key or credential
 * module directly and performs no credential read. (The message-schema
 * modules it does import reach `security/keys` and `security/credentials`
 * transitively — a pre-existing edge of the Options import graph that is
 * never exercised from here.)
 *
 * Every settled read is tagged with the revision token it was requested for.
 * A consumer must compare that tag against {@link DecisionProviderState.revision}
 * before using the value: while a newer revision's read is in flight the tag
 * still names the previous revision, so a stale origin, cap, or escalation
 * snapshot is never rendered as current. Reads superseded by a newer revision
 * are dropped outright (the generation guard below), so an out-of-order reply
 * cannot overwrite a newer one, and a settled failure surfaces as an error
 * the caller can retry.
 *
 * `chrome` is the lazy-slice house pattern — only `runtime.sendMessage` is
 * used, so `vi.stubGlobal("chrome", …)` works in tests.
 */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

/** A settled read paired with the revision token it was requested for. */
export interface TaggedRead<T> {
  /** Revision identity of the read that produced `value`. */
  readonly key: string;
  readonly value: T;
}

/** The Jev side: the custom endpoint's egress origin and the provider the
 *  worker reports as configured today. */
export interface JevProviderRead {
  /** Canonical origin of the stored custom provider, or `null` when none is
   *  configured — consent is granted per origin, so a card cannot exist
   *  without one. */
  readonly origin: string | null;
  /** The provider the worker reports as configured, in the same restore
   *  order the Connections panel uses (first fully enabled, then the first
   *  that still has saved settings), or `null` when nothing is stored. */
  readonly configured: JevProviderId | null;
}

/** The LLM side: the provider's egress origin plus the worker-composed
 *  escalation snapshot (cap, pricing, provider presence, enabled flag). */
export interface LlmProviderRead {
  readonly origin: string | null;
  readonly escalation: LlmEscalationStatusResult | null;
}

export interface DecisionProviderState {
  /** Revision token the current reads are requested for; `null` until the
   *  live query has emitted (reads have not been issued yet). */
  readonly revision: string | null;
  readonly jev: TaggedRead<JevProviderRead> | null;
  readonly llm: TaggedRead<LlmProviderRead> | null;
  /** A settled Jev status failure for the current revision, or `null`. */
  readonly jevError: string | null;
  /** A settled LLM/escalation status failure for the current revision. */
  readonly llmError: string | null;
  /** Re-run both reads for the current revision. */
  readonly retry: () => void;
}

/** How the hook renders the current revision's read. */
type Unsettled = { readonly ok: false; readonly message: string };
type Settled<T> = { readonly ok: true; readonly value: T };

const JEV_READ_ERROR =
  "The extension worker did not return the provider status.";
const LLM_READ_ERROR =
  "The extension worker did not return the second-opinion status.";

/** Provider records and settings rows the reads depend on. */
const LLM_RECORD_PREFIX = "llmProvider:";
const LLM_ACTIVE_KEY = "llmActiveProvider";
const ESCALATION_KEY = "llmEscalation";
const JEV_SETTINGS_KEYS: ReadonlySet<string> = new Set(JEV_PROVIDER_IDS);

/**
 * Consent grants a provider-status read depends on: `jev_test` decides
 * whether a Jev provider is enabled and `llm_test` the same for the LLM
 * provider. Per-feature grants (decisions, escalation, summaries) are read
 * live by the panels themselves and deliberately do not re-trigger a status
 * read.
 */
const CONNECTIVITY_SCOPES: ReadonlySet<string> = new Set([
  CONSENT_SCOPE,
  LLM_TEST_SCOPE,
]);

function isRevisionMetadataKey(key: string): boolean {
  return (
    JEV_SETTINGS_KEYS.has(key) ||
    key === LLM_ACTIVE_KEY ||
    key === ESCALATION_KEY ||
    key.startsWith(LLM_RECORD_PREFIX)
  );
}

/**
 * A deterministic token over every input the provider/escalation reads
 * depend on: the stored Jev settings rows, the LLM provider records and
 * active pointer, the escalation settings row, and the connectivity consent
 * grants. Values are compared, not just keys, so a reconfigured endpoint (a
 * new origin, model, cap, or pricing override) is a new revision.
 *
 * The `.catch` is required because `useLiveQuery` rethrows observable errors;
 * a failed read degrades to a stable token so the worker protocols — not the
 * local watch — remain the source of truth.
 */
async function readProviderRevision(): Promise<string> {
  try {
    const [metadataRows, consentRows] = await Promise.all([
      db.metadata.toArray(),
      db.consents.toArray(),
    ]);
    const metadata = metadataRows
      .filter((row) => isRevisionMetadataKey(row.key))
      .map((row) => [row.key, row.value] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const consents = consentRows
      .filter((row) => CONNECTIVITY_SCOPES.has(row.scope))
      .map(
        (row) =>
          [row.scope, row.origin, row.consentVersion, row.acceptedAt] as const,
      )
      .sort(([leftScope, leftOrigin], [rightScope, rightOrigin]) =>
        leftScope === rightScope
          ? leftOrigin < rightOrigin
            ? -1
            : leftOrigin > rightOrigin
              ? 1
              : 0
          : leftScope < rightScope
            ? -1
            : 1,
      );
    return JSON.stringify({ metadata, consents });
  } catch {
    return "revision-unavailable";
  }
}

/** One provider status probe; `null` covers a refused or unparseable reply. */
async function probeJevProvider(
  preset: JevProviderId,
): Promise<{ enabled: boolean; origin?: string; model?: string } | null> {
  try {
    const raw = await chrome.runtime.sendMessage(
      ProviderMessage.parse({ type: "PROVIDER_STATUS", preset }),
    );
    const result = ProviderMessageResult.safeParse(raw);
    return result.success && result.data.ok && "status" in result.data
      ? result.data.status
      : null;
  } catch {
    return null;
  }
}

/**
 * Ask the worker about every Jev provider at once: the custom endpoint's
 * resolved origin (the destination the egress gate would use, and the origin
 * consent must be granted at) and the provider its settings rows still
 * describe. A probe that does not answer settles the read as failed instead
 * of silently reporting "nothing configured".
 */
async function readJevProviders(): Promise<
  Settled<JevProviderRead> | Unsettled
> {
  const results = await Promise.all(
    JEV_PROVIDER_IDS.map(async (id) => ({
      id,
      status: await probeJevProvider(id),
    })),
  );
  if (results.some((entry) => entry.status === null)) {
    return { ok: false, message: JEV_READ_ERROR };
  }
  const custom = results.find((entry) => entry.id === CUSTOM_PROVIDER_ID);
  const pick =
    results.find((entry) => entry.status?.enabled === true) ??
    results.find((entry) => entry.status?.model !== undefined);
  return {
    ok: true,
    value: {
      origin: custom?.status?.origin ?? null,
      configured: pick?.id ?? null,
    },
  };
}

/**
 * Ask the worker for the LLM provider's origin and the escalation snapshot.
 * Both replies are required: the origin scopes the `llm_escalate` consent
 * read, and a half-answered pair would render a section whose state is not
 * the gate's.
 */
async function readLlmProviderState(): Promise<
  Settled<LlmProviderRead> | Unsettled
> {
  let providerRaw: unknown;
  let escalationRaw: unknown;
  try {
    [providerRaw, escalationRaw] = await Promise.all([
      chrome.runtime.sendMessage(
        LlmProviderMessage.parse({ type: "LLM_PROVIDER_STATUS" }),
      ),
      chrome.runtime.sendMessage(
        LlmFeatureMessage.parse({ type: "LLM_ESCALATION_STATUS" }),
      ),
    ]);
  } catch {
    return { ok: false, message: LLM_READ_ERROR };
  }
  const provider = LlmProviderMessageResult.safeParse(providerRaw);
  const escalation = LlmFeatureMessageResult.safeParse(escalationRaw);
  if (
    !provider.success ||
    !provider.data.ok ||
    !("status" in provider.data) ||
    !escalation.success ||
    !escalation.data.ok ||
    !("escalation" in escalation.data)
  ) {
    return { ok: false, message: LLM_READ_ERROR };
  }
  return {
    ok: true,
    value: {
      origin: provider.data.status.origin ?? null,
      escalation: escalation.data.escalation,
    },
  };
}

/**
 * Live Jev + LLM provider state for the Permissions panel. Each revision of
 * the observed inputs re-asks the worker; a read superseded before it settles
 * is dropped, and a failed read leaves the previous value tagged with its old
 * revision (never reused as current) while the error surfaces for a retry.
 */
export function useDecisionProviderState(): DecisionProviderState {
  const revision = useLiveQuery(readProviderRevision, []);
  const [jev, setJev] = useState<TaggedRead<JevProviderRead> | null>(null);
  const [llm, setLlm] = useState<TaggedRead<LlmProviderRead> | null>(null);
  // Failures are tagged the same way their values are: a failure recorded for
  // an earlier revision stops mattering the moment the inputs change, without
  // any state write in the effect body.
  const [jevFailure, setJevFailure] = useState<TaggedRead<string> | null>(null);
  const [llmFailure, setLlmFailure] = useState<TaggedRead<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Monotonic read generation: a reply from a superseded revision is dropped
  // rather than allowed to overwrite a newer read's result.
  const generation = useRef(0);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    if (revision === undefined) return;
    const mine = ++generation.current;
    let cancelled = false;
    void (async () => {
      const [jevOutcome, llmOutcome] = await Promise.all([
        readJevProviders(),
        readLlmProviderState(),
      ]);
      if (cancelled || generation.current !== mine) return;
      if (jevOutcome.ok) {
        setJev({ key: revision, value: jevOutcome.value });
        setJevFailure(null);
      } else {
        // The previous value stays tagged with its own revision, so a
        // consumer reading through the tag renders pending — never the
        // superseded value — until a later read settles.
        setJevFailure({ key: revision, value: jevOutcome.message });
      }
      if (llmOutcome.ok) {
        setLlm({ key: revision, value: llmOutcome.value });
        setLlmFailure(null);
      } else {
        setLlmFailure({ key: revision, value: llmOutcome.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [revision, attempt]);

  return {
    revision: revision ?? null,
    jev,
    llm,
    jevError:
      revision !== undefined && jevFailure?.key === revision
        ? jevFailure.value
        : null,
    llmError:
      revision !== undefined && llmFailure?.key === revision
        ? llmFailure.value
        : null,
    retry,
  };
}
