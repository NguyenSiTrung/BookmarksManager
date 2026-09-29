import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  DECISIONS_DESCRIPTION,
  DECISIONS_NEVER_SENT_FIELDS,
  DECISIONS_PURPOSES,
  DECISIONS_SENT_FIELDS,
  DECISIONS_TRIGGER_NOTE,
  DECISIONS_TRIGGERS,
  EXTENSION_PRIVACY_POLICY_REFERENCE,
  PROVIDER_DISCLOSURES,
} from "../../consent/disclosure";
import {
  grantConsent,
  hasConsent,
  revokeConsent,
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  revokeConsentAtOrigin,
} from "../../consent/records";
import { LLM_SCOPE_DISCLOSURES } from "../../consent/disclosure";
import {
  addBlocklistEntry,
  BUILTIN_SENSITIVE_SITES,
  normalizeBlocklistEntry,
} from "../../decisions/minimize";
import {
  AUTO_APPLY_THRESHOLD,
  type DecisionSettings as DecisionSettingsValue,
} from "../../decisions/policy";
import {
  DecisionMessage,
  DecisionMessageResult,
} from "../../messages/decisions";
import {
  DECISIONS_CONSENT_SCOPE,
  LLM_ESCALATE_SCOPE,
  PresetId,
} from "../../schemas/provider";
import {
  LlmFeatureMessage,
  LlmFeatureMessageResult,
} from "../../messages/llm-features";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
} from "../../messages/llm-provider";
import {
  cardClass,
  dangerButtonClass,
  inputClass,
  insetClass,
  primaryButtonClass,
  radioCardClass,
  radioGroupClass,
  sectionHeadingClass,
  smallButtonClass,
} from "./ui";

/**
 * Options-page surface for the Phase 4 Jev decisions protocol (spec FR10):
 *
 * 1. **Decisions consent, per provider.** Renders the `jev_decisions`
 *    disclosure verbatim from the typed constants in
 *    `src/consent/disclosure.ts`, then requires an affirmative checkbox +
 *    button click. The grant itself is a direct Dexie write
 *    (`grantConsent`/`revokeConsent`/`hasConsent` on `db.consents`) — the
 *    Options page shares the worker's IndexedDB and the egress gate
 *    re-verifies consent on every send, so no consent message exists in
 *    `src/messages/decisions.ts`. A stale `consentVersion` row fails
 *    `hasConsent`, so a v1 grant naturally re-displays the un-consented
 *    screen (the v1→v2 re-disclosure). Consent is rendered per preset
 *    independently of whether the provider is connected: the worker refuses
 *    egress until a stored ProviderSettings row also exists, so a grant here
 *    simply takes effect once the provider is connected above.
 * 2. **Auto-apply toggles.** Only `add_tags` and `set_category` can ever
 *    auto-apply (`src/decisions/policy.ts`), and only at confidence ≥
 *    `AUTO_APPLY_THRESHOLD`; both default off. Reads/writes go through
 *    GET_SETTINGS/SET_SETTINGS so the worker remains the settings owner.
 * 3. **User blocklist editor.** A dumb list editor over the persisted user
 *    blocklist: entries are normalized/deduped with `normalizeBlocklistEntry`
 *    and round-trip through SET_BLOCKLIST; the frozen
 *    `BUILTIN_SENSITIVE_SITES` list renders read-only for context.
 *
 * `chrome` is the lazy-slice house pattern — only `runtime.sendMessage` is
 * used, so `vi.stubGlobal("chrome", …)` works in tests. Every reply is
 * validated with `DecisionMessageResult.safeParse`; `{ok:false}` code/message
 * renders verbatim (already redacted) and a non-parse becomes a generic
 * "unexpected response" error.
 */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

const PRESET_IDS = PresetId.options;

/** The two decision kinds that can ever auto-apply, in render order. */
const AUTO_APPLY_KINDS = [
  { kind: "add_tags", label: "Auto-apply tag additions" },
  { kind: "set_category", label: "Auto-apply category assignments" },
] as const;

