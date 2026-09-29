import { useCallback, useEffect, useRef, useState } from "react";
import {
  LLM_SCOPE_DISCLOSURES,
  LLM_NEVER_SENT,
  NO_DEVELOPER_SERVER_NOTE,
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
  type ModelPricing,
} from "../../schemas/llm";
import {
  Alert,
  Chip,
  Disclosure,
  Field,
  ProviderCard,
  StatusBadge,
} from "./components";
import { WarningIcon, ZapIcon } from "../../ui/components/icons";
import { LlmBudget } from "./LlmBudget";
import {
  cardClass,
  ghostDangerButtonClass,
  inputClass,
  primaryButtonClass,
  radioGroupClass,
  secondaryButtonClass,
  sectionHeadingClass,
} from "./ui";

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
  const [budgetUnlimited, setBudgetUnlimited] = useState(false);
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

  /**
   * Parse the optional per-token price override. Both fields must be filled
   * together: a half-entered rate would silently mis-estimate the cap.
   */
  function parsePricing():
    | { pricing: ModelPricing | undefined }
    | { error: string } {
    const pricingInput = inputPrice.trim();
    const pricingOutput = outputPrice.trim();
    if (pricingInput === "" && pricingOutput === "") {
      return { pricing: undefined };
    }
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
    return { pricing: { inputPerMillion, outputPerMillion } };
  }

  /** Assemble and validate the settings for the selected kind. */
  function buildSettings():
    | { settings: LlmProviderSettings }
    | { error: string } {
    const priced = parsePricing();
    if ("error" in priced) return { error: priced.error };
    const { pricing } = priced;

    if (kind !== "custom") {
      const parsed = LlmProviderSettings.safeParse({
        kind: "preset",
        preset: kind,
        model: model.trim() || LLM_PRESETS[kind].defaultModel,
        ...(pricing !== undefined ? { pricing } : {}),
      });
      if (!parsed.success) {
        return { error: "The selected model is not valid." };
      }
      return { settings: parsed.data };
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
        // An explicit "unlimited" tick wins; otherwise a filled cap is the
        // ceiling, and a blank one stays "not chosen" — which blocks
        // unattended features until the user decides (never a silent
        // unlimited default).
        const monthlyBudgetUsd =
          budgetUnlimited || cap === "" ? undefined : Number(cap);
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
            ...(budgetUnlimited ? { monthlyBudgetUnlimited: true } : {}),
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

  // The disclosure must name the destination consent actually covers. With
  // a provider live, that is the stored grant's resolved origin —
  // `kind`/`baseUrl` reset to "openai" on mount, so deriving from the form
  // would name a stale origin for a previously configured custom endpoint.
  // In the setup form the pending grant is exactly what `buildSettings()`
  // resolves from the current fields, so derive it there instead.
  const disclosureOrigin =
    status?.enabled === true && status.origin !== undefined
      ? status.origin
      : kind === "custom"
        ? (() => {
            try {
              return new URL(baseUrl.trim()).origin;
            } catch {
              return "the configured origin";
            }
          })()
        : presetOrigin(kind);

  return (
    <section aria-labelledby="llm-provider-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ZapIcon className="size-4" />
          </span>
          <h2 id="llm-provider-heading" className={sectionHeadingClass}>
            Optional LLM provider
          </h2>
        </div>
        {status !== null && <StatusBadge on={status.enabled} />}
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">
        A second, OpenAI-compatible provider for explanations, second
        opinions, summaries, and restructure proposals. Every feature is
        off until you enable a provider and grant consent per feature.
      </p>

      <div className="mt-4">
        <Disclosure
          title="What enabling an LLM provider means"
          subtitle="Read before enabling — this is what your consent covers."
          open={!status?.enabled}
          regionLabel="LLM provider data disclosure"
        >
          <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Recipient: your configured provider at{" "}
              <code className="rounded bg-muted px-1">{disclosureOrigin}</code>{" "}
              — the only destination this consent covers.{" "}
              {NO_DEVELOPER_SERVER_NOTE}
            </li>
            <li>
              What is sent during setup: {TEST_DISCLOSURE.purpose}, with
              exactly the fields{" "}
              {TEST_DISCLOSURE.fields.map((field) => (
                <code key={field} className="rounded bg-muted px-1">
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
              <code className="rounded bg-muted px-1">Authorization</code> or{" "}
              <code className="rounded bg-muted px-1">api-key</code> request
              header to {disclosureOrigin}.
            </li>
            <li>Never sent: {LLM_NEVER_SENT.join(", ")}.</li>
          </ul>
        </Disclosure>
      </div>

      {status?.enabled ? (
        <div
          role="group"
          aria-label="LLM enabled provider"
          className="mt-5"
        >
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <span className="text-sm text-muted-foreground">
              LLM provider enabled
            </span>
            <span className="hidden text-border sm:inline">·</span>
            <Chip>{status.model}</Chip>
            <Chip>{status.origin}</Chip>
            {status.keySuffix !== undefined && (
              <Chip>…{status.keySuffix}</Chip>
            )}
            {status.tier !== undefined && <Chip>{status.tier}</Chip>}
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
              Sends the disclosed synthetic request to {status.origin} —
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
                    answered in {Math.round(testOutcome.latencyMs)} ms, tier{" "}
                    <code className="rounded bg-muted px-1">
                      {testOutcome.tier}
                    </code>
                    {testOutcome.usage !== undefined &&
                      `, ${testOutcome.usage.inputTokens} input / ${testOutcome.usage.outputTokens} output tokens` +
                        (testOutcome.usage.costUsd !== undefined
                          ? ` (reported cost $${testOutcome.usage.costUsd})`
                          : "")}
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

          <LlmBudget />

          <div className="mt-5 border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteStoredKey}
                onChange={(event) => setDeleteStoredKey(event.target.checked)}
              />
              Also delete the stored provider credential from this device
            </label>
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className={`mt-3 ${ghostDangerButtonClass}`}
            >
              Revoke LLM provider access
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Provider type</legend>
            <div className={radioGroupClass}>
              {PRESET_KINDS.map((id) => (
                <ProviderCard
                  key={id}
                  name="llm-provider-kind"
                  value={id}
                  checked={kind === id}
                  onChange={() => onKindChange(id)}
                  title={id === "openai" ? "OpenAI" : "OpenRouter"}
                  inputLabel={id === "openai" ? "OpenAI" : "OpenRouter"}
                  description={
                    id === "openai"
                      ? "api.openai.com — Bearer key, official API."
                      : "openrouter.ai — one key across many models."
                  }
                />
              ))}
              <ProviderCard
                name="llm-provider-kind"
                value="custom"
                checked={kind === "custom"}
                onChange={() => onKindChange("custom")}
                title="Custom OpenAI-compatible endpoint"
                inputLabel="Custom OpenAI-compatible endpoint"
                description="Any HTTPS or localhost /chat/completions API."
              />
            </div>
          </fieldset>

          {kind === "custom" && (
            <>
              <Field
                label="Base URL"
                htmlFor="llm-base-url"
                hint="HTTPS required; plain HTTP is allowed only for localhost, 127.0.0.1, or [::1]."
              >
                <input
                  id="llm-base-url"
                  type="text"
                  autoComplete="off"
                  placeholder="https://llm.example.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Authentication" htmlFor="llm-auth">
                  <select
                    id="llm-auth"
                    value={auth}
                    onChange={(event) =>
                      setAuth(event.target.value as LlmAuthMode)
                    }
                    className={inputClass}
                  >
                    <option value="bearer">Bearer token</option>
                    <option value="api-key">api-key header</option>
                    <option value="none">None (local endpoints)</option>
                  </select>
                </Field>
              </div>
            </>
          )}

          <Field label="Model" htmlFor="llm-model">
            <input
              id="llm-model"
              type="text"
              autoComplete="off"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className={inputClass}
            />
          </Field>

          {needsKey && (
            <Field
              label="API key"
              htmlFor="llm-api-key"
              hint="Stored encrypted on this device — never shown again."
            >
              <input
                id="llm-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className={inputClass}
              />
            </Field>
          )}

          {/* The spend ceiling is an explicit choice: a typed cap or a
              deliberate "unlimited". Leaving both unset is allowed — the
              provider still works for manual features, but unattended
              (automatic) requests refuse until one is chosen. */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Spending ceiling</legend>
            <Field
              label="Monthly cap (USD)"
              htmlFor="llm-budget-cap"
              hint="Second opinions and other unattended features stop here."
            >
              <input
                id="llm-budget-cap"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                disabled={budgetUnlimited}
                value={budgetCap}
                onChange={(event) => setBudgetCap(event.target.value)}
                className={inputClass}
              />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={budgetUnlimited}
                onChange={(event) => {
                  setBudgetUnlimited(event.target.checked);
                  if (event.target.checked) setBudgetCap("");
                }}
              />
              No monthly cap — spend without a limit
            </label>
            {budgetUnlimited ? (
              <p
                role="status"
                className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
              >
                <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Second opinions run unattended inside actions you start — a
                  library scan can send a request per bookmark with no
                  ceiling. Your provider bills every one of them.
                </span>
              </p>
            ) : (
              budgetCap.trim() === "" && (
                <p className="text-xs text-muted-foreground">
                  With neither a cap nor unlimited chosen, unattended features
                  stay off; on-demand ones still ask before spending.
                </p>
              )
            )}
          </fieldset>

          {/* Per-token rates drive the cost estimate every reservation uses.
              Presets have a built-in price for their default model; any
              other model needs these numbers, or automatic requests refuse. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Input price (USD / 1M tokens)"
              htmlFor="llm-input-price"
              hint="Optional — overrides the built-in price; required for a model without one."
            >
              <input
                id="llm-input-price"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={inputPrice}
                onChange={(event) => setInputPrice(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field
              label="Output price (USD / 1M tokens)"
              htmlFor="llm-output-price"
            >
              <input
                id="llm-output-price"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={outputPrice}
                onChange={(event) => setOutputPrice(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

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
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable}
            className={primaryButtonClass}
          >
            Enable LLM provider
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
