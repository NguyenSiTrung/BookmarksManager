import { useCallback, useEffect, useRef, useState } from "react";
import {
  LLM_SCOPE_DISCLOSURES,
  LLM_NEVER_SENT,
} from "../../consent/disclosure";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
  type LlmProviderStatus,
} from "../../messages/llm-provider";
import { LLM_PRESETS, resolveLlmDestination } from "../../llm/providers";
import {
  LlmAuthMode,
  LlmProviderSettings,
  type LlmPresetId,
} from "../../schemas/llm";
import { LlmBudget } from "./LlmBudget";

/**
 * Options-page LLM provider consent flow (plan Phase 2 Task 5): disclosure →
 * unchecked affirmative checkbox → Enable click → `chrome.permissions.request`
 * for the exact resolved origin (synchronous in the click handler — Chrome
 * requires a user gesture) → `LLM_CONFIGURE` message → worker re-verifies
 * and persists record + encrypted credential + `llm_test` consent.
 *
 * The raw key lives only in this field's state and the configure message —
 * cleared as soon as the worker reports success, never rendered, persisted,
 * or re-displayed (only the masked `keySuffix` is). Mount issues only a
 * status lookup (and, when enabled, a budget snapshot); Test connection is
 * the single user action that can produce provider traffic.
 */