/**
 * A consent verdict paired with the preset the live query read it for —
 * lets a stale emission be recognized after a preset switch.
 */
interface ConsentRead {
  preset: PresetId;
  granted: boolean;
}

/**
 * Pending/failed placeholder for the worker-owned sections. `loading` is the
 * in-flight flag from `loadSettings`, so a settled-but-empty read shows a
 * retryable failure instead of "Loading…" forever; the verbatim worker error
 * renders in the page-level alert below.
 */
function LoadState({
  loading,
  label,
  onRetry,
}: {
  loading: boolean;
  label: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        Loading {label}…
      </p>
    );
  }
  return (
    <p className="mt-2 text-sm text-muted-foreground">
      Could not load {label}.
      <button
        type="button"
        onClick={onRetry}
        className={`ml-2 ${smallButtonClass}`}
      >
        Retry
      </button>
    </p>
  );
}

export function DecisionSettings() {
  const [presetId, setPresetId] = useState<PresetId>("typesafe");
  const [agreed, setAgreed] = useState(false);
  const [settings, setSettings] = useState<DecisionSettingsValue | null>(null);
  const [blocklist, setBlocklist] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [newEntry, setNewEntry] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  // --- Automatic second opinions (escalation, spec FR6) --------------------
  // The worker owns the `llmEscalation` metadata row and the budget reads;
  // the page writes consent directly (Dexie is shared) after showing the
  // scope's disclosure verbatim — the same split as `jev_decisions` above.
  const [llmOrigin, setLlmOrigin] = useState<string | null>(null);
  const [escalation, setEscalation] = useState<{
    enabled: boolean;
    providerConfigured: boolean;
    monthlyBudgetUsd: number | null;
  } | null>(null);
  const [escalationAgreed, setEscalationAgreed] = useState(false);
  const [escalationBusy, setEscalationBusy] = useState(false);
  const escalationDisclosure = LLM_SCOPE_DISCLOSURES[LLM_ESCALATE_SCOPE];

  const disclosure = PROVIDER_DISCLOSURES[presetId];

  /**
   * The current provider's `jev_decisions` grant, live from `db.consents`.
   * Each emission names the preset it was read for: dexie-react-hooks keeps
   * the previous result while a dep-changed query re-runs, so after a preset
   * switch the stale verdict arrives tagged with the OLD preset. A stale
   * `consentVersion` row reads as `false`, so a re-disclosure is just the
   * un-consented screen again.
   */
  const consentRead = useLiveQuery(
    (): Promise<ConsentRead> =>
      hasConsent(DECISIONS_CONSENT_SCOPE, presetId)
        .then((granted) => ({ preset: presetId, granted }))
        .catch(() => ({ preset: presetId, granted: false })),
    [presetId],
  );

  /**
   * The verdict for the CURRENT preset only — `undefined` (pending) until
   * the query emits a read taken for this `presetId`. The mismatched-preset
   * stale emission therefore renders "Checking consent…" instead of
   * flashing the prior provider's panel under the new disclosure.
   */
  const consentGranted =
    consentRead !== undefined && consentRead.preset === presetId
      ? consentRead.granted
      : undefined;

  /**
   * Read the settings/blocklist snapshot through the decisions protocol.
   * The worker stays the owner of `DecisionSettings`; the page never writes
   * `decisions:settings` directly.
   */
  const loadSettings = useCallback(async () => {
    // `loading` marks a genuinely in-flight read — the sections only render
    // "Loading…" while it is set, and a retryable failure once it settles
    // without data. Clearing `error` here also retires a stale alert from a
    // previous failed attempt.
    setLoading(true);
    setError(null);
    try {
      const raw = await chrome.runtime.sendMessage(
        DecisionMessage.parse({ type: "GET_SETTINGS" }),
      );
      const result = DecisionMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "settings" in result.data) {
        setSettings(result.data.settings);
        setBlocklist(result.data.blocklist);
      } else if (result.success && !result.data.ok) {
        setError(`${result.data.code}: ${result.data.message}`);
      } else {
        setError("The extension worker returned an unexpected response.");
      }
    } catch {
      setError("The extension worker did not return decision settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once on mount; the microtask boundary keeps the fetch a subscription
  // callback, not a synchronous state write in the effect body.
  useEffect(() => {
    queueMicrotask(() => {
      void loadSettings();
    });
  }, [loadSettings]);

  /** Re-run the settings read after a failure — the Retry button's action. */
  const onRetryLoad = () => {
    void loadSettings();
  };

  /**
   * Read the escalation state: the provider status supplies the egress
   * origin (needed for the `llm_escalate` consent read below) and the
   * configured cap; the feature reply carries the enabled flag. Both are
   * worker answers — the page renders exactly what the gate would see.
   */
  const loadEscalation = useCallback(async () => {
    try {
      const [providerRaw, statusRaw] = await Promise.all([
        chrome.runtime.sendMessage(
          LlmProviderMessage.parse({ type: "LLM_PROVIDER_STATUS" }),
        ),
        chrome.runtime.sendMessage(
          LlmFeatureMessage.parse({ type: "LLM_ESCALATION_STATUS" }),
        ),
      ]);
      const provider = LlmProviderMessageResult.safeParse(providerRaw);
      const status = LlmFeatureMessageResult.safeParse(statusRaw);
      if (
        provider.success &&
        provider.data.ok &&
        "status" in provider.data
      ) {
        setLlmOrigin(provider.data.status.origin ?? null);
      }
      if (
        status.success &&
        status.data.ok &&
        "escalation" in status.data
      ) {
        setEscalation(status.data.escalation);
      }
    } catch {
      // A missing worker surface leaves the section in its loading state.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadEscalation();
    });
  }, [loadEscalation]);

  /**
   * The `llm_escalate` grant at the provider's egress origin — same
   * pinned-version read as the Jev consent above, keyed on the origin the
   * worker reported. `undefined` (pending) renders a checking state rather
   * than a stale grant.
   */
  const escalationConsentRead = useLiveQuery(
    (): Promise<boolean | null> =>
      llmOrigin === null
        ? Promise.resolve(null)
        : hasConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin).catch(() => null),
    [llmOrigin],
  );

  /** Grant or revoke `llm_escalate` at the provider's exact origin. */
  const onEscalationConsent = (grant: boolean) => {
    if (llmOrigin === null || inFlight.current || escalationBusy) return;
    if (grant && !escalationAgreed) return;
    setEscalationBusy(true);
    setError(null);
    setNotice(null);
    const write = grant
      ? grantConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin)
      : revokeConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin);
    void write
      .then(() => {
        setEscalationAgreed(false);
        setNotice(
          grant
            ? "Second-opinion consent recorded. Escalation still needs the toggle below and a monthly cap on the provider."
            : "Second-opinion consent revoked — escalation can no longer send.",
        );
      })
      .catch(() => {
        setError(
          grant
            ? "Something went wrong while recording consent."
            : "Something went wrong while revoking consent.",
        );
      })
      .finally(() => setEscalationBusy(false));
  };

  /** Flip the escalation flag through the worker; the reply is re-rendered. */
  const onEscalationToggle = (enabled: boolean) => {
    if (inFlight.current || escalationBusy) return;
    setEscalationBusy(true);
    setError(null);
    setNotice(null);
    void chrome.runtime
      .sendMessage(
        LlmFeatureMessage.parse({ type: "LLM_ESCALATION_SET", enabled }),
      )
      .then((raw) => {
        const result = LlmFeatureMessageResult.safeParse(raw);
        if (
          result.success &&
          result.data.ok &&
          "escalation" in result.data
        ) {
          setEscalation(result.data.escalation);
          setNotice(
            enabled
              ? "Automatic second opinions are on for low-confidence suggestions."
              : "Automatic second opinions are off.",
          );
        } else if (result.success && !result.data.ok) {
          setError(`${result.data.code}: ${result.data.message}`);
        } else {
          setError("The extension worker returned an unexpected response.");
        }
      })
      .catch(() => {
        setError("The extension worker did not answer the escalation write.");
      })
      .finally(() => setEscalationBusy(false));
  };

  const onPresetChange = (next: PresetId) => {
    setPresetId(next);
    setAgreed(false);
    setNewEntry("");
    setNotice(null);
    setError(null);
  };

  /** Apply one worker `settings_ok` snapshot to both rendered states. */
  const applySnapshot = (data: {
    settings: DecisionSettingsValue;
    blocklist: string[];
  }) => {
    setSettings(data.settings);
    setBlocklist(data.blocklist);
  };

  /** Map a reply to a notice/error; returns true when it was `settings_ok`. */
  const handleSettingsReply = (raw: unknown, okNotice: string): boolean => {
    const result = DecisionMessageResult.safeParse(raw);
    if (result.success && result.data.ok && "settings" in result.data) {
      applySnapshot(result.data);
      setNotice(okNotice);
      return true;
    }
    if (result.success && !result.data.ok) {
      setError(`${result.data.code}: ${result.data.message}`);
    } else {
      setError("The extension worker returned an unexpected response.");
    }
    return false;
  };

  const onGrant = () => {
    if (!agreed || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Direct Dexie write: the gate re-verifies on every send, so the grant
    // is durable local state, not a message to the worker.
    void grantConsent(DECISIONS_CONSENT_SCOPE, presetId)
      .then(() => {
        setAgreed(false);
        setNotice(
          `Bookmark analysis consent recorded for ${disclosure.name}. It applies once ${disclosure.name} is connected above.`,
        );
      })
      .catch(() => {
        setError("Something went wrong while recording consent.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const onRevoke = () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Removes only the jev_decisions row — the provider's jev_test grant and
    // stored key are untouched.
    void revokeConsent(DECISIONS_CONSENT_SCOPE, presetId)
      .then(() => {
        setNotice(
          `Bookmark analysis consent revoked for ${disclosure.name}. The provider connection is unchanged.`,
        );
      })
      .catch(() => {
        setError("Something went wrong while revoking consent.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const onToggle = (kind: "add_tags" | "set_category") => {
    if (settings === null || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const next: DecisionSettingsValue = {
      autoApply: {
        ...settings.autoApply,
        [kind]: !settings.autoApply[kind],
      },
    };
    void chrome.runtime
      .sendMessage(
        DecisionMessage.parse({ type: "SET_SETTINGS", settings: next }),
      )
      .then((raw) => {
        handleSettingsReply(raw, "Auto-apply setting saved.");
      })
      .catch(() => {
        setError("Something went wrong while saving decision settings.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  /** Push one blocklist write through SET_BLOCKLIST. */
  const writeBlocklist = (entries: readonly string[]) => {
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void chrome.runtime
      .sendMessage(
        DecisionMessage.parse({
          type: "SET_BLOCKLIST",
          blocklist: [...entries],
        }),
      )
      .then((raw) => {
        if (handleSettingsReply(raw, "Blocklist saved.")) {
          setNewEntry("");
        }
      })
      .catch(() => {
        setError("Something went wrong while saving the blocklist.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const onAddEntry = () => {
    if (blocklist === null || inFlight.current) {
      return;
    }
    let next: readonly string[];
    try {
      next = addBlocklistEntry(blocklist, newEntry);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That entry cannot name a blocklist host.",
      );
      setNotice(null);
      return;
    }
    if (next === blocklist) {
      // Same array back means the normalized entry was already listed.
      const normalized = normalizeBlocklistEntry(newEntry) ?? newEntry.trim();
      setNotice(`${normalized} is already on the blocklist.`);
      setError(null);
      setNewEntry("");
      return;
    }
    writeBlocklist(next);
  };

  const onRemoveEntry = (entry: string) => {
    if (blocklist === null || inFlight.current) {
      return;
    }
    writeBlocklist(blocklist.filter((item) => item !== entry));
  };

  return (
    <section
      aria-labelledby="decisions-heading"
      className={cardClass}
    >
      <h2 id="decisions-heading" className={sectionHeadingClass}>
        AI bookmark analysis
      </h2>

      <section
        aria-labelledby="decisions-consent-heading"
        className="mt-4"
      >
        <h3 id="decisions-consent-heading" className="font-medium">
          Consent to send bookmark metadata
        </h3>

        <fieldset className="mt-3">
          <legend className="text-sm font-medium">Provider</legend>
          <div className={radioGroupClass}>
          {PRESET_IDS.map((id) => (
            <label key={id} className={radioCardClass}>
              <input
                type="radio"
                name="decisions-provider"
                value={id}
                checked={presetId === id}
                onChange={() => onPresetChange(id)}
              />
              {PROVIDER_DISCLOSURES[id].name}
            </label>
          ))}
          </div>
        </fieldset>

        <section
          aria-label={`${disclosure.name} bookmark data disclosure`}
          className={`mt-4 ${insetClass}`}
        >
          <h4 className="font-medium">
            What bookmark analysis sends to {disclosure.name}
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Recipient: {disclosure.name} at {disclosure.origin} — the only
              destination this consent covers.
            </li>
            <li>
              What is sent: {DECISIONS_DESCRIPTION}. A request may carry:
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {DECISIONS_SENT_FIELDS.map((field) => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </li>
            <li>
              Never sent, under any scope:{" "}
              {DECISIONS_NEVER_SENT_FIELDS.map((field, index) => (
                <Fragment key={field}>
                  {index > 0 && " and "}
                  <code className="rounded bg-muted px-1">{field}</code>
                </Fragment>
              ))}
              .
            </li>
            <li>Why: {DECISIONS_PURPOSES.join(", ")}.</li>
            <li>
              When: {DECISIONS_TRIGGERS.join(", ")} — {DECISIONS_TRIGGER_NOTE}.
            </li>
            <li>{disclosure.dataNote}</li>
            <li>
              Read the{" "}
              <a
                href={disclosure.privacyPolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
              >
                {disclosure.name} privacy policy
              </a>{" "}
              and {EXTENSION_PRIVACY_POLICY_REFERENCE}.
            </li>
          </ul>
        </section>

        {consentGranted === undefined ? (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Checking consent…
          </p>
        ) : consentGranted ? (
          <div
            role="group"
            aria-label={`${disclosure.name} analysis consent`}
            className="mt-4"
          >
            <p className="text-sm">
              {disclosure.name} may receive the bookmark metadata listed
              above.
            </p>
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className={`mt-3 ${dangerButtonClass}`}
            >
              Revoke {disclosure.name} analysis consent
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                I have read the disclosure above and agree to send bookmark
                metadata to {disclosure.name}.
              </label>
            </div>
            <button
              type="button"
              onClick={onGrant}
              disabled={!agreed || busy}
              className={primaryButtonClass}
            >
              Allow {disclosure.name} bookmark analysis
            </button>
            <p className="text-xs text-muted-foreground">
              Consent alone sends nothing — it takes effect once{" "}
              {disclosure.name} is connected above, and only for the actions
              listed.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="auto-apply-heading" className="mt-6">
        <h3 id="auto-apply-heading" className="font-medium">
          Auto-apply decisions
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          A decision can apply itself only at confidence {">="}{" "}
          {AUTO_APPLY_THRESHOLD} and only for the kinds enabled here — every
          other suggestion always waits for review. Both toggles stay off
          unless you turn them on.
        </p>
        {settings === null ? (
          <LoadState
            loading={loading}
            label="decision settings"
            onRetry={onRetryLoad}
          />
        ) : (
          <div className="mt-2 space-y-2">
            {AUTO_APPLY_KINDS.map(({ kind, label }) => (
              <label
                key={kind}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={settings.autoApply[kind]}
                  disabled={busy}
                  onChange={() => onToggle(kind)}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="escalation-heading" className="mt-6">
        <h3 id="escalation-heading" className="font-medium">
          Automatic second opinions
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          When enabled, a suggestion whose confidence falls below the review
          floor may get a second opinion from the LLM provider configured
          above — inside a Save, Analyze, or library scan you started, and
          only while the monthly cap allows it. The verdict is advisory: the
          suggestion still waits for your review.
        </p>
        {llmOrigin === null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Configure and enable an LLM provider above to use second
            opinions.
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {escalationDisclosure.title}
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Purpose: {escalationDisclosure.purpose}.</li>
                <li>
                  Sends: {escalationDisclosure.fields.join(", ")} — never page
                  content or full URLs.
                </li>
                <li>When: {escalationDisclosure.trigger}.</li>
                <li>{escalationDisclosure.credentialUse}</li>
              </ul>
              {escalationConsentRead === null ? null : !escalationConsentRead ? (
                <div className="mt-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={escalationAgreed}
                      disabled={escalationBusy}
                      onChange={(event) =>
                        setEscalationAgreed(event.target.checked)
                      }
                    />
                    I allow second opinions to be sent to {llmOrigin}
                  </label>
                  <button
                    type="button"
                    onClick={() => onEscalationConsent(true)}
                    disabled={!escalationAgreed || escalationBusy}
                    className={`mt-2 ${primaryButtonClass}`}
                  >
                    Allow second opinions
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onEscalationConsent(false)}
                  disabled={escalationBusy}
                  className={`mt-2 ${smallButtonClass}`}
                >
                  Revoke second-opinion consent
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={escalation?.enabled ?? false}
                disabled={
                  escalationBusy ||
                  escalation === null ||
                  !escalation.providerConfigured ||
                  escalationConsentRead !== true ||
                  escalation.monthlyBudgetUsd === null
                }
                onChange={(event) =>
                  onEscalationToggle(event.target.checked)
                }
              />
              Ask the provider for a second opinion on unsure suggestions
            </label>
            {escalation !== null && (
              <p className="text-sm text-muted-foreground">
                {escalation.monthlyBudgetUsd === null
                  ? "No monthly cap is set — escalation cannot run. Set one in the LLM provider section above."
                  : `Monthly cap: $${escalation.monthlyBudgetUsd.toFixed(2)}.`}
                {escalation.providerConfigured
                  ? ""
                  : " The stored provider is gone — configure it again above."}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="blocklist-heading" className="mt-6">
        <h3 id="blocklist-heading" className="font-medium">
          Never send these sites
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Bookmarks on these hosts are never sent to a provider, no matter
          what is consented above.
        </p>
        {blocklist === null ? (
          <LoadState
            loading={loading}
            label="the blocklist"
            onRetry={onRetryLoad}
          />
        ) : (
          <>
            {blocklist.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No sites blocked yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {blocklist.map((entry) => (
                  <li
                    key={entry}
                    className="flex items-center gap-2 text-sm"
                  >
                    <code className="rounded bg-muted px-1">{entry}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${entry}`}
                      onClick={() => onRemoveEntry(entry)}
                      disabled={busy}
                      className={smallButtonClass}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex items-center gap-2">
              <label htmlFor="blocklist-entry" className="text-sm">
                Block a host
              </label>
              <input
                id="blocklist-entry"
                type="text"
                value={newEntry}
                onChange={(event) => setNewEntry(event.target.value)}
                placeholder="example.com"
                className={inputClass}
              />
              <button
                type="button"
                onClick={onAddEntry}
                disabled={busy || newEntry.trim() === ""}
                className={primaryButtonClass}
              >
                Add
              </button>
            </div>
          </>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            Built-in blocklist — {BUILTIN_SENSITIVE_SITES.length} sites
            (always applies, not editable)
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {BUILTIN_SENSITIVE_SITES.map((site) => (
              <li key={site}>
                <code className="rounded bg-muted px-1">{site}</code>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {notice !== null && (
        <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
