import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTHORIZATION_HEADER,
  CONSENT_PURPOSE,
  CONSENT_TRIGGER,
  CUSTOM_JEV_PROVIDER_NAME,
  customJevDisclosure,
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
import { LlmBaseUrl } from "../../schemas/llm";
import {
  CUSTOM_PROVIDER_ID,
  DEFAULT_PROVIDER_MODEL,
  JEV_PROVIDER_IDS,
  type JevProviderId,
  PRESET_MODELS,
} from "../../schemas/provider";
import {
  Alert,
  Chip,
  Disclosure,
  Field,
  ProviderCard,
  StatusBadge,
} from "./components";
import { InfoIcon, PlugIcon, WarningIcon } from "../../ui/components/icons";
import {
  cardClass,
  ghostDangerButtonClass,
  inputClass,
  primaryButtonClass,
  radioGroupClass,
  secondaryButtonClass,
  sectionHeadingClass,
} from "./ui";

/** One-line context shown on each provider picker card. */
const PROVIDER_CARD_DESCRIPTIONS: Record<JevProviderId, string> = {
  typesafe: "The curated Jev endpoint — the reference provider.",
  openrouter: "Jev via OpenRouter — use your own OpenRouter key.",
  [CUSTOM_PROVIDER_ID]:
    "Any System One-compatible Jev endpoint — your base URL and model id.",
};

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

