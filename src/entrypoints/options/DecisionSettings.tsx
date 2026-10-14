import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  consentVersionForScope,
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  revokeConsentAtOrigin,
} from "../../consent/records";
import { LLM_SCOPE_DISCLOSURES } from "../../consent/disclosure";
import { db } from "../../db/database";
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
  JEV_SUMMARY_VERIFY_SCOPE,
  LLM_ESCALATE_SCOPE,
  LLM_EXPLAIN_SCOPE,
  LLM_RESTRUCTURE_SCOPE,
  LLM_SUMMARY_SCOPE,
} from "../../schemas/provider";
import {
  LlmFeatureMessage,
  LlmFeatureMessageResult,
} from "../../messages/llm-features";
import { useDecisionProviderState } from "./useDecisionProviderState";
import {
  Alert,
  Chip,
  ConsentFacts,
  Disclosure,
  Field,
  Switch,
} from "./components";
import { PulseIcon, ShieldIcon, ZapIcon } from "../../ui/components/icons";
import {
  cardClass,
  ghostDangerButtonClass,
  inputClass,
  primaryButtonClass,
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
 *    `AUTO_APPLY_THRESHOLD`; both default off. Reads go through
 *    GET_SETTINGS and writes through field-level PATCH_SETTINGS, so the
 *    worker remains the settings owner and a stale snapshot can't clobber
 *    a concurrent write from another Options tab.
 * 3. **User blocklist editor.** A dumb list editor over the persisted user
 *    blocklist: entries are normalized/deduped with `normalizeBlocklistEntry`
 *    and round-trip as add/remove deltas through PATCH_BLOCKLIST; the frozen
 *    `BUILTIN_SENSITIVE_SITES` list renders read-only for context.
 * 4. **Second opinions (escalation).** The `llm_escalate` disclosure and its
 *    read-gated consent, plus the off-by-default switch. A switch missing any
 *    prerequisite (provider, consent, spending ceiling, pricing) is
 *    soft-blocked: focusable, `aria-disabled`, with every unmet step rendered
 *    inline and its own reveal/jump action. A switch that is already on stays
 *    turnable off even when a prerequisite broke.
 *
 * Provider state is **live** (audit bug B14). The shell keeps every panel
 * mounted, so this one cannot rely on mount-time reads: the custom Jev
 * origin, the restore of the configured provider, the LLM origin, and the
 * escalation snapshot all come from `useDecisionProviderState`, which re-asks
 * the worker through the typed status protocols whenever the settings or
 * connectivity-consent rows it can observe change. A provider enabled,
 * reconfigured, capped, or revoked in the Connections panel therefore lands
 * here without a reload, and a read that has not settled for the current
 * revision reads as pending rather than as the superseded provider's state.
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

/** The two decision kinds that can ever auto-apply, in render order. */
const AUTO_APPLY_KINDS = [
  { kind: "add_tags", label: "Auto-apply tag additions" },
  { kind: "set_category", label: "Auto-apply category assignments" },
] as const;
const FEATURE_CONSENT_SCOPES = [
  LLM_EXPLAIN_SCOPE,
  LLM_RESTRUCTURE_SCOPE,
  LLM_SUMMARY_SCOPE,
  JEV_SUMMARY_VERIFY_SCOPE,
] as const;

type FeatureConsentScope = (typeof FEATURE_CONSENT_SCOPES)[number];

interface ActiveFeatureConsent {
  readonly scope: FeatureConsentScope;
  readonly origin: string;
}

type FeedbackSection =
  | "automations"
  | "escalation"
  | "feature-consents"
  | "blocklist";
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

/**
 * One unmet prerequisite behind the second-opinion switch. `target` names
 * where the step's reveal/jump goes, when one exists (a pending consent read
 * has none); the full list renders inline so the switch never dead-ends.
 */
interface EscalationPrerequisite {
  id: string;
  text: string;
  actionLabel?: string;
  target?: "connections";
  anchorId?: string;
}

export type DecisionSettingsSection = "all" | "connections" | "data";

export function DecisionSettings({
  section = "all",
  onNavigateToConnections,
}: {
  section?: DecisionSettingsSection;
  /**
   * Switch the Options shell to the Connections panel and (when given)
   * scroll the named anchor into view. The second-opinion prerequisites that
   * live in Connections jump through it.
   */
  onNavigateToConnections?: (anchorId?: string) => void;
} = {}) {
  const showConnections = section === "all" || section === "connections";
  const showData = section === "all" || section === "data";
  const live = useDecisionProviderState(showConnections);
  const llmRead =
    live.llm !== null && live.llm.key === live.revision
      ? live.llm.value
      : undefined;
  const llmOrigin = llmRead?.origin ?? null;
  const escalation = llmRead?.escalation ?? null;

  const [settings, setSettings] = useState<DecisionSettingsValue | null>(null);
  const [blocklist, setBlocklist] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [newEntry, setNewEntry] = useState("");
  const [builtinBlocklistOpen, setBuiltinBlocklistOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedbackSection, setFeedbackSection] =
    useState<FeedbackSection | null>(null);
  const [busy, setBusy] = useState(false);

  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  const [escalationBusy, setEscalationBusy] = useState(false);
  const [escalationDisclosureOpen, setEscalationDisclosureOpen] =
    useState(false);
  const escalationDisclosure = LLM_SCOPE_DISCLOSURES[LLM_ESCALATE_SCOPE];

  const activeFeatureConsents =
    useLiveQuery(async (): Promise<ActiveFeatureConsent[]> => {
      if (!showData) return [];
      try {
        const rows = await db.consents
          .where("scope")
          .anyOf([...FEATURE_CONSENT_SCOPES])
          .toArray();
        const active = rows.filter(
          (row): row is typeof row & { scope: FeatureConsentScope } =>
            (FEATURE_CONSENT_SCOPES as readonly string[]).includes(row.scope) &&
            row.consentVersion === consentVersionForScope(row.scope),
        );
        active.sort((left, right) => {
          const leftIndex = FEATURE_CONSENT_SCOPES.indexOf(left.scope);
          const rightIndex = FEATURE_CONSENT_SCOPES.indexOf(right.scope);
          if (leftIndex !== rightIndex) return leftIndex - rightIndex;
          return left.origin < right.origin
            ? -1
            : left.origin > right.origin
              ? 1
              : 0;
        });
        return active.map((row) => ({
          scope: row.scope,
          origin: row.origin,
        }));
      } catch {
        return [];
      }
    }, [showData]) ?? [];
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
    setFeedbackSection(null);
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


  /**
   * The `llm_escalate` grant at the provider's egress origin — keyed on the
   * origin the worker reported.
   */
  const escalationConsentRead = useLiveQuery(
    (): Promise<boolean | null> =>
      !showConnections || llmOrigin === null
        ? Promise.resolve(null)
        : hasConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin).catch(() => null),
    [showConnections, llmOrigin],
  );

  /** Revoke `llm_escalate` at the provider's exact origin and turn escalation off if enabled. */
  const onRevokeEscalationConsent = () => {
    if (llmOrigin === null || inFlight.current || escalationBusy) return;
    setEscalationBusy(true);
    setFeedbackSection("escalation");
    setError(null);
    setNotice(null);
    void (async () => {
      await revokeConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin);
      if (escalation?.enabled === true) {
        try {
          await chrome.runtime.sendMessage(
            LlmFeatureMessage.parse({
              type: "LLM_ESCALATION_SET",
              enabled: false,
            }),
          );
        } catch {
          // Best-effort disable when consent is revoked.
        }
      }
      setEscalationDisclosureOpen(false);
      setNotice("Second-opinion consent revoked — escalation can no longer send.");
    })()
      .catch(() => {
        setError("Something went wrong while revoking consent.");
      })
      .finally(() => setEscalationBusy(false));
  };

  /**
   * Flip the escalation flag through the worker. Turning escalation ON
   * automatically records the `llm_escalate` consent at `llmOrigin` before
   * sending `LLM_ESCALATION_SET`, eliminating the separate consent ceremony.
   */
  const onEscalationToggle = (enabled: boolean) => {
    if (inFlight.current || escalationBusy) return;
    setEscalationBusy(true);
    setFeedbackSection("escalation");
    setError(null);
    setNotice(null);
    void (async () => {
      if (enabled && llmOrigin !== null) {
        try {
          await grantConsentAtOrigin(LLM_ESCALATE_SCOPE, llmOrigin);
        } catch {
          setError("Something went wrong while recording consent.");
          return;
        }
      }
      const raw = await chrome.runtime.sendMessage(
        LlmFeatureMessage.parse({ type: "LLM_ESCALATION_SET", enabled }),
      );
      const result = LlmFeatureMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "escalation" in result.data) {
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
    })()
      .catch(() => {
        setError("The extension worker did not answer the escalation write.");
      })
      .finally(() => setEscalationBusy(false));
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
  const handleSettingsReply = (
    raw: unknown,
    okNotice: string,
    targetSection: FeedbackSection,
  ): boolean => {
    setFeedbackSection(targetSection);
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
  const onRevokeFeatureConsent = (
    scope: FeatureConsentScope,
    origin: string,
  ) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFeedbackSection("feature-consents");
    setError(null);
    setNotice(null);
    const title = LLM_SCOPE_DISCLOSURES[scope].title;
    void revokeConsentAtOrigin(scope, origin)
      .then(() => {
        setNotice(`${title} consent revoked for ${origin}.`);
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
    setFeedbackSection("automations");
    setError(null);
    setNotice(null);
    // Field-level patch: only this kind's toggle leaves the page, so a
    // stale snapshot can't clobber another Options tab's concurrent write.
    const patch = { autoApply: { [kind]: !settings.autoApply[kind] } };
    void chrome.runtime
      .sendMessage(
        DecisionMessage.parse({ type: "PATCH_SETTINGS", patch }),
      )
      .then((raw) => {
        handleSettingsReply(raw, "Auto-apply setting saved.", "automations");
      })
      .catch(() => {
        setError("Something went wrong while saving decision settings.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  /** Push one blocklist delta through PATCH_BLOCKLIST — the worker merges
   * it into the live list, so an entry added by another tab survives. */
  const writeBlocklist = (delta: {
    add?: readonly string[];
    remove?: readonly string[];
  }) => {
    inFlight.current = true;
    setBusy(true);
    setFeedbackSection("blocklist");
    setError(null);
    setNotice(null);
    void chrome.runtime
      .sendMessage(
        DecisionMessage.parse({
          type: "PATCH_BLOCKLIST",
          ...(delta.add !== undefined ? { add: [...delta.add] } : {}),
          ...(delta.remove !== undefined
            ? { remove: [...delta.remove] }
            : {}),
        }),
      )
      .then((raw) => {
        if (handleSettingsReply(raw, "Blocklist saved.", "blocklist")) {
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
      setFeedbackSection("blocklist");
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
      setFeedbackSection("blocklist");
      setNotice(`${normalized} is already on the blocklist.`);
      setError(null);
      setNewEntry("");
      return;
    }
    writeBlocklist({ add: [newEntry] });
  };

  const onRemoveEntry = (entry: string) => {
    if (blocklist === null || inFlight.current) {
      return;
    }
    writeBlocklist({ remove: [entry] });
  };

  /**
   * Every unmet prerequisite behind the second-opinion switch, in the order
   * they have to be satisfied. All of them render: fixing one blocked
   * condition used to leave the switch dead with the same copy and no clue
   * that another remained. Each actionable step carries its own reveal/jump.
   */
  const escalationPrerequisites: EscalationPrerequisite[] = [];
  if (escalation !== null) {
    if (!escalation.providerConfigured) {
      escalationPrerequisites.push({
        id: "provider",
        text: "The stored provider is gone — configure an LLM provider again in Connections.",
        actionLabel: "Open LLM provider",
        target: "connections",
        anchorId: "llm-provider",
      });
    }
    if (escalation.budget === "unset") {
      escalationPrerequisites.push({
        id: "budget",
        text: "No spending ceiling is chosen — escalation cannot run. Choose a monthly cap or Unlimited in Connections.",
        actionLabel: "Open Monthly budget",
        target: "connections",
        anchorId: "llm-budget",
      });
    }
    if (escalation.pricingKnown !== true) {
      escalationPrerequisites.push({
        id: "pricing",
        text: "No per-token price is known for this model — unattended requests refuse. Enter both rates in Connections.",
        actionLabel: "Open Monthly budget",
        target: "connections",
        anchorId: "llm-budget",
      });
    }
  }
  const escalationEnabled = escalation?.enabled ?? false;
  /**
   * Blocked only while OFF: an active switch must always be turnable off,
   * even when its prerequisites broke after enabling (the worker accepts a
   * disable unconditionally — only enabling needs a provider).
   */
  const escalationBlocked =
    !escalationEnabled && escalationPrerequisites.length > 0;
  const escalationFirstAction = escalationPrerequisites.find(
    (step) => step.actionLabel !== undefined && step.target !== undefined,
  );
  const renderSectionFeedback = (section: FeedbackSection) => {
    if (feedbackSection !== section) {
      return null;
    }
    return (
      <>
        {notice !== null && (
          <div className="mt-4">
            <Alert tone="success">{notice}</Alert>
          </div>
        )}
        {error !== null && (
          <div className="mt-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="space-y-4">
      {showConnections && (
        <>
          {/* Sub-card 1 — auto-apply switches */}
          <section aria-labelledby="auto-apply-heading" className={cardClass}>
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ZapIcon className="size-4" />
              </span>
              <h2 id="auto-apply-heading" className={sectionHeadingClass}>
                Automations
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              A decision can apply itself only at confidence {">="}{" "}
              {AUTO_APPLY_THRESHOLD} and only for the kinds enabled here — every
              other suggestion always waits for review. Both toggles stay off
              unless you turn them on.
            </p>
            {settings === null ? (
              <LoadState
                loading={loading}
                label="decision settings"
                onRetry={() => {
                  void loadSettings();
                }}
              />
            ) : (
              <div className="mt-3 divide-y divide-border">
                {AUTO_APPLY_KINDS.map(({ kind, label }) => (
                  <div
                    key={kind}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0"
                  >
                    <span className="text-sm">{label}</span>
                    <Switch
                      aria-label={label}
                      checked={settings.autoApply[kind]}
                      disabled={busy}
                      onCheckedChange={() => onToggle(kind)}
                    />
                  </div>
                ))}
              </div>
            )}
            {renderSectionFeedback("automations")}
          </section>

          {/* Sub-card 2 — second opinions (escalation) */}
          <section aria-labelledby="escalation-heading" className={cardClass}>
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PulseIcon className="size-4" />
              </span>
              <h2 id="escalation-heading" className={sectionHeadingClass}>
                Automatic second opinions
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              When enabled, a suggestion whose confidence falls below the review
              floor may get a second opinion from the LLM provider configured in
              Connections — inside a Save, Analyze, or library scan you started,
              and only while the monthly cap allows it. Turning this switch on
              authorizes the disclosed request fields; the verdict is advisory
              and still waits for your review.
            </p>
            {live.llmError !== null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Could not read the second-opinion status.
                <button
                  type="button"
                  onClick={live.retry}
                  className={`ml-2 ${smallButtonClass}`}
                >
                  Retry second-opinion status
                </button>
              </p>
            ) : llmOrigin === null && llmRead === undefined ? (
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                Checking the second-opinion status…
              </p>
            ) : llmOrigin === null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Configure and enable an LLM provider in Connections to use
                second opinions.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <Disclosure
                  title={escalationDisclosure.title}
                  open={escalationDisclosureOpen}
                  onOpenChange={setEscalationDisclosureOpen}
                  regionLabel="Second opinion disclosure"
                >
                  <ConsentFacts
                    recipientName="your LLM provider"
                    origin={llmOrigin}
                    sent={[...escalationDisclosure.fields]}
                    neverSent={["page content", "full URLs"]}
                    why={escalationDisclosure.purpose}
                    when={escalationDisclosure.trigger}
                  >
                    <p>{escalationDisclosure.credentialUse}.</p>
                  </ConsentFacts>
                </Disclosure>

                <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
                  <span className="text-sm">
                    Ask the provider for a second opinion on unsure suggestions
                  </span>
                  <Switch
                    aria-label="Ask the provider for a second opinion on unsure suggestions"
                    checked={escalationEnabled}
                    disabled={escalationBusy || escalation === null}
                    blocked={escalationBlocked}
                    onBlocked={
                      escalationFirstAction !== undefined &&
                      escalationFirstAction.anchorId !== undefined
                        ? () =>
                            onNavigateToConnections?.(
                              escalationFirstAction.anchorId,
                            )
                        : undefined
                    }
                    reason={
                      escalationPrerequisites.length > 0 ? (
                        <span className="block space-y-1">
                          <span className="block font-medium text-foreground">
                            {escalationEnabled
                              ? "It is on, but cannot run yet:"
                              : "To turn this on:"}
                          </span>
                          {escalationPrerequisites.map((step) => (
                            <span key={step.id} className="block">
                              {step.text}
                              {step.actionLabel !== undefined &&
                                step.target !== undefined && (
                                  <>
                                    {" "}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (step.anchorId !== undefined) {
                                          onNavigateToConnections?.(
                                            step.anchorId,
                                          );
                                        }
                                      }}
                                      className="font-medium text-foreground underline underline-offset-2"
                                    >
                                      {step.actionLabel}
                                    </button>
                                  </>
                                )}
                            </span>
                          ))}
                        </span>
                      ) : undefined
                    }
                    onCheckedChange={(enabled) => onEscalationToggle(enabled)}
                  />
                </div>
                {escalation !== null && escalation.budget !== "unset" && (
                  <p className="text-xs text-muted-foreground">
                    {escalation.budget === "unlimited"
                      ? "No monthly cap — this can spend without a limit."
                      : `Monthly cap: $${(escalation.monthlyBudgetUsd ?? 0).toFixed(2)}.`}
                  </p>
                )}
                {escalationConsentRead === true && (
                  <div>
                    <button
                      type="button"
                      onClick={onRevokeEscalationConsent}
                      disabled={escalationBusy}
                      className={ghostDangerButtonClass}
                    >
                      Revoke second-opinion consent
                    </button>
                  </div>
                )}
              </div>
            )}
            {renderSectionFeedback("escalation")}
          </section>
        </>
      )}

      {showData && (
        <>
          {/* Sub-card 3 — blocklist */}
          <section aria-labelledby="blocklist-heading" className={cardClass}>
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldIcon className="size-4" />
              </span>
              <h2 id="blocklist-heading" className={sectionHeadingClass}>
                Never send these sites
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Bookmarks on these hosts are never sent to a provider, no matter
              what is consented in Connections.
            </p>
            {blocklist === null ? (
              <LoadState
                loading={loading}
                label="the blocklist"
                onRetry={() => {
                  void loadSettings();
                }}
              />
            ) : (
              <>
                {blocklist.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    No sites blocked yet.
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {blocklist.map((entry) => (
                      <li key={entry}>
                        <Chip
                          onRemove={() => onRemoveEntry(entry)}
                          removeLabel={`Remove ${entry}`}
                        >
                          {entry}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-4 flex items-end gap-2">
                  <Field
                    label="Block a host"
                    htmlFor="blocklist-entry"
                    className="min-w-0 flex-1"
                  >
                    <input
                      id="blocklist-entry"
                      type="text"
                      value={newEntry}
                      onChange={(event) => setNewEntry(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !busy &&
                          newEntry.trim() !== ""
                        ) {
                          event.preventDefault();
                          onAddEntry();
                        }
                      }}
                      placeholder="example.com"
                      className={inputClass}
                    />
                  </Field>
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
            <div className="mt-4">
              <Disclosure
                title={`Built-in blocklist — ${BUILTIN_SENSITIVE_SITES.length} sites`}
                subtitle="Always applies, not editable."
                open={builtinBlocklistOpen}
                onOpenChange={setBuiltinBlocklistOpen}
                regionLabel="Built-in blocklist"
              >
                <ul className="flex flex-wrap gap-1.5">
                  {BUILTIN_SENSITIVE_SITES.map((site) => (
                    <li key={site}>
                      <Chip>{site}</Chip>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
            {renderSectionFeedback("blocklist")}
          </section>

          {/* Sub-card 4 — per-feature consent inspection and revocation */}
          <section
            aria-labelledby="feature-consents-heading"
            className={cardClass}
          >
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShieldIcon className="size-4" />
              </span>
              <h2
                id="feature-consents-heading"
                className={sectionHeadingClass}
              >
                Feature permissions
              </h2>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Individual AI feature consents granted when you explain a
              decision, propose a folder layout, or summarize a page.
            </p>
            {activeFeatureConsents.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No individual feature permissions granted yet.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {activeFeatureConsents.map(({ scope, origin }) => {
                  const itemDisclosure = LLM_SCOPE_DISCLOSURES[scope];
                  return (
                    <li
                      key={`${scope}:${origin}`}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {itemDisclosure.title}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Consent granted · {origin}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRevokeFeatureConsent(scope, origin)}
                        disabled={busy}
                        className={`${ghostDangerButtonClass} shrink-0 whitespace-nowrap`}
                      >
                        Revoke {itemDisclosure.title} consent
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {renderSectionFeedback("feature-consents")}
          </section>
        </>
      )}
      {feedbackSection === null && notice !== null && (
        <div className="mt-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {feedbackSection === null && error !== null && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </div>
  );
}
