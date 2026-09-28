import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTHORIZATION_HEADER,
  CONSENT_PURPOSE,
  CONSENT_TRIGGER,
  PROVIDER_DISCLOSURES,
  SYNTHETIC_DESCRIPTION,
  SYNTHETIC_FIELDS,
} from "../../consent/disclosure";
import {
  ProviderMessage,
  ProviderMessageResult,
  type ProviderStatus,
} from "../../messages/provider";
import { PRESETS } from "../../net/presets";
import {
  isMovingAlias,
  isPinnedReleaseModel,
  MOVING_ALIAS_WARNING,
  PINNED_RELEASE_NOTE,
} from "../../net/provider-info";
import {
  DEFAULT_PROVIDER_MODEL,
  PRESET_MODELS,
  PresetId,
} from "../../schemas/provider";
import { PrivacyDraft } from "./PrivacyDraft";

/**
 * Options-page provider consent flow (plan Phase 2 Task 4): disclosure →
 * unchecked affirmative checkbox → Enable click → `chrome.permissions.request`
 * (synchronous in the click handler — Chrome requires a user gesture) →
 * ENABLE_PROVIDER message → worker re-verifies and persists settings +
 * encrypted key + consent.
 *
 * `chrome` here is the lazy-slice house pattern: only `permissions.request`
 * and `runtime.sendMessage` are used, so `vi.stubGlobal` works in tests. The
 * imported wire schemas validate both directions; the worker-only key
 * functions that `messages/provider` also exports are never invoked on this
 * surface. The raw key lives only in this field's state and the enable
 * message — it is cleared as soon as the worker reports success and is never
 * rendered, persisted, or re-displayed (only the masked `keySuffix` is).
 */
