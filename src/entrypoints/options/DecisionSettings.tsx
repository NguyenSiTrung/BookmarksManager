import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CUSTOM_JEV_PROVIDER_NAME,
  customJevDisclosure,
  DECISIONS_NEVER_SENT_FIELDS,
  DECISIONS_PURPOSES,
  DECISIONS_SENT_FIELDS,
  DECISIONS_TRIGGER_NOTE,
  DECISIONS_TRIGGERS,
  EXTENSION_PRIVACY_POLICY_REFERENCE,
  NO_DEVELOPER_SERVER_NOTE,
  PROVIDER_DISCLOSURES,
} from "../../consent/disclosure";
import {
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
  CUSTOM_PROVIDER_ID,
  DECISIONS_CONSENT_SCOPE,
  LLM_ESCALATE_SCOPE,
  type JevProviderId,
  PresetId,
} from "../../schemas/provider";
import { PRESETS } from "../../net/presets";
import {
  LlmFeatureMessage,
  LlmFeatureMessageResult,
} from "../../messages/llm-features";
import {
  useDecisionProviderState,
  type TaggedRead,
} from "./useDecisionProviderState";
import {
  Alert,
  Chip,
  ConsentFacts,
  Disclosure,
  Field,
  ProviderCard,
  Switch,
  scrollDisclosureIntoView,
} from "./components";
import { PulseIcon, ShieldIcon, ZapIcon } from "../../ui/components/icons";
import {
  cardClass,
  ghostDangerButtonClass,
  inputClass,
  primaryButtonClass,
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
  preset: JevProviderId;
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

/**
 * One unmet prerequisite behind the second-opinion switch. `target` names
 * where the step's reveal/jump goes, when one exists (a pending consent read
 * has none); the full list renders inline so the switch never dead-ends.
 */
interface EscalationPrerequisite {
  id: string;
  text: string;
  actionLabel?: string;
  /** Where `actionLabel` goes: the consent block above, or Connections. */
  target?: "consent" | "connections";
  /** Anchor inside Connections when `target` is "connections". */
  anchorId?: string;
}

export function DecisionSettings({
  onNavigateToConnections,
}: {
  /**
   * Switch the Options shell to the Connections panel and (when given)
   * scroll the named anchor into view. The second-opinion prerequisites that
   * live in Connections jump through it.
   */
  onNavigateToConnections?: (anchorId?: string) => void;
} = {}) {
  const [presetId, setPresetId] = useState<JevProviderId>("typesafe");
  /**
   * Live Jev + LLM provider state from the worker (audit bug B14): the custom
   * endpoint's egress origin, the provider the worker reports as configured,
   * and the LLM origin plus escalation snapshot. The hook re-asks the worker
   * whenever the settings or connectivity-consent rows change — including
   * changes made in the Connections panel, which stays mounted alongside this
   * one — and tags every settled read with the revision it was taken for.
   */
  const live = useDecisionProviderState();
  /**
   * The value a read produced for the CURRENT revision, or `undefined` while
   * a newer revision's read is still in flight: a result tagged with a
   * superseded revision is never reused as current state.
   */
  const currentRead = <T,>(read: TaggedRead<T> | null): T | undefined =>
    read !== null && read.key === live.revision ? read.value : undefined;
  const jevRead = currentRead(live.jev);
  const llmRead = currentRead(live.llm);
  /**
   * The configured custom Jev provider's egress origin. `null` while the read
   * is pending or failed (the failure renders its own retry below) and when
   * no custom provider is configured — the custom consent card only renders
   * once an origin exists to grant against (consent is per-origin).
   */
  const customOrigin = jevRead?.origin ?? null;
  const llmOrigin = llmRead?.origin ?? null;
  const escalation = llmRead?.escalation ?? null;
  /**
   * The provider actually rendered. The custom slot is the one selection that
   * can disappear — revoking that provider in the Connections panel leaves no
   * origin to consent at — so a selection whose read has settled as absent
   * falls back to the default: this card never asks for a grant at an origin
   * that is gone, and never shows another provider's consent state.
   */
  const selectedPreset: JevProviderId =
    presetId === CUSTOM_PROVIDER_ID &&
    jevRead !== undefined &&
    jevRead.origin === null
      ? "typesafe"
      : presetId;
  /**
   * The selected custom endpoint's origin is not known for the current
   * revision — either the read is still in flight, or it settled as failed.
   * Consent is per-origin, so until an origin exists neither the verdict nor
   * the grant/revoke control may render: `onGrant` would no-op against a null
   * origin and leave a live-looking button that does nothing.
   */
  const customOriginUnresolved =
    selectedPreset === CUSTOM_PROVIDER_ID && customOrigin === null;
  /**
   * The provider the current agreement was ticked for. Keying the box to the
   * selection means a selection that moves — including the fallback above —
   * can never carry a stale agreement into a different provider's grant.
   */
  const [agreedFor, setAgreedFor] = useState<JevProviderId | null>(null);
  const agreed = agreedFor === selectedPreset;
  // Read gate (options-popup plan Task 3): see ProviderSetup. Keyed to the
  // selected preset; switching presets, granting, or revoking re-arms.
  const [consentDisclosureOpen, setConsentDisclosureOpen] = useState(false);
  const [openedConsentPreset, setOpenedConsentPreset] =
    useState<JevProviderId | null>(null);
  const consentDisclosureRead = openedConsentPreset === selectedPreset;
  const consentDisclosureRef = useRef<HTMLDivElement | null>(null);
  const armConsentDisclosureGate = (): void => {
    setConsentDisclosureOpen(false);
    setOpenedConsentPreset(null);
  };
  // Clicking the agreement before reading should not feel dead: open the
  // disclosure for the selected provider and scroll it into view instead.
  const revealConsentDisclosure = (): void => {
    setConsentDisclosureOpen(true);
    setOpenedConsentPreset(selectedPreset);
    scrollDisclosureIntoView(consentDisclosureRef);
  };
  const [settings, setSettings] = useState<DecisionSettingsValue | null>(null);
  const [blocklist, setBlocklist] = useState<readonly string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [newEntry, setNewEntry] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Selected provider under the cursor — lets a user click win the race
   *  against the mount-time restore probe (same guard as ProviderSetup). */
  const currentPreset = useRef<JevProviderId>(presetId);

  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  // --- Automatic second opinions (escalation, spec FR6) --------------------
  // The worker owns the `llmEscalation` metadata row and the budget reads;
  // the page writes consent directly (Dexie is shared) after showing the
  // scope's disclosure verbatim — the same split as `jev_decisions` above.
  // The origin and escalation snapshot above are live reads of exactly that
  // worker state, so a provider enabled, capped, or revoked in the
  // Connections panel lands here without a reload.
  const [escalationAgreed, setEscalationAgreed] = useState(false);
  const [escalationBusy, setEscalationBusy] = useState(false);
  // Read gate for the escalation disclosure, keyed to the LLM origin so a
  // provider change re-arms it automatically; granting or revoking re-arms.
  const [escalationDisclosureOpen, setEscalationDisclosureOpen] =
    useState(false);
  const [escalationOpenedOrigin, setEscalationOpenedOrigin] = useState<
    string | null
  >(null);
  const escalationDisclosureRead =
    llmOrigin !== null && escalationOpenedOrigin === llmOrigin;
  const escalationDisclosureRef = useRef<HTMLDivElement | null>(null);
  // Same reveal-on-early-click behavior as the bookmark-analysis gate above.
  const revealEscalationDisclosure = (): void => {
    if (llmOrigin === null) return;
    setEscalationDisclosureOpen(true);
    setEscalationOpenedOrigin(llmOrigin);
    scrollDisclosureIntoView(escalationDisclosureRef);
  };
  const escalationDisclosure = LLM_SCOPE_DISCLOSURES[LLM_ESCALATE_SCOPE];

  /**
   * The origin the selected provider's `jev_decisions` grant lives at:
   * the preset's fixed registry origin, or the custom provider's resolved
   * origin. Consent is stored per-origin, so presets and custom use the
   * same read/write path here.
   */
  const consentOrigin =
    selectedPreset === CUSTOM_PROVIDER_ID
      ? customOrigin
      : PRESETS[selectedPreset].origin;
  const disclosure =
    selectedPreset === CUSTOM_PROVIDER_ID
      ? customJevDisclosure(customOrigin ?? undefined)
      : PROVIDER_DISCLOSURES[selectedPreset];

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
      consentOrigin === null
        ? Promise.resolve({ preset: selectedPreset, granted: false })
        : hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, consentOrigin)
            .then((granted) => ({ preset: selectedPreset, granted }))
            .catch(() => ({ preset: selectedPreset, granted: false })),
    [selectedPreset, consentOrigin],
  );

  /**
   * The verdict for the CURRENT provider only — `undefined` (pending) until
   * the query emits a read taken for this `selectedPreset`. The
   * mismatched-preset stale emission therefore renders "Checking consent…"
   * instead of flashing the prior provider's panel under the new disclosure.
   * A custom provider whose origin read has not settled — or has settled as
   * failed — for the current revision reads as unavailable too: a grant
   * action must never be offered against an origin that is unknown.
   */
  const consentGranted =
    customOriginUnresolved
      ? undefined
      : consentRead !== undefined && consentRead.preset === selectedPreset
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

  /**
   * Reopen the provider the user actually configured instead of always
   * landing on the first preset — the same restore order `ProviderSetup`
   * uses (first fully enabled, then the first that still has saved settings,
   * then the default). Applied once, from the first settled live read: a
   * later revision (the user enabling or revoking a provider elsewhere on
   * the page) refreshes the origins but never moves a selection the user
   * made. A click that lands before the first read settles still wins,
   * because `currentPreset` would no longer be the initial default.
   */
  const restoredSelection = useRef(false);
  useEffect(() => {
    if (restoredSelection.current || jevRead === undefined) return;
    restoredSelection.current = true;
    if (currentPreset.current !== "typesafe") return;
    if (
      jevRead.configured !== null &&
      jevRead.configured !== currentPreset.current
    ) {
      currentPreset.current = jevRead.configured;
      setPresetId(jevRead.configured);
    }
  }, [jevRead]);

  /** Re-run the settings read after a failure — the Retry button's action. */
  const onRetryLoad = () => {
    void loadSettings();
  };

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
        setEscalationDisclosureOpen(false);
        setEscalationOpenedOrigin(null);
        setNotice(
          grant
            ? "Second-opinion consent recorded. Escalation still needs the toggle below plus a spending ceiling (a monthly cap or unlimited) on the provider."
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

  /**
   * Flip the escalation flag through the worker. The worker persists the
   * `llmEscalation` row before it answers, so the resulting revision change
   * re-reads the snapshot below — the toggle renders the state the gate will
   * see, not a page-local guess.
   */
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
      })
      .catch(() => {
        setError("The extension worker did not answer the escalation write.");
      })
      .finally(() => setEscalationBusy(false));
  };

  const onPresetChange = (next: JevProviderId) => {
    currentPreset.current = next;
    setPresetId(next);
    setAgreedFor(null);
    armConsentDisclosureGate();
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
    if (!agreed || inFlight.current || consentOrigin === null) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Direct Dexie write: the gate re-verifies on every send, so the grant
    // is durable local state, not a message to the worker.
    void grantConsentAtOrigin(DECISIONS_CONSENT_SCOPE, consentOrigin)
      .then(() => {
        setAgreedFor(null);
        armConsentDisclosureGate();
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
    if (inFlight.current || consentOrigin === null) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Removes only the jev_decisions row — the provider's jev_test grant and
    // stored key are untouched.
    void revokeConsentAtOrigin(DECISIONS_CONSENT_SCOPE, consentOrigin)
      .then(() => {
        armConsentDisclosureGate();
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
    if (escalationConsentRead === undefined) {
      escalationPrerequisites.push({
        id: "consent-pending",
        text: "Checking second-opinion consent…",
      });
    } else if (escalationConsentRead === null) {
      escalationPrerequisites.push({
        id: "consent-unreadable",
        text: "Second-opinion consent could not be read on this device.",
      });
    } else if (!escalationConsentRead) {
      escalationPrerequisites.push({
        id: "consent",
        text: "Grant second-opinion consent above to turn this on.",
        actionLabel: "Review consent",
        target: "consent",
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
  /**
   * One reveal/jump runner for both the blocked switch and each step's
   * button. Called from event handlers only — never while rendering, which
   * keeps the disclosure ref read out of the render pass.
   */
  const runEscalationPrerequisite = (step: EscalationPrerequisite): void => {
    if (step.target === "consent") {
      revealEscalationDisclosure();
      return;
    }
    if (step.target === "connections" && step.anchorId !== undefined) {
      onNavigateToConnections?.(step.anchorId);
    }
  };
  const escalationFirstAction = escalationPrerequisites.find(
    (step) => step.actionLabel !== undefined && step.target !== undefined,
  );

  return (
    <div className="space-y-4">
      {/* Sub-card 1 — per-preset bookmark-analysis consent */}
      <section
        aria-labelledby="decisions-consent-heading"
        className={cardClass}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldIcon className="size-4" />
          </span>
          <h2 id="decisions-consent-heading" className={sectionHeadingClass}>
            Bookmark analysis consent
          </h2>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Provider</legend>
          <div className={radioGroupClass}>
            {PRESET_IDS.map((id) => (
              <ProviderCard
                key={id}
                name="decisions-provider"
                value={id}
                checked={selectedPreset === id}
                onChange={() => onPresetChange(id)}
                title={PROVIDER_DISCLOSURES[id].name}
                inputLabel={PROVIDER_DISCLOSURES[id].name}
                description={
                  consentRead !== undefined && consentRead.preset === id
                    ? consentRead.granted
                      ? "Consent granted"
                      : "Not consented"
                    : undefined
                }
              />
            ))}
            {customOrigin !== null && (
              <ProviderCard
                name="decisions-provider"
                value={CUSTOM_PROVIDER_ID}
                checked={selectedPreset === CUSTOM_PROVIDER_ID}
                onChange={() => onPresetChange(CUSTOM_PROVIDER_ID)}
                title={CUSTOM_JEV_PROVIDER_NAME}
                inputLabel={CUSTOM_JEV_PROVIDER_NAME}
                description={
                  consentRead !== undefined &&
                  consentRead.preset === CUSTOM_PROVIDER_ID
                    ? consentRead.granted
                      ? `Consent granted · ${customOrigin}`
                      : `Not consented · ${customOrigin}`
                    : customOrigin
                }
              />
            )}
          </div>
        </fieldset>

        {live.jevError !== null && (
          <p className="mt-3 text-sm text-muted-foreground">
            Could not read the provider status.
            <button
              type="button"
              onClick={live.retry}
              className={`ml-2 ${smallButtonClass}`}
            >
              Retry provider status
            </button>
          </p>
        )}

        <div className="mt-4" ref={consentDisclosureRef}>
          <Disclosure
            title={`What bookmark analysis sends to ${disclosure.name}`}
            open={consentDisclosureOpen}
            onOpenChange={(open) => {
              setConsentDisclosureOpen(open);
              if (open) setOpenedConsentPreset(selectedPreset);
            }}
            regionLabel={`${disclosure.name} bookmark data disclosure`}
          >
            <ConsentFacts
              recipientName={disclosure.name}
              origin={disclosure.origin}
              recipientNote={NO_DEVELOPER_SERVER_NOTE}
              sent={[...DECISIONS_SENT_FIELDS]}
              neverSent={[...DECISIONS_NEVER_SENT_FIELDS]}
              why={DECISIONS_PURPOSES.join(", ")}
              when={`${DECISIONS_TRIGGERS.join(", ")} — ${DECISIONS_TRIGGER_NOTE}`}
            >
              <p>{disclosure.dataNote}</p>
              {disclosure.privacyPolicyUrl !== undefined ? (
                <p>
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
                </p>
              ) : (
                <p>
                  A custom endpoint has no bundled policy link — review that
                  provider&apos;s own privacy policy, and{" "}
                  {EXTENSION_PRIVACY_POLICY_REFERENCE}.
                </p>
              )}
            </ConsentFacts>
          </Disclosure>
        </div>

        {consentGranted === undefined ? (
          // A failed status read is not "still checking": say why no consent
          // control is offered and point at the retry above, rather than
          // leaving a form whose Allow button would silently no-op.
          customOriginUnresolved && live.jevError !== null ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Consent for {disclosure.name} cannot be read or changed until
              the provider status is available — retry above.
            </p>
          ) : (
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              Checking consent…
            </p>
          )
        ) : consentGranted ? (
          // flex-wrap plus a non-shrinking, non-wrapping button: the longest
          // provider name ("Custom Jev provider") otherwise squeezed the
          // revoke label onto two lines inside its own border. When the pair
          // does not fit, the button drops to its own row instead.
          <div
            role="group"
            aria-label={`${disclosure.name} analysis consent`}
            className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-primary/30 bg-accent/40 px-3 py-2.5"
          >
            <p className="text-sm text-foreground">
              {disclosure.name} may receive the bookmark metadata listed above.
            </p>
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className={`${ghostDangerButtonClass} shrink-0 whitespace-nowrap`}
            >
              Revoke {disclosure.name} analysis consent
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={agreed}
                aria-disabled={consentDisclosureRead ? undefined : "true"}
                aria-describedby={
                  consentDisclosureRead ? undefined : "decisions-disclosure-gate"
                }
                onChange={(event) => {
                  // The tick is only an affirmation once the disclosure has
                  // actually been read; an early click reveals it instead.
                  if (!consentDisclosureRead) {
                    revealConsentDisclosure();
                    return;
                  }
                  setAgreedFor(event.target.checked ? selectedPreset : null);
                }}
              />
              I have read the disclosure above and agree to send bookmark
              metadata to {disclosure.name}.
            </label>
            {!consentDisclosureRead && (
              <p
                id="decisions-disclosure-gate"
                className="text-xs text-muted-foreground"
              >
                Open the disclosure above first.
              </p>
            )}
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

      {/* Sub-card 2 — auto-apply switches */}
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
            onRetry={onRetryLoad}
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
      </section>

      {/* Sub-card 3 — second opinions (escalation) */}
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
          floor may get a second opinion from the LLM provider configured
          above — inside a Save, Analyze, or library scan you started, and
          only while the monthly cap allows it. The verdict is advisory: the
          suggestion still waits for your review.
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
            Configure and enable an LLM provider above to use second
            opinions.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <div ref={escalationDisclosureRef}>
              <Disclosure
                title={escalationDisclosure.title}
                open={escalationDisclosureOpen}
                onOpenChange={(open) => {
                  setEscalationDisclosureOpen(open);
                  if (open && llmOrigin !== null) {
                    setEscalationOpenedOrigin(llmOrigin);
                  }
                }}
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
            </div>

            {escalationConsentRead === null ? null : !escalationConsentRead ? (
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={escalationAgreed}
                    disabled={escalationBusy}
                    aria-disabled={
                      escalationBusy || !escalationDisclosureRead
                        ? "true"
                        : undefined
                    }
                    aria-describedby={
                      escalationDisclosureRead
                        ? undefined
                        : "escalation-disclosure-gate"
                    }
                    onChange={(event) => {
                      // The tick is only an affirmation once the disclosure
                      // has actually been read; an early click reveals it.
                      if (!escalationDisclosureRead) {
                        revealEscalationDisclosure();
                        return;
                      }
                      setEscalationAgreed(event.target.checked);
                    }}
                  />
                  I allow second opinions to be sent to {llmOrigin}
                </label>
                {!escalationDisclosureRead && (
                  <p
                    id="escalation-disclosure-gate"
                    className="basis-full text-xs text-muted-foreground"
                  >
                    Open the disclosure above first.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => onEscalationConsent(true)}
                  disabled={!escalationAgreed || escalationBusy}
                  className={smallButtonClass}
                >
                  Allow second opinions
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onEscalationConsent(false)}
                disabled={escalationBusy}
                className={ghostDangerButtonClass}
              >
                Revoke second-opinion consent
              </button>
            )}

            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <span className="text-sm">
                Ask the provider for a second opinion on unsure suggestions
              </span>
              <Switch
                aria-label="Ask the provider for a second opinion on unsure suggestions"
                checked={escalationEnabled}
                // Hard-disable only while a write is in flight; a missing
                // prerequisite soft-blocks (reason list + reveal on click).
                disabled={escalationBusy || escalation === null}
                blocked={escalationBlocked}
                onBlocked={
                  escalationFirstAction !== undefined
                    ? () => runEscalationPrerequisite(escalationFirstAction)
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
                                  onClick={() =>
                                    runEscalationPrerequisite(step)
                                  }
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
          </div>
        )}
      </section>

      {/* Sub-card 4 — blocklist */}
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
              <Field label="Block a host" htmlFor="blocklist-entry" className="min-w-0 flex-1">
                <input
                  id="blocklist-entry"
                  type="text"
                  value={newEntry}
                  onChange={(event) => setNewEntry(event.target.value)}
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
            open={false}
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
      </section>

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
    </div>
  );
}
