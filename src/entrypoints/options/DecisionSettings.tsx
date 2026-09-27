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
} from "../../consent/records";
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
  PresetId,
} from "../../schemas/provider";

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

export function DecisionSettings() {
  const [presetId, setPresetId] = useState<PresetId>("typesafe");
  const [agreed, setAgreed] = useState(false);
  const [settings, setSettings] = useState<DecisionSettingsValue | null>(null);
  const [blocklist, setBlocklist] = useState<readonly string[] | null>(null);
  const [newEntry, setNewEntry] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  const disclosure = PROVIDER_DISCLOSURES[presetId];

  /**
   * The current provider's `jev_decisions` grant, live from `db.consents`.
   * `undefined` while the first read is in flight. A stale `consentVersion`
   * row reads as `false`, so a re-disclosure is just this screen again.
   */
  const consentGranted = useLiveQuery(
    () =>
      hasConsent(DECISIONS_CONSENT_SCOPE, presetId).catch(
        (): boolean => false,
      ),
    [presetId],
  );

  /**
   * Read the settings/blocklist snapshot through the decisions protocol.
   * The worker stays the owner of `DecisionSettings`; the page never writes
   * `decisions:settings` directly.
   */
  const loadSettings = useCallback(async () => {
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
    }
  }, []);

  // Load once on mount; the microtask boundary keeps the fetch a subscription
  // callback, not a synchronous state write in the effect body.
  useEffect(() => {
    queueMicrotask(() => {
      void loadSettings();
    });
  }, [loadSettings]);

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
      className="mx-auto max-w-xl p-6"
    >
      <h2 id="decisions-heading" className="text-lg font-medium">
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
          {PRESET_IDS.map((id) => (
            <label key={id} className="mt-1 flex items-center gap-2 text-sm">
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
        </fieldset>

        <section
          aria-label={`${disclosure.name} bookmark data disclosure`}
          className="mt-4 rounded border border-gray-300 p-3 text-sm"
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
                  <code className="rounded bg-gray-100 px-1">{field}</code>
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
                className="text-blue-700 underline"
              >
                {disclosure.name} privacy policy
              </a>{" "}
              and {EXTENSION_PRIVACY_POLICY_REFERENCE}.
            </li>
          </ul>
        </section>

        {consentGranted === undefined ? (
          <p role="status" className="mt-3 text-sm text-gray-700">
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
              className="mt-3 rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
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
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Allow {disclosure.name} bookmark analysis
            </button>
            <p className="text-xs text-gray-600">
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
        <p className="mt-1 text-sm text-gray-700">
          A decision can apply itself only at confidence {">="}{" "}
          {AUTO_APPLY_THRESHOLD} and only for the kinds enabled here — every
          other suggestion always waits for review. Both toggles stay off
          unless you turn them on.
        </p>
        {settings === null ? (
          <p role="status" className="mt-2 text-sm text-gray-700">
            Loading decision settings…
          </p>
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

      <section aria-labelledby="blocklist-heading" className="mt-6">
        <h3 id="blocklist-heading" className="font-medium">
          Never send these sites
        </h3>
        <p className="mt-1 text-sm text-gray-700">
          Bookmarks on these hosts are never sent to a provider, no matter
          what is consented above.
        </p>
        {blocklist === null ? (
          <p role="status" className="mt-2 text-sm text-gray-700">
            Loading the blocklist…
          </p>
        ) : (
          <>
            {blocklist.length === 0 ? (
              <p className="mt-2 text-sm text-gray-600">
                No sites blocked yet.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {blocklist.map((entry) => (
                  <li
                    key={entry}
                    className="flex items-center gap-2 text-sm"
                  >
                    <code className="rounded bg-gray-100 px-1">{entry}</code>
                    <button
                      type="button"
                      aria-label={`Remove ${entry}`}
                      onClick={() => onRemoveEntry(entry)}
                      disabled={busy}
                      className="rounded border border-gray-300 px-2 py-0.5 text-xs disabled:opacity-50"
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
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={onAddEntry}
                disabled={busy || newEntry.trim() === ""}
                className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </>
        )}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-gray-700">
            Built-in blocklist — {BUILTIN_SENSITIVE_SITES.length} sites
            (always applies, not editable)
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {BUILTIN_SENSITIVE_SITES.map((site) => (
              <li key={site}>
                <code className="rounded bg-gray-100 px-1">{site}</code>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {notice !== null && (
        <p role="status" className="mt-3 text-sm text-green-700">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