declare const chrome: {
  permissions: {
    request(permissions: { origins?: string[] }): Promise<boolean>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

const PRESET_IDS = PresetId.options;

/**
 * What the Test connection button last reported: the worker's typed success
 * (`model`/`latencyMs`/optional `cost`) or its redacted failure code/message.
 * Rendered verbatim — the worker already guarantees nothing sensitive
 * crosses the boundary.
 */
type TestOutcome =
  | { ok: true; model: string; latencyMs: number; cost?: number }
  | { ok: false; code: string; message: string };

export function ProviderSetup() {
  const [presetId, setPresetId] = useState<PresetId>("typesafe");
  const [model, setModel] = useState<string>(DEFAULT_PROVIDER_MODEL.typesafe);
  const [apiKey, setApiKey] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [deleteStoredKey, setDeleteStoredKey] = useState(true);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);

  const disclosure = PROVIDER_DISCLOSURES[presetId];
  const preset = PRESETS[presetId];
  const models = PRESET_MODELS[presetId];

  // Guards against a status reply for a stale preset landing after the user
  // switched providers.
  const currentPreset = useRef<PresetId>(presetId);
  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  const loadStatus = useCallback(async (preset: PresetId) => {
    try {
      const raw = await chrome.runtime.sendMessage(
        ProviderMessage.parse({ type: "PROVIDER_STATUS", preset }),
      );
      if (preset !== currentPreset.current) {
        return;
      }
      const result = ProviderMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "status" in result.data) {
        setStatus(result.data.status);
      } else {
        setStatus({ enabled: false, consentGranted: false });
        setError("The extension worker did not return a provider status.");
      }
    } catch {
      if (preset !== currentPreset.current) {
        return;
      }
      setStatus({ enabled: false, consentGranted: false });
      setError("The extension worker did not return a provider status.");
    }
  }, []);

  // Restore the selected provider's persisted state whenever it changes. The
  // microtask boundary makes the fetch a subscription callback, not a
  // synchronous state write in the effect body.
  useEffect(() => {
    currentPreset.current = presetId;
    queueMicrotask(() => {
      void loadStatus(presetId);
    });
  }, [presetId, loadStatus]);

  const onPresetChange = (next: PresetId) => {
    currentPreset.current = next;
    setPresetId(next);
    setStatus(null);
    setModel(DEFAULT_PROVIDER_MODEL[next]);
    setApiKey("");
    setAgreed(false);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
  };

  // Enable stays disabled until the unchecked agreement box is checked, a key
  // is entered, and the current preset's status has loaded.
  const canEnable =
    status !== null &&
    !status.enabled &&
    agreed &&
    apiKey.length > 0 &&
    !busy;

  const onEnable = () => {
    if (!canEnable || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
    // This call must stay synchronous inside the click handler — Chrome only
    // accepts permissions.request from a direct user gesture. A synchronous
    // throw (not a rejection) would skip the .catch/.finally below and leave
    // inFlight/busy stuck, wedging every button until reload — reset the
    // guards and surface the same notice a rejection would.
    let permissionRequest: Promise<boolean>;
    try {
      permissionRequest = chrome.permissions.request({
        origins: [preset.permissionPattern],
      });
    } catch {
      inFlight.current = false;
      setBusy(false);
      setError("Something went wrong while enabling the provider.");
      return;
    }
    void permissionRequest
      .then(async (granted) => {
        // A reply for a preset the user has since switched away from is
        // dropped — the outcome belongs to the panel that requested it.
        if (presetId !== currentPreset.current) {
          return;
        }
        if (!granted) {
          // Cancellation or denial leaves the provider disabled and sends
          // nothing — no worker message is sent at all.
          setError(
            `Chrome did not grant access to ${disclosure.origin}. ${disclosure.name} stays off — nothing was saved or sent.`,
          );
          return;
        }
        const raw = await chrome.runtime.sendMessage(
          ProviderMessage.parse({
            type: "ENABLE_PROVIDER",
            preset: presetId,
            model,
            key: apiKey,
          }),
        );
        // The same drop after the worker's reply — a switch during the
        // request must not render this preset's status on the new panel.
        if (presetId !== currentPreset.current) {
          return;
        }
        const result = ProviderMessageResult.safeParse(raw);
        if (!result.success) {
          setError("The extension worker returned an unexpected response.");
          void loadStatus(presetId);
        } else if (!result.data.ok) {
          setError(result.data.message);
          void loadStatus(presetId);
        } else if ("status" in result.data) {
          setStatus(result.data.status);
          setApiKey("");
          setAgreed(false);
          setNotice(`${disclosure.name} is enabled.`);
        } else {
          // A test_ok reply to an enable call is a protocol mix-up — treat it
          // like any other unexpected response.
          setError("The extension worker returned an unexpected response.");
          void loadStatus(presetId);
        }
      })
      .catch(() => {
        if (presetId === currentPreset.current) {
          setError("Something went wrong while enabling the provider.");
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const onRevoke = () => {
    if (busy || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
    void chrome.runtime
      .sendMessage(
        ProviderMessage.parse({
          type: "REVOKE_PROVIDER",
          preset: presetId,
          deleteKey: deleteStoredKey,
        }),
      )
      .then((raw) => {
        // A reply for a preset the user has since switched away from is
        // dropped — the outcome belongs to the panel that requested it.
        if (presetId !== currentPreset.current) {
          return;
        }
        const result = ProviderMessageResult.safeParse(raw);
        if (!result.success) {
          setError("The extension worker returned an unexpected response.");
          void loadStatus(presetId);
        } else if (!result.data.ok) {
          setError(result.data.message);
          // A failed revoke may still have removed consent — refresh.
          void loadStatus(presetId);
        } else if ("status" in result.data) {
          setStatus(result.data.status);
          setAgreed(false);
          setNotice(
            `${disclosure.name} consent and browser access were removed.`,
          );
        } else {
          setError("The extension worker returned an unexpected response.");
          void loadStatus(presetId);
        }
      })
      .catch(() => {
        if (presetId === currentPreset.current) {
          setError("Something went wrong while revoking the provider.");
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  // The only user action that produces network traffic: one TEST_PROVIDER
  // message per explicit click. The worker re-checks the preset is fully
  // enabled and tests the stored model — the page never picks a model or
  // sends key material here. Mount and preset switches never call this.
  const onTest = () => {
    if (busy || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setTesting(true);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
    void chrome.runtime
      .sendMessage(
        ProviderMessage.parse({ type: "TEST_PROVIDER", preset: presetId }),
      )
      .then((raw) => {
        // A reply for a preset the user has since switched away from is
        // dropped — the outcome belongs to the panel that requested it.
        if (presetId !== currentPreset.current) {
          return;
        }
        const result = ProviderMessageResult.safeParse(raw);
        if (result.success && result.data.ok && "result" in result.data) {
          setTestOutcome({ ok: true, ...result.data.result });
        } else if (result.success && !result.data.ok) {
          // The worker's failure code/message are already redacted — render
          // them verbatim.
          setTestOutcome({
            ok: false,
            code: result.data.code,
            message: result.data.message,
          });
        } else {
          setTestOutcome({
            ok: false,
            code: "internal_error",
            message: "The extension worker returned an unexpected response.",
          });
        }
      })
      .catch(() => {
        if (presetId === currentPreset.current) {
          setTestOutcome({
            ok: false,
            code: "internal_error",
            message: "Something went wrong while testing the connection.",
          });
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
        setTesting(false);
      });
  };

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-xl font-semibold">Bookmarks Manager Options</h1>
      <section aria-labelledby="provider-heading" className="mt-6">
        <h2 id="provider-heading" className="text-lg font-medium">
          AI provider connection
        </h2>

        <fieldset className="mt-3">
          <legend className="text-sm font-medium">Provider</legend>
          {PRESET_IDS.map((id) => (
            <label
              key={id}
              className="mt-1 flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="provider"
                value={id}
                checked={presetId === id}
                onChange={() => onPresetChange(id)}
              />
              {PROVIDER_DISCLOSURES[id].name}
            </label>
          ))}
        </fieldset>

        <section
          aria-label={`${disclosure.name} data disclosure`}
          className="mt-4 rounded border border-gray-300 p-3 text-sm"
        >
          <h3 className="font-medium">
            What enabling {disclosure.name} means
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Recipient: {disclosure.name} at {disclosure.origin} — the only
              destination this consent covers.
            </li>
            <li>
              What is sent: {SYNTHETIC_DESCRIPTION}, with exactly the fields{" "}
              {SYNTHETIC_FIELDS.map((field) => (
                <code
                  key={field}
                  className="rounded bg-gray-100 px-1"
                >
                  {field}
                </code>
              ))}
              .
            </li>
            <li>
              Your API key travels only in the{" "}
              <code className="rounded bg-gray-100 px-1">
                {AUTHORIZATION_HEADER}
              </code>{" "}
              header to {disclosure.origin}. It is stored encrypted on this
              device and never shown again.
            </li>
            <li>Why: {CONSENT_PURPOSE}.</li>
            <li>When: {CONSENT_TRIGGER}.</li>
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
              </a>
              ; this extension&apos;s own draft policy is bundled below.
            </li>
          </ul>
        </section>

        {status?.enabled ? (
          <div
            role="group"
            aria-label={`${disclosure.name} enabled provider`}
            className="mt-4"
          >
            <p className="text-sm">
              {disclosure.name} is enabled — model{" "}
              <code className="rounded bg-gray-100 px-1">{status.model}</code>,
              key ending in{" "}
              <code className="rounded bg-gray-100 px-1">
                {status.keySuffix}
              </code>
              .
            </p>
            <div className="mt-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={deleteStoredKey}
                  onChange={(event) =>
                    setDeleteStoredKey(event.target.checked)
                  }
                />
                Also delete the stored provider key from this device
              </label>
            </div>
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className="mt-3 rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Revoke {disclosure.name} access
            </button>
            <div className="mt-4 border-t border-gray-200 pt-3">
              <button
                type="button"
                onClick={onTest}
                disabled={busy}
                className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
              <p className="mt-1 text-xs text-gray-600">
                Sends the disclosed synthetic request to {disclosure.origin}{" "}
                — nothing else leaves this device.
              </p>
              {testOutcome !== null && testOutcome.ok && (
                <p role="status" className="mt-2 text-sm text-green-700">
                  Connection test succeeded — model{" "}
                  <code className="rounded bg-gray-100 px-1">
                    {testOutcome.model}
                  </code>{" "}
                  answered in {Math.round(testOutcome.latencyMs)} ms
                  {testOutcome.cost !== undefined &&
                    `; request cost $${testOutcome.cost}`}
                  .
                </p>
              )}
              {testOutcome !== null && !testOutcome.ok && (
                <p role="alert" className="mt-2 text-sm text-red-700">
                  Connection test failed ({testOutcome.code}):{" "}
                  {testOutcome.message}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="provider-model" className="block text-sm font-medium">
                Model
              </label>
              <select
                id="provider-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                aria-describedby={
                  isMovingAlias(presetId, model)
                    ? "provider-model-alias-warning"
                    : isPinnedReleaseModel(presetId, model)
                      ? "provider-model-pinned-note"
                      : undefined
                }
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {models.map((allowed) => (
                  <option key={allowed} value={allowed}>
                    {allowed}
                  </option>
                ))}
              </select>
              {isMovingAlias(presetId, model) && (
                <p
                  role="status"
                  id="provider-model-alias-warning"
                  className="mt-1 text-xs text-amber-700"
                >
                  <code className="rounded bg-gray-100 px-1">{model}</code>{" "}
                  {MOVING_ALIAS_WARNING}
                </p>
              )}
              {isPinnedReleaseModel(presetId, model) && (
                <p
                  role="status"
                  id="provider-model-pinned-note"
                  className="mt-1 text-xs text-gray-500"
                >
                  <code className="rounded bg-gray-100 px-1">{model}</code>{" "}
                  {PINNED_RELEASE_NOTE}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="api-key" className="block text-sm font-medium">
                API key
              </label>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                I have read the disclosure above and agree to enable{" "}
                {disclosure.name}.
              </label>
            </div>
            <button
              type="button"
              onClick={onEnable}
              disabled={!canEnable}
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Enable {disclosure.name}
            </button>
          </div>
        )}

        {status === null && (
          <p role="status" className="mt-3 text-sm text-gray-700">
            Checking the current provider status…
          </p>
        )}
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
      <PrivacyDraft />
    </main>
  );
}