const PROVIDER_IDS = JEV_PROVIDER_IDS;

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
  const [presetId, setPresetId] = useState<JevProviderId>("typesafe");
  const [model, setModel] = useState<string>(DEFAULT_PROVIDER_MODEL.typesafe);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [deleteStoredKey, setDeleteStoredKey] = useState(true);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);

  // The custom provider's destination is derived from the typed base URL
  // — parsed with the same canonical-URL schema the worker re-verifies —
  // or, once enabled, from the stored row's reported origin.
  const customParsed = LlmBaseUrl.safeParse(baseUrl.trim());
  const customUrl = customParsed.success
    ? new URL(customParsed.data)
    : null;
  const isCustom = presetId === CUSTOM_PROVIDER_ID;
  const customOrigin = isCustom
    ? (status?.origin ?? customUrl?.origin)
    : undefined;
  const disclosure = isCustom
    ? customJevDisclosure(customOrigin)
    : PROVIDER_DISCLOSURES[presetId];
  // The host-permission pattern the enable click requests: the preset's
  // fixed pattern, or the custom endpoint's computed origin pattern (null
  // while the typed URL is not yet a valid canonical base URL).
  const destinationPattern = isCustom
    ? customUrl === null
      ? null
      : `${customUrl.protocol}//${customUrl.hostname}/*`
    : PRESETS[presetId].permissionPattern;

  // Guards against a status reply for a stale preset landing after the user
  // switched providers.
  const currentPreset = useRef<JevProviderId>(presetId);
  // Synchronous reentrancy guard — `busy` state lags a fast double click.
  const inFlight = useRef(false);

  const loadStatus = useCallback(async (preset: JevProviderId) => {
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

  const onPresetChange = (next: JevProviderId) => {
    currentPreset.current = next;
    setPresetId(next);
    setStatus(null);
    setModel(
      next === CUSTOM_PROVIDER_ID ? "" : DEFAULT_PROVIDER_MODEL[next],
    );
    setBaseUrl("");
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
    // A custom provider additionally needs a valid canonical base URL and
    // a non-empty model id — the worker re-parses both anyway.
    (presetId !== CUSTOM_PROVIDER_ID ||
      (customUrl !== null && model.trim().length > 0)) &&
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
    // For a preset the pattern is fixed; for custom it comes from the
    // validated base URL — canEnable already excluded a null pattern, and
    // the early return keeps the permission request exact anyway.
    if (destinationPattern === null) {
      inFlight.current = false;
      setBusy(false);
      return;
    }
    let permissionRequest: Promise<boolean>;
    try {
      permissionRequest = chrome.permissions.request({
        origins: [destinationPattern],
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
            model: isCustom ? model.trim() : model,
            key: apiKey,
            ...(isCustom && customParsed.success
              ? { baseUrl: customParsed.data }
              : {}),
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
    <section aria-labelledby="provider-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <PlugIcon className="size-4" />
          </span>
          <h2 id="provider-heading" className={sectionHeadingClass}>
            AI provider connection
          </h2>
        </div>
        {status !== null && <StatusBadge on={status.enabled} />}
      </div>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Provider</legend>
        <div className={radioGroupClass}>
          {PROVIDER_IDS.map((id) => (
            <ProviderCard
              key={id}
              name="provider"
              value={id}
              checked={presetId === id}
              onChange={() => onPresetChange(id)}
              title={
                id === CUSTOM_PROVIDER_ID
                  ? CUSTOM_JEV_PROVIDER_NAME
                  : PROVIDER_DISCLOSURES[id].name
              }
              inputLabel={
                id === CUSTOM_PROVIDER_ID
                  ? CUSTOM_JEV_PROVIDER_NAME
                  : PROVIDER_DISCLOSURES[id].name
              }
              description={PROVIDER_CARD_DESCRIPTIONS[id]}
            />
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        <Disclosure
          title={`What enabling ${disclosure.name} means`}
          subtitle="Read before enabling — this is what your consent covers."
          open={!status?.enabled}
          regionLabel={`${disclosure.name} data disclosure`}
        >
          <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Recipient: {disclosure.name} at {disclosure.origin} — the only
              destination this consent covers.
            </li>
            <li>
              What is sent: {SYNTHETIC_DESCRIPTION}, with exactly the fields{" "}
              {SYNTHETIC_FIELDS.map((field) => (
                <code key={field} className="rounded bg-muted px-1">
                  {field}
                </code>
              ))}
              .
            </li>
            <li>
              Your API key travels only in the{" "}
              <code className="rounded bg-muted px-1">
                {AUTHORIZATION_HEADER}
              </code>{" "}
              header to {disclosure.origin}. It is stored encrypted on this
              device and never shown again.
            </li>
            <li>Why: {CONSENT_PURPOSE}.</li>
            <li>When: {CONSENT_TRIGGER}.</li>
            <li>{disclosure.dataNote}</li>
            {disclosure.privacyPolicyUrl !== undefined ? (
              <li>
                Read the{" "}
                <a
                  href={disclosure.privacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
                >
                  {disclosure.name} privacy policy
                </a>
                ; this extension&apos;s own draft policy is bundled below.
              </li>
            ) : (
              <li>
                A custom endpoint has no bundled policy link — review that
                provider&apos;s own privacy policy; this extension&apos;s
                draft policy is bundled below.
              </li>
            )}
          </ul>
        </Disclosure>
      </div>

      {status?.enabled ? (
        <div
          role="group"
          aria-label={`${disclosure.name} enabled provider`}
          className="mt-5"
        >
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <span className="text-sm text-muted-foreground">
              {disclosure.name} is enabled
            </span>
            <span className="hidden text-border sm:inline">·</span>
            <Chip>{status.model}</Chip>
            <Chip>…{status.keySuffix}</Chip>
            <Chip>{status.origin ?? disclosure.origin}</Chip>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className={secondaryButtonClass}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <p className="text-xs text-muted-foreground">
              Sends the disclosed synthetic request to {disclosure.origin} —
              nothing else leaves this device.
            </p>
          </div>

          {testOutcome !== null && (
            <div className="mt-3">
              <Alert tone={testOutcome.ok ? "success" : "error"}>
                {testOutcome.ok ? (
                  <>
                    Connection test succeeded — model{" "}
                    <code className="rounded bg-muted px-1">
                      {testOutcome.model}
                    </code>{" "}
                    answered in {Math.round(testOutcome.latencyMs)} ms
                    {testOutcome.cost !== undefined &&
                      `; request cost $${testOutcome.cost}`}
                    .
                  </>
                ) : (
                  <>
                    Connection test failed ({testOutcome.code}):{" "}
                    {testOutcome.message}
                  </>
                )}
              </Alert>
            </div>
          )}

          <div className="mt-5 border-t border-border pt-4">
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
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className={`mt-3 ${ghostDangerButtonClass}`}
            >
              Revoke {disclosure.name} access
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {presetId === CUSTOM_PROVIDER_ID ? (
            <>
              <Field
                label="Base URL"
                htmlFor="provider-base-url"
                hint="HTTPS required; plain HTTP is allowed only for localhost, 127.0.0.1, or [::1]. Requests go to <base URL>/systemone."
              >
                <input
                  id="provider-base-url"
                  type="text"
                  autoComplete="off"
                  placeholder="https://ai.example.com/api"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Model ID"
                htmlFor="provider-model"
                hint="The Jev model id this endpoint serves."
              >
                <input
                  id="provider-model"
                  type="text"
                  autoComplete="off"
                  placeholder="jev-latest"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className={inputClass}
                />
              </Field>
            </>
          ) : (
            <Field label="Model" htmlFor="provider-model">
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
                className={inputClass}
              >
                {PRESET_MODELS[presetId].map((allowed) => (
                  <option key={allowed} value={allowed}>
                    {allowed}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {presetId !== CUSTOM_PROVIDER_ID &&
            isMovingAlias(presetId, model) && (
            <p className="-mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
              <span role="status" id="provider-model-alias-warning">
                <code className="rounded bg-muted px-1">{model}</code>{" "}
                {MOVING_ALIAS_WARNING}
              </span>
            </p>
          )}
          {presetId !== CUSTOM_PROVIDER_ID &&
            isPinnedReleaseModel(presetId, model) && (
            <p
              role="status"
              id="provider-model-pinned-note"
              className="-mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <code className="rounded bg-muted px-1">{model}</code>{" "}
                {PINNED_RELEASE_NOTE}
              </span>
            </p>
          )}
          <Field
            label="API key"
            htmlFor="api-key"
            hint="Stored encrypted on this device — never shown again."
          >
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className={inputClass}
            />
          </Field>
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
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable}
            className={primaryButtonClass}
          >
            Enable {disclosure.name}
          </button>
        </div>
      )}

      {status === null && (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Checking the current provider status…
        </p>
      )}
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
    </section>
  );
}