declare const chrome: {
  permissions: {
    request(permissions: { origins?: string[] }): Promise<boolean>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

type ProviderKind = LlmPresetId | "custom";

const PRESET_KINDS = ["openai", "openrouter"] as const;

const TEST_DISCLOSURE = LLM_SCOPE_DISCLOSURES.llm_test;

type TestOutcome =
  | {
      ok: true;
      model: string;
      latencyMs: number;
      tier: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        costUsd?: number;
      };
    }
  | { ok: false; code: string; message: string };

function presetOrigin(kind: LlmPresetId): string {
  return new URL(LLM_PRESETS[kind].baseUrl).origin;
}

export function LlmProviderSetup() {
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [model, setModel] = useState<string>(LLM_PRESETS.openai.defaultModel);
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<LlmAuthMode>("bearer");
  const [apiKey, setApiKey] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [budgetCap, setBudgetCap] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [deleteStoredKey, setDeleteStoredKey] = useState(true);
  const [status, setStatus] = useState<LlmProviderStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);

  // Guards against a reply landing after the user switched provider kind or
  // started a newer request — stale outcomes belong to the panel that
  // requested them.
  const epoch = useRef(0);
  const inFlight = useRef(false);

  const loadStatus = useCallback(async () => {
    const mine = epoch.current;
    try {
      const raw = await chrome.runtime.sendMessage(
        LlmProviderMessage.parse({ type: "LLM_PROVIDER_STATUS" }),
      );
      if (epoch.current !== mine) return;
      const result = LlmProviderMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "status" in result.data) {
        setStatus(result.data.status);
      } else {
        setStatus({
          configured: false,
          enabled: false,
          consentGranted: false,
          permissionGranted: false,
          active: false,
        });
        setError("The extension worker did not return a provider status.");
      }
    } catch {
      if (epoch.current !== mine) return;
      setError("The extension worker did not return a provider status.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadStatus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKindChange = (next: ProviderKind) => {
    epoch.current += 1;
    setKind(next);
    if (next === "openai" || next === "openrouter") {
      setModel(LLM_PRESETS[next].defaultModel);
    } else {
      setModel("");
    }
    setError(null);
    setNotice(null);
    setTestOutcome(null);
  };

  /** Assemble and validate the settings for the selected kind. */
  function buildSettings():
    | { settings: LlmProviderSettings }
    | { error: string } {
    if (kind !== "custom") {
      const parsed = LlmProviderSettings.safeParse({
        kind: "preset",
        preset: kind,
        model: model.trim() || LLM_PRESETS[kind].defaultModel,
      });
      if (!parsed.success) {
        return { error: "The selected model is not valid." };
      }
      return { settings: parsed.data };
    }
    const pricingInput = inputPrice.trim();
    const pricingOutput = outputPrice.trim();
    let pricing:
      | { inputPerMillion: number; outputPerMillion: number }
      | undefined;
    if (pricingInput !== "" || pricingOutput !== "") {
      const inputPerMillion = Number(pricingInput);
      const outputPerMillion = Number(pricingOutput);
      if (
        pricingInput === "" ||
        pricingOutput === "" ||
        !Number.isFinite(inputPerMillion) ||
        !Number.isFinite(outputPerMillion) ||
        inputPerMillion < 0 ||
        outputPerMillion < 0
      ) {
        return {
          error:
            "Pricing must be two nonnegative USD-per-million-token numbers, or both fields left empty.",
        };
      }
      pricing = { inputPerMillion, outputPerMillion };
    }
    const parsed = LlmProviderSettings.safeParse({
      kind: "custom",
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      auth,
      ...(pricing !== undefined ? { pricing } : {}),
    });
    if (!parsed.success) {
      return {
        error:
          parsed.error.issues[0]?.message ??
          "The custom provider settings are invalid.",
      };
    }
    return { settings: parsed.data };
  }

  const needsKey = kind !== "custom" || auth !== "none";
  const canEnable =
    status !== null &&
    !status.enabled &&
    agreed &&
    (!needsKey || apiKey.length > 0) &&
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

    const built = buildSettings();
    if ("error" in built) {
      inFlight.current = false;
      setBusy(false);
      setError(built.error);
      return;
    }
    let destination;
    try {
      destination = resolveLlmDestination(built.settings);
    } catch {
      inFlight.current = false;
      setBusy(false);
      setError("The provider settings are invalid.");
      return;
    }

    // Synchronous inside the click handler — Chrome only accepts
    // permissions.request from a direct user gesture.
    let permissionRequest: Promise<boolean>;
    try {
      permissionRequest = chrome.permissions.request({
        origins: [destination.permissionPattern],
      });
    } catch {
      inFlight.current = false;
      setBusy(false);
      setError("Something went wrong while enabling the provider.");
      return;
    }
    const mine = ++epoch.current;
    void permissionRequest
      .then(async (granted) => {
        if (epoch.current !== mine) return;
        if (!granted) {
          setError(
            `Chrome did not grant access to ${destination.origin}. The provider stays off — nothing was saved or sent.`,
          );
          return;
        }
        const cap = budgetCap.trim();
        const monthlyBudgetUsd = cap === "" ? undefined : Number(cap);
        if (
          monthlyBudgetUsd !== undefined &&
          (!Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0)
        ) {
          setError("The monthly budget cap must be a nonnegative number.");
          return;
        }
        const raw = await chrome.runtime.sendMessage(
          LlmProviderMessage.parse({
            type: "LLM_CONFIGURE",
            settings: built.settings,
            ...(needsKey ? { key: apiKey } : {}),
            ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
          }),
        );
        if (epoch.current !== mine) return;
        const result = LlmProviderMessageResult.safeParse(raw);
        if (!result.success) {
          setError("The extension worker returned an unexpected response.");
        } else if (!result.data.ok) {
          setError(result.data.message);
          void loadStatus();
        } else if ("status" in result.data) {
          setStatus(result.data.status);
          setApiKey("");
          setAgreed(false);
          setNotice("The LLM provider is enabled.");
        } else {
          setError("The extension worker returned an unexpected response.");
          void loadStatus();
        }
      })
      .catch(() => {
        if (epoch.current === mine) {
          setError("Something went wrong while enabling the provider.");
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  const onRevoke = () => {
    if (busy || inFlight.current || status?.providerId === undefined) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
    const mine = ++epoch.current;
    void chrome.runtime
      .sendMessage(
        LlmProviderMessage.parse({
          type: "LLM_REVOKE",
          providerId: status.providerId,
          deleteKey: deleteStoredKey,
        }),
      )
      .then((raw) => {
        if (epoch.current !== mine) return;
        const result = LlmProviderMessageResult.safeParse(raw);
        if (!result.success) {
          setError("The extension worker returned an unexpected response.");
          void loadStatus();
        } else if (!result.data.ok) {
          setError(result.data.message);
          // A failed revoke may still have removed consent — refresh.
          void loadStatus();
        } else if ("status" in result.data) {
          setStatus(result.data.status);
          setAgreed(false);
          setNotice("LLM provider consent and browser access were removed.");
        } else {
          setError("The extension worker returned an unexpected response.");
          void loadStatus();
        }
      })
      .catch(() => {
        if (epoch.current === mine) {
          setError("Something went wrong while revoking the provider.");
        }
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  // The only user action that produces provider traffic: one LLM_TEST per
  // explicit click. The worker re-checks enabled state and runs the fixed
  // synthetic payload — the page never picks content or sends key material.
  const onTest = () => {
    if (busy || inFlight.current || status?.providerId === undefined) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setTesting(true);
    setError(null);
    setNotice(null);
    setTestOutcome(null);
    const mine = ++epoch.current;
    void chrome.runtime
      .sendMessage(
        LlmProviderMessage.parse({
          type: "LLM_TEST",
          providerId: status.providerId,
        }),
      )
      .then((raw) => {
        if (epoch.current !== mine) return;
        const result = LlmProviderMessageResult.safeParse(raw);
        if (result.success && result.data.ok && "result" in result.data) {
          setTestOutcome({ ok: true, ...result.data.result });
        } else if (result.success && !result.data.ok) {
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
        if (epoch.current === mine) {
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

  const disclosureOrigin =
    kind === "custom"
      ? (() => {
          try {
            return new URL(baseUrl.trim()).origin;
          } catch {
            return "the configured origin";
          }
        })()
      : presetOrigin(kind);

  return (
    <section aria-labelledby="llm-provider-heading" className="mt-8">
      <h2 id="llm-provider-heading" className="text-lg font-medium">
        Optional LLM provider
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        A second, OpenAI-compatible provider for explanations, second
        opinions, summaries, and restructure proposals. Every feature is
        off until you enable a provider and grant consent per feature.
      </p>

      <section
        aria-label="LLM provider data disclosure"
        className="mt-4 rounded border border-gray-300 p-3 text-sm"
      >
        <h3 className="font-medium">What enabling an LLM provider means</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Recipient: your configured provider at{" "}
            <code className="rounded bg-gray-100 px-1">{disclosureOrigin}</code>{" "}
            — the only destination this consent covers.
          </li>
          <li>
            What is sent during setup: {TEST_DISCLOSURE.purpose}, with
            exactly the fields{" "}
            {TEST_DISCLOSURE.fields.map((field) => (
              <code key={field} className="rounded bg-gray-100 px-1">
                {field}
              </code>
            ))}
            .
          </li>
          <li>Why: to {TEST_DISCLOSURE.purpose}.</li>
          <li>When: {TEST_DISCLOSURE.trigger}.</li>
          <li>{TEST_DISCLOSURE.credentialUse}.</li>
          <li>
            With a credential configured it travels only in the{" "}
            <code className="rounded bg-gray-100 px-1">Authorization</code> or{" "}
            <code className="rounded bg-gray-100 px-1">api-key</code> request
            header to {disclosureOrigin}.
          </li>
          <li>Never sent: {LLM_NEVER_SENT.join(", ")}.</li>
        </ul>
      </section>

      {status?.enabled ? (
        <div
          role="group"
          aria-label="LLM enabled provider"
          className="mt-4"
        >
          <p className="text-sm">
            The LLM provider is enabled — model{" "}
            <code className="rounded bg-gray-100 px-1">{status.model}</code>{" "}
            at{" "}
            <code className="rounded bg-gray-100 px-1">{status.origin}</code>
            {status.keySuffix !== undefined && (
              <>
                , key ending in{" "}
                <code className="rounded bg-gray-100 px-1">
                  {status.keySuffix}
                </code>
              </>
            )}
            {status.tier !== undefined && (
              <>
                , structured output tier{" "}
                <code className="rounded bg-gray-100 px-1">{status.tier}</code>
              </>
            )}
            .
          </p>
          <div className="mt-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteStoredKey}
                onChange={(event) => setDeleteStoredKey(event.target.checked)}
              />
              Also delete the stored provider credential from this device
            </label>
          </div>
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="mt-3 rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Revoke LLM provider access
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
              Sends the disclosed synthetic request to {status.origin} —
              nothing else leaves this device.
            </p>
            {testOutcome !== null && testOutcome.ok && (
              <p role="status" className="mt-2 text-sm text-green-700">
                Connection test succeeded — model{" "}
                <code className="rounded bg-gray-100 px-1">
                  {testOutcome.model}
                </code>{" "}
                answered in {Math.round(testOutcome.latencyMs)} ms, tier{" "}
                <code className="rounded bg-gray-100 px-1">
                  {testOutcome.tier}
                </code>
                {testOutcome.usage !== undefined &&
                  `, ${testOutcome.usage.inputTokens} input / ${testOutcome.usage.outputTokens} output tokens` +
                    (testOutcome.usage.costUsd !== undefined
                      ? ` (reported cost $${testOutcome.usage.costUsd})`
                      : "")}
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
          <LlmBudget />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Provider type</legend>
            {PRESET_KINDS.map((id) => (
              <label
                key={id}
                className="mt-1 flex items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="llm-provider-kind"
                  value={id}
                  checked={kind === id}
                  onChange={() => onKindChange(id)}
                />
                {id === "openai" ? "OpenAI" : "OpenRouter"}
              </label>
            ))}
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="llm-provider-kind"
                value="custom"
                checked={kind === "custom"}
                onChange={() => onKindChange("custom")}
              />
              Custom OpenAI-compatible endpoint
            </label>
          </fieldset>

          {kind === "custom" && (
            <>
              <div>
                <label
                  htmlFor="llm-base-url"
                  className="block text-sm font-medium"
                >
                  Base URL
                </label>
                <input
                  id="llm-base-url"
                  type="text"
                  autoComplete="off"
                  placeholder="https://llm.example.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <p className="mt-1 text-xs text-gray-600">
                  HTTPS required; plain HTTP is allowed only for localhost,
                  127.0.0.1, or [::1].
                </p>
              </div>
              <div>
                <label
                  htmlFor="llm-auth"
                  className="block text-sm font-medium"
                >
                  Authentication
                </label>
                <select
                  id="llm-auth"
                  value={auth}
                  onChange={(event) =>
                    setAuth(event.target.value as LlmAuthMode)
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="bearer">Bearer token</option>
                  <option value="api-key">api-key header</option>
                  <option value="none">None (local endpoints)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="llm-input-price"
                    className="block text-sm font-medium"
                  >
                    Input price (USD / 1M tokens)
                  </label>
                  <input
                    id="llm-input-price"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={inputPrice}
                    onChange={(event) => setInputPrice(event.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label
                    htmlFor="llm-output-price"
                    className="block text-sm font-medium"
                  >
                    Output price (USD / 1M tokens)
                  </label>
                  <input
                    id="llm-output-price"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={outputPrice}
                    onChange={(event) => setOutputPrice(event.target.value)}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label htmlFor="llm-model" className="block text-sm font-medium">
              Model
            </label>
            <input
              id="llm-model"
              type="text"
              autoComplete="off"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>

          {needsKey && (
            <div>
              <label htmlFor="llm-api-key" className="block text-sm font-medium">
                API key
              </label>
              <input
                id="llm-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </div>
          )}

          <div>
            <label htmlFor="llm-budget-cap" className="block text-sm font-medium">
              Monthly budget cap (USD, optional)
            </label>
            <input
              id="llm-budget-cap"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={budgetCap}
              onChange={(event) => setBudgetCap(event.target.value)}
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
              I have read the disclosure above and agree to enable this LLM
              provider.
            </label>
          </div>
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Enable LLM provider
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
  );
}
