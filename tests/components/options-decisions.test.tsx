import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CUSTOM_JEV_PROVIDER_NAME,
  LLM_SCOPE_DISCLOSURES,
} from "../../src/consent/disclosure";
import {
  consentVersionForScope,
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  revokeConsentsAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  BUILTIN_SENSITIVE_SITES,
  normalizeBlocklistEntry,
} from "../../src/decisions/minimize";
import type { DecisionSettings as SettingsValue } from "../../src/decisions/policy";
import { DecisionSettings } from "../../src/entrypoints/options/DecisionSettings";
import { OptionsApp } from "../../src/entrypoints/options/OptionsApp";
import { SentLog } from "../../src/entrypoints/options/SentLog";
import { budgetChoiceOf } from "../../src/llm/budget";
import { resolveProviderPricing } from "../../src/llm/pricing";
import { resolveLlmDestination } from "../../src/llm/providers";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import type { LlmFeatureMessageResult } from "../../src/messages/llm-features";
import type {
  LlmProviderStatus,
} from "../../src/messages/llm-provider";
import type { ProviderStatus } from "../../src/messages/provider";
import { PRESETS } from "../../src/net/presets";
import { SENT_LOG_RETENTION_CAP } from "../../src/net/sent-log";
import {
  LlmProviderRecord,
  LlmProviderSettings,
} from "../../src/schemas/llm";
import {
  CONSENT_SCOPE,
  CUSTOM_PROVIDER_ID,
  DECISIONS_CONSENT_SCOPE,
  JEV_SUMMARY_VERIFY_SCOPE,
  LLM_ESCALATE_SCOPE,
  LLM_EXPLAIN_SCOPE,
  LLM_RESTRUCTURE_SCOPE,
  LLM_SUMMARY_SCOPE,
  LLM_TEST_SCOPE,
  ProviderSettings,
  type JevProviderId,
} from "../../src/schemas/provider";

/**
 * jsdom + RTL under Vitest globals-off: the act environment flag and manual
 * cleanup replace the auto-setup RTL only performs when test globals exist.
 */
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
afterEach(() => cleanup());

let sendMessageSpy: ReturnType<typeof vi.fn>;
let workerSettings: SettingsValue;
let workerBlocklist: string[];

/**
 * In-memory worker double for the decisions settings protocol. The worker is
 * not running in tests; this answers GET_SETTINGS/PATCH_SETTINGS/
 * PATCH_BLOCKLIST the way `handleDecisionsMessage` would — the patches merge
 * into the shared `worker*` state, so two mounted pages exercising stale
 * snapshots both persist, matching the worker's read-modify-write.
 */
function workerReply(message: unknown): Promise<DecisionMessageResult> {
  const msg = message as {
    type: string;
    patch?: { autoApply?: Partial<SettingsValue["autoApply"]> };
    add?: string[];
    remove?: string[];
  };
  switch (msg.type) {
    case "GET_SETTINGS":
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
    case "PATCH_SETTINGS":
      workerSettings = {
        autoApply: { ...workerSettings.autoApply, ...(msg.patch?.autoApply ?? {}) },
      };
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
    case "PATCH_BLOCKLIST": {
      // The double normalizes like the worker: adds/removes canonicalize
      // through `normalizeBlocklistEntry`, deduped against the live list.
      const removals = new Set(
        (msg.remove ?? [])
          .map((raw) => normalizeBlocklistEntry(raw))
          .filter((host): host is string => host !== null),
      );
      const next = workerBlocklist.filter((host) => !removals.has(host));
      for (const raw of msg.add ?? []) {
        const host = normalizeBlocklistEntry(raw);
        if (host !== null && !next.includes(host)) next.push(host);
      }
      workerBlocklist = next;
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
    }
    default:
      return Promise.resolve({
        ok: false,
        code: "malformed_message",
        message: "unrecognized message",
      });
  }
}

beforeEach(async () => {
  workerSettings = { autoApply: { add_tags: false, set_category: false } };
  workerBlocklist = [];
  sendMessageSpy = vi.fn(workerReply);
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: sendMessageSpy },
  });
  await db.consents.clear();
  await db.metadata.clear();
  await db.sentLog.clear();
  await db.usage.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
});

const DECISION_TYPES = [
  "GET_SETTINGS",
  "PATCH_SETTINGS",
  "PATCH_BLOCKLIST",
];

/** The `type` of every runtime.sendMessage call so far. */
function sentTypes(): string[] {
  return sendMessageSpy.mock.calls.map(
    ([message]) => (message as { type: string }).type,
  );
}

/**
 * Same list filtered to the decisions protocol — the page also sends the
 * two escalation-status LLM reads on mount, which these pins ignore.
 */
function sentDecisionTypes(): string[] {
  return sentTypes().filter((type) => DECISION_TYPES.includes(type));
}


describe("auto-apply toggles", () => {
  it("renders both toggles off by default and explains the confidence bar", async () => {
    render(<DecisionSettings />);
    const addTags = await screen.findByRole("switch", {
      name: /tag additions/i,
    });
    const setCategory = screen.getByRole("switch", {
      name: /category/i,
    });
    expect(addTags.getAttribute("aria-checked")).toBe("false");
    expect(setCategory.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/0\.85/)).toBeTruthy();
    // Mount reads settings once.
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("persists a flip via a PATCH_SETTINGS field patch", async () => {
    render(<DecisionSettings />);
    const addTags = await screen.findByRole("switch", {
      name: /tag additions/i,
    });
    fireEvent.click(addTags);
    await waitFor(() => {
      expect(sentDecisionTypes()).toEqual(["GET_SETTINGS", "PATCH_SETTINGS"]);
    });
    const message = sendMessageSpy.mock.calls
      .map(
        ([m]) =>
          m as {
            type: string;
            patch?: { autoApply?: Partial<SettingsValue["autoApply"]> };
          },
      )
      .find((m) => m.type === "PATCH_SETTINGS");
    // Only the flipped field leaves the page — a stale snapshot can't
    // clobber another tab's concurrent write.
    expect(message?.patch).toEqual({ autoApply: { add_tags: true } });
    // The worker's echoed snapshot flips the rendered checkbox.
    await waitFor(() =>
      expect(addTags.getAttribute("aria-checked")).toBe("true"),
    );
    expect(workerSettings.autoApply.add_tags).toBe(true);
  });

  it("toggles set_category independently of add_tags", async () => {
    workerSettings = { autoApply: { add_tags: true, set_category: false } };
    render(<DecisionSettings />);
    const setCategory = await screen.findByRole("switch", {
      name: /category/i,
    });
    fireEvent.click(setCategory);
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PATCH_SETTINGS",
          patch: { autoApply: { set_category: true } },
        }),
      ),
    );
  });
});

describe("blocklist editor", () => {
  it("adds a normalized entry via a PATCH_BLOCKLIST delta and lists it", async () => {
    render(<DecisionSettings />);
    const input = await screen.findByLabelText(/block a host/i);
    fireEvent.change(input, { target: { value: "Example.ORG" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PATCH_BLOCKLIST",
          add: ["Example.ORG"],
        }),
      ),
    );
    await screen.findByText("example.org");
    expect(workerBlocklist).toEqual(["example.org"]);
  });

  it("removes an entry via a PATCH_BLOCKLIST delta", async () => {
    workerBlocklist = ["example.org", "example.net"];
    render(<DecisionSettings />);
    await screen.findByText("example.org");
    fireEvent.click(
      screen.getByRole("button", { name: /remove example\.org/i }),
    );
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "PATCH_BLOCKLIST",
          remove: ["example.org"],
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("example.org")).toBeNull());
    expect(screen.getByText("example.net")).toBeTruthy();
  });

  it("persists adds from two pages holding different stale snapshots", async () => {
    // Two mounted pages read the same snapshot, then each adds a different
    // entry — the worker merges both deltas, so neither add is clobbered.
    workerBlocklist = ["example.org"];
    const first = render(<DecisionSettings />);
    const second = render(<DecisionSettings />);
    // Both pages render the same label + control id, so a by-label query
    // can't disambiguate the two — the placeholder is unique to this field.
    const firstInput = await within(first.container).findByPlaceholderText(
      "example.com",
    );
    const secondInput = await within(second.container).findByPlaceholderText(
      "example.com",
    );
    fireEvent.change(firstInput, { target: { value: "bank.example" } });
    fireEvent.change(secondInput, { target: { value: "health.example" } });
    fireEvent.click(
      within(first.container).getByRole("button", { name: /^add$/i }),
    );
    fireEvent.click(
      within(second.container).getByRole("button", { name: /^add$/i }),
    );
    await waitFor(() =>
      expect(workerBlocklist).toEqual([
        "example.org",
        "bank.example",
        "health.example",
      ]),
    );
  });

  it("does not send for duplicates or inputs that cannot name a host", async () => {
    workerBlocklist = ["example.org"];
    render(<DecisionSettings />);
    await screen.findByText("example.org");
    fireEvent.change(screen.getByLabelText(/block a host/i), {
      target: { value: "EXAMPLE.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await screen.findByText(/already/i);
    fireEvent.change(screen.getByLabelText(/block a host/i), {
      target: { value: "not a host" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await screen.findByRole("alert");
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("shows the built-in blocklist as read-only context", async () => {
    render(<DecisionSettings />);
    await screen.findByLabelText(/block a host/i);
    // Built-in entries render for context but carry no remove control.
    for (const site of ["chase.com", "kaiserpermanente.org", "gmail.com"]) {
      expect(BUILTIN_SENSITIVE_SITES).toContain(site);
      expect(screen.getByText(site)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: `Remove ${site}` }),
      ).toBeNull();
    }
  });
});

describe("data sent log", () => {
  async function seedLog() {
    await db.sentLog.add({
      sentAt: "2026-09-25T10:05:00.000Z",
      destination: "https://api.typesafe.ai",
      feature: "jev_decisions",
      fieldNames: ["title", "url", "domain"],
    });
    await db.sentLog.add({
      sentAt: "2026-09-25T10:06:00.000Z",
      destination: "https://openrouter.ai",
      feature: "jev_test",
      fieldNames: ["model", "state", "questions"],
    });
  }

  it("lists only metadata, shows the empty state, and clears", async () => {
    render(<SentLog />);
    // A08: the sent log reads lazily — expand it before expecting rows.
    fireEvent.click(
      await screen.findByRole("button", { name: "Show sent log" }),
    );
    await screen.findByText(/nothing has been sent/i);
    // A Dexie write re-fires the live query — wrap it so the state update
    // lands inside act.
    await act(async () => {
      await seedLog();
    });
    await screen.findByText("https://api.typesafe.ai");
    expect(screen.getByText("https://openrouter.ai")).toBeTruthy();
    expect(screen.getByText(/jev_decisions/)).toBeTruthy();
    expect(screen.getByText(/title, url, domain/)).toBeTruthy();
    expect(screen.getByText(/model, state, questions/)).toBeTruthy();
    // The retention cap is disclosed with the enforced bound.
    expect(
      screen.getByText(new RegExp(`${SENT_LOG_RETENTION_CAP}`)),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(async () =>
      expect(await db.sentLog.count()).toBe(0),
    );
    await screen.findByText(/nothing has been sent/i);
  });
});

describe("cost totals", () => {
  it("aggregates usage rows; cost totals cover only reporting rows", async () => {
    await db.usage.bulkAdd([
      {
        model: "jev-latest",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.25,
        recordedAt: "2026-09-25T10:00:00.000Z",
      },
      {
        model: "jev-1.13.0",
        inputTokens: 200,
        outputTokens: 60,
        costUsd: 0.25,
        recordedAt: "2026-09-25T10:01:00.000Z",
      },
      {
        model: "jev-latest",
        inputTokens: 300,
        outputTokens: 70,
        recordedAt: "2026-09-25T10:02:00.000Z",
      },
    ]);
    render(<SentLog />);
    const totals = await screen.findByLabelText(/usage totals/i);
    expect(totals.textContent).toContain("600");
    expect(totals.textContent).toContain("180");
    expect(totals.textContent).toContain("2 of 3 priced");
    expect(totals.textContent).toContain("$0.5");
  });
  it("never reports $0 for a request that carried no cost", async () => {
    await db.usage.add({
      model: "jev-latest",
      inputTokens: 42,
      outputTokens: 7,
      recordedAt: "2026-09-25T10:00:00.000Z",
    });
    render(<SentLog />);
    const totals = await screen.findByLabelText(/usage totals/i);
    expect(totals.textContent).toContain("0 of 1 priced");
    // No cost figure renders for a request that reported none.
    expect(totals.textContent).not.toContain("$");
  });
});

describe("protocol discipline", () => {
  it("sends only decisions-protocol messages — consent is a local write", async () => {
    render(<DecisionSettings />);
    fireEvent.click(
      await screen.findByRole("switch", { name: /tag additions/i }),
    );
    await waitFor(() =>
      expect(sentDecisionTypes()).toContain("PATCH_SETTINGS"),
    );
    for (const type of sentTypes()) {
      expect([
        ...DECISION_TYPES,
        // Read-only status probes the panel issues on mount — still no
        // consent messages, which stay direct Dexie writes.
        "PROVIDER_STATUS",
        "LLM_PROVIDER_STATUS",
        "LLM_ESCALATION_STATUS",
      ]).toContain(type);
    }
  });

  it("renders worker failure replies — generic for non-protocol, verbatim for {ok:false}", async () => {
    sendMessageSpy.mockResolvedValue({ nonsense: true });
    render(<DecisionSettings />);
    const generic = await screen.findByRole("alert");
    expect(generic.textContent).toMatch(/unexpected/i);
    cleanup();
    sendMessageSpy.mockResolvedValue({
      ok: false,
      code: "internal_error",
      message: "The request failed unexpectedly.",
    });
    render(<DecisionSettings />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("internal_error");
    expect(alert.textContent).toContain(
      "The request failed unexpectedly.",
    );
  });
});

describe("settings load failure", () => {
  it("shows a retryable failure, recovers on retry, and stays retryable on repeat failure", async () => {
    sendMessageSpy.mockRejectedValueOnce(new Error("worker gone"));
    render(<DecisionSettings />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/did not return decision settings/i);
    // A failed load is not "loading": no perpetual placeholder text.
    expect(screen.queryByText(/loading decision settings/i)).toBeNull();
    expect(screen.queryByText(/loading the blocklist/i)).toBeNull();
    // Each worker-owned section offers a retry.
    const retries = screen.getAllByRole("button", { name: /^retry$/i });
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0]!);
    // The retry re-reads through the worker and recovers both sections.
    await screen.findByRole("switch", { name: /tag additions/i });
    await screen.findByLabelText(/block a host/i);
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS", "GET_SETTINGS"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^retry$/i }),
    ).toBeNull();
    cleanup();
    sendMessageSpy.mockReset();
    sendMessageSpy.mockRejectedValue(new Error("worker gone"));
    render(<DecisionSettings />);
    await screen.findByRole("alert");
    const second = screen.getAllByRole("button", { name: /^retry$/i });
    fireEvent.click(second[0]!);
    // A second GET_SETTINGS goes out, fails, and the retryable failure
    // returns rather than dead-ending on "Loading…".
    await waitFor(() =>
      expect(sentDecisionTypes()).toEqual(["GET_SETTINGS", "GET_SETTINGS"]),
    );
    await screen.findAllByRole("button", { name: /^retry$/i });
    expect(screen.queryByText(/loading decision settings/i)).toBeNull();
    expect(screen.queryByText(/loading the blocklist/i)).toBeNull();
  });
});



/* ------------------------------------------------------------------ */
/* Mounted shell — live provider state (bug B14)                       */
/* ------------------------------------------------------------------ */
/*
 * The Options shell keeps every panel mounted (`hidden` toggles visibility),
 * so a provider enabled, changed, or revoked in the Connections panel has to
 * reach the Permissions panel — and the hidden panels — without a reload.
 * These cases drive the real shell and the real panels; only the worker is a
 * double, and it owns the same IndexedDB rows the real worker owns so the
 * panels' live queries observe exactly the changes they would in Chrome.
 */

const JEV_SECTION = /ai provider connection/i;
const LLM_SECTION = /optional llm provider/i;
const ESCALATION_SECTION = /automatic second opinions/i;
const BLOCKLIST_SECTION = /never send these sites/i;

const CUSTOM_ORIGIN = "https://jev.example.com";
const LLM_ORIGIN = "https://api.openai.com";

const LLM_RECORD_PREFIX = "llmProvider:";
const LLM_ACTIVE_KEY = "llmActiveProvider";
const ESCALATION_KEY = "llmEscalation";

/** Shell-worker controls, re-armed per test. */
let escalationReadCount: number;
let providerStatusCount: number;
let holdCustomProbes: boolean;
let holdAllJevProbes: boolean;
let heldProbes: Array<() => void>;
let failStatusReads: boolean;


/** The stored Jev status for one id, as the worker's `readStatus` composes it. */
async function readStoredJevStatus(id: JevProviderId): Promise<ProviderStatus> {
  const row = await db.metadata.get(id);
  const parsed = ProviderSettings.safeParse(row?.value);
  const settings = parsed.success ? parsed.data : null;
  const origin =
    settings !== null
      ? settings.preset === CUSTOM_PROVIDER_ID
        ? new URL(settings.baseUrl).origin
        : PRESETS[settings.preset].origin
      : id === CUSTOM_PROVIDER_ID
        ? null
        : PRESETS[id].origin;
  const consentGranted =
    origin !== null && (await hasConsentAtOrigin(CONSENT_SCOPE, origin));
  return {
    enabled: settings !== null && consentGranted,
    consentGranted,
    ...(settings !== null
      ? { model: settings.model, keySuffix: settings.keySuffix }
      : {}),
    ...(origin !== null ? { origin } : {}),
  };
}

/** The active LLM provider record, read the way `readActiveLlmProvider` does. */
async function readActiveLlmRecord(): Promise<LlmProviderRecord | null> {
  const pointer = await db.metadata.get(LLM_ACTIVE_KEY);
  const providerId = typeof pointer?.value === "string" ? pointer.value : null;
  if (providerId === null) {
    return null;
  }
  const row = await db.metadata.get(`${LLM_RECORD_PREFIX}${providerId}`);
  const parsed = LlmProviderRecord.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** The stored LLM provider status, as the worker's `readStatus` composes it. */
async function readStoredLlmStatus(): Promise<LlmProviderStatus> {
  const record = await readActiveLlmRecord();
  if (record === null) {
    return {
      configured: false,
      enabled: false,
      consentGranted: false,
      permissionGranted: false,
      active: false,
    };
  }
  const destination = resolveLlmDestination(record.provider);
  const consentGranted = await hasConsentAtOrigin(
    LLM_TEST_SCOPE,
    destination.origin,
  );
  const status: LlmProviderStatus = {
    configured: true,
    enabled: consentGranted,
    consentGranted,
    permissionGranted: true,
    active: true,
    providerId: record.providerId,
    origin: destination.origin,
    model: destination.model,
    budget: budgetChoiceOf(record),
    pricingKnown: resolveProviderPricing(record.provider) !== undefined,
  };
  if (record.keySuffix !== undefined) {
    status.keySuffix = record.keySuffix;
  }
  if (record.monthlyBudgetUsd !== undefined) {
    status.monthlyBudgetUsd = record.monthlyBudgetUsd;
  }
  return status;
}

/** The stored escalation status, as `escalationStatus` composes it. */
async function readStoredEscalation(): Promise<LlmFeatureMessageResult> {
  const row = await db.metadata.get(ESCALATION_KEY);
  const enabled =
    (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
  const record = await readActiveLlmRecord();
  return {
    ok: true,
    code: "escalation_status",
    escalation: {
      enabled,
      providerConfigured: record !== null,
      monthlyBudgetUsd: record?.monthlyBudgetUsd ?? null,
      budget: record === null ? "unset" : budgetChoiceOf(record),
      pricingKnown:
        record !== null &&
        resolveProviderPricing(record.provider) !== undefined,
      ...(record !== null ? { providerId: record.providerId } : {}),
    },
  };
}

/**
 * The mounted shell's worker double. Provider messages mirror
 * `messages/provider` (settings row + `jev_test` grant per resolved origin);
 * LLM messages mirror `messages/llm-provider` / `messages/llm-features`
 * (active pointer, provider record, `llm_test` grant, escalation row).
 */
async function shellWorkerReply(message: unknown): Promise<unknown> {
  const msg = message as {
    type: string;
    preset?: JevProviderId;
    model?: string;
    key?: string;
    baseUrl?: string;
    settings?: LlmProviderSettings;
    enabled?: boolean;
    monthlyBudgetUsd?: number;
    monthlyBudgetUnlimited?: true;
    budget?:
      | { kind: "capped"; usd: number }
      | { kind: "unlimited" }
      | { kind: "unset" };
  };
  switch (msg.type) {
    case "PROVIDER_STATUS": {
      const preset = msg.preset as JevProviderId;
      providerStatusCount += 1;
      // The hold decision is taken synchronously, when the read is issued:
      // a probe entered while reads are free always answers normally.
      const hold =
        holdAllJevProbes ||
        (preset === CUSTOM_PROVIDER_ID && holdCustomProbes);
      if (failStatusReads) {
        throw new Error("provider status unavailable");
      }
      const status = await readStoredJevStatus(preset);
      if (hold) {
        return await new Promise((resolve) => {
          heldProbes.push(() => resolve({ ok: true, status }));
        });
      }
      return { ok: true, status };
    }
    case "ENABLE_PROVIDER": {
      const preset = msg.preset as JevProviderId;
      const settings =
        preset === CUSTOM_PROVIDER_ID
          ? ProviderSettings.parse({
              preset: CUSTOM_PROVIDER_ID,
              baseUrl: msg.baseUrl,
              model: msg.model,
              keySuffix: String(msg.key).slice(-4),
            })
          : ProviderSettings.parse({
              preset,
              model: msg.model,
              keySuffix: String(msg.key).slice(-4),
            });
      await db.metadata.put({ key: preset, value: settings });
      await grantConsentAtOrigin(
        CONSENT_SCOPE,
        settings.preset === CUSTOM_PROVIDER_ID
          ? new URL(settings.baseUrl).origin
          : PRESETS[settings.preset].origin,
      );
      return { ok: true, status: await readStoredJevStatus(preset) };
    }
    case "REVOKE_PROVIDER": {
      const preset = msg.preset as JevProviderId;
      const stored = ProviderSettings.safeParse(
        (await db.metadata.get(preset))?.value,
      );
      if (stored.success) {
        await revokeConsentsAtOrigin(
          stored.data.preset === CUSTOM_PROVIDER_ID
            ? new URL(stored.data.baseUrl).origin
            : PRESETS[stored.data.preset].origin,
        );
      }
      await db.metadata.delete(preset);
      return { ok: true, status: await readStoredJevStatus(preset) };
    }
    case "TEST_PROVIDER":
      return {
        ok: true,
        code: "test_ok",
        result: { model: "jev-latest", latencyMs: 4 },
      };
    case "LLM_PROVIDER_STATUS": {
      if (failStatusReads) {
        throw new Error("llm provider status unavailable");
      }
      return { ok: true, status: await readStoredLlmStatus() };
    }
    case "LLM_CONFIGURE": {
      const settings = LlmProviderSettings.parse(msg.settings);
      const destination = resolveLlmDestination(settings);
      const record = LlmProviderRecord.parse({
        providerId: destination.providerId,
        provider: settings,
        ...(msg.key !== undefined
          ? { keySuffix: String(msg.key).slice(-4) }
          : {}),
        ...(msg.monthlyBudgetUsd !== undefined
          ? { monthlyBudgetUsd: msg.monthlyBudgetUsd }
          : {}),
        ...(msg.monthlyBudgetUnlimited === true
          ? { monthlyBudgetUnlimited: true }
          : {}),
        configuredAt: new Date().toISOString(),
      });
      await db.transaction("rw", db.metadata, async () => {
        await db.metadata.put({
          key: `${LLM_RECORD_PREFIX}${record.providerId}`,
          value: record,
        });
        await db.metadata.put({
          key: LLM_ACTIVE_KEY,
          value: record.providerId,
        });
      });
      await grantConsentAtOrigin(LLM_TEST_SCOPE, destination.origin);
      return { ok: true, status: await readStoredLlmStatus() };
    }
    case "LLM_REVOKE": {
      const record = await readActiveLlmRecord();
      if (record !== null) {
        await revokeConsentsAtOrigin(
          resolveLlmDestination(record.provider).origin,
        );
        await db.transaction("rw", db.metadata, async () => {
          await db.metadata.delete(`${LLM_RECORD_PREFIX}${record.providerId}`);
          await db.metadata.delete(LLM_ACTIVE_KEY);
        });
      }
      return { ok: true, status: await readStoredLlmStatus() };
    }
    case "LLM_BUDGET_SET": {
      const record = await readActiveLlmRecord();
      if (record === null) {
        return {
          ok: false,
          code: "not_configured",
          message: "That provider is not configured; enable it first.",
        };
      }
      const next: LlmProviderRecord = { ...record };
      if (msg.budget?.kind === "capped") {
        next.monthlyBudgetUsd = msg.budget.usd;
        delete next.monthlyBudgetUnlimited;
      } else if (msg.budget?.kind === "unlimited") {
        next.monthlyBudgetUnlimited = true;
        delete next.monthlyBudgetUsd;
      } else {
        delete next.monthlyBudgetUsd;
        delete next.monthlyBudgetUnlimited;
      }
      await db.metadata.put({
        key: `${LLM_RECORD_PREFIX}${record.providerId}`,
        value: LlmProviderRecord.parse(next),
      });
      return { ok: true, status: await readStoredLlmStatus() };
    }
    case "LLM_BUDGET_SNAPSHOT": {
      const record = await readActiveLlmRecord();
      const cap = record?.monthlyBudgetUsd ?? null;
      return {
        ok: true,
        code: "budget_snapshot",
        snapshot: {
          month: "2026-10",
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          reportedCostUsd: 0,
          estimatedCostUsd: 0,
          unknownCostRequests: 0,
          hasUnknownCost: false,
          reservedUsd: 0,
          committedUsd: 0,
          budgetUsd: cap,
          remainingUsd: cap,
        },
      };
    }
    case "LLM_ESCALATION_STATUS": {
      escalationReadCount += 1;
      if (failStatusReads) {
        throw new Error("escalation status unavailable");
      }
      return await readStoredEscalation();
    }
    case "LLM_ESCALATION_SET": {
      const record = await readActiveLlmRecord();
      await db.metadata.put({
        key: ESCALATION_KEY,
        value: {
          enabled: msg.enabled === true,
          ...(record !== null ? { providerId: record.providerId } : {}),
        },
      });
      return await readStoredEscalation();
    }
    default:
      return workerReply(message);
  }
}

/** Navigate the mounted shell by clicking one rail link. */
function showPanel(label: string): void {
  const nav = screen.getByRole("navigation", { name: "Options sections" });
  fireEvent.click(within(nav).getByRole("link", { name: new RegExp(label) }));
}

/**
 * Open a `Disclosure`. jsdom does not toggle `<details>` on summary clicks,
 * so flip the DOM attribute and fire `toggle` — the primitive's own handler.
 */
function openDetails(region: HTMLElement): void {
  const details = region.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

/**
 * Mount the real Options shell with a protocol-speaking worker double, and
 * settle the mount reads: the Permissions panel's live provider read has been
 * issued, and the Connections panel's own status probes have been entered
 * (both batches issue their probes synchronously, so an entry proves the
 * whole batch was sent).
 */
async function mountOptionsShell(): Promise<void> {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: sendMessageSpy,
      getURL: (path: string) => `chrome-extension://testext/${path}`,
      getManifest: () => ({ version: "0.0.0" }),
    },
    permissions: {
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
      contains: vi.fn(async () => true),
    },
  });
  sendMessageSpy.mockImplementation(shellWorkerReply);
  location.hash = "";
  const readsBefore = escalationReadCount;
  const probesBefore = providerStatusCount;
  render(<OptionsApp />);
  await waitFor(() => expect(escalationReadCount).toBeGreaterThan(readsBefore));
  await waitFor(() =>
    expect(providerStatusCount).toBeGreaterThanOrEqual(probesBefore + 2),
  );
}

/** Enable the custom Jev provider through the Connections panel's form. */
async function enableCustomJevProvider(options: {
  baseUrl: string;
  model: string;
  key: string;
}): Promise<void> {
  showPanel("Connections");
  const section = screen.getByRole("region", { name: JEV_SECTION });
  fireEvent.click(
    within(section).getByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    }),
  );
  fireEvent.change(await within(section).findByLabelText(/^base url$/i), {
    target: { value: options.baseUrl },
  });
  fireEvent.change(within(section).getByLabelText(/^model id$/i), {
    target: { value: options.model },
  });
  fireEvent.change(within(section).getByLabelText(/^api key$/i), {
    target: { value: options.key },
  });
  openDetails(
    within(section).getByRole("region", {
      name: /custom jev provider data disclosure/i,
    }),
  );
  fireEvent.click(
    within(section).getByRole("checkbox", {
      name: /agree to enable custom jev provider/i,
    }),
  );
  const enable = within(section).getByRole("button", {
    name: /^enable custom jev provider$/i,
  }) as HTMLButtonElement;
  await waitFor(() => expect(enable.disabled).toBe(false));
  fireEvent.click(enable);
  await waitFor(async () =>
    expect(await db.metadata.get(CUSTOM_PROVIDER_ID)).toBeDefined(),
  );
}

/** Enable the preset OpenAI LLM provider through the Connections panel. */
async function enableLlmProvider(options: { cap?: string } = {}): Promise<void> {
  showPanel("Connections");
  const section = screen.getByRole("region", { name: LLM_SECTION });
  fireEvent.change(within(section).getByLabelText(/^api key$/i), {
    target: { value: "sk-openai-test" },
  });
  if (options.cap !== undefined) {
    fireEvent.change(within(section).getByLabelText(/monthly cap \(usd\)/i), {
      target: { value: options.cap },
    });
  }
  openDetails(
    within(section).getByRole("region", {
      name: /llm provider data disclosure/i,
    }),
  );
  fireEvent.click(
    within(section).getByRole("checkbox", {
      name: /agree to enable this llm provider/i,
    }),
  );
  const enable = within(section).getByRole("button", {
    name: /^enable llm provider$/i,
  }) as HTMLButtonElement;
  await waitFor(() => expect(enable.disabled).toBe(false));
  fireEvent.click(enable);
  await waitFor(async () => expect(await readActiveLlmRecord()).not.toBeNull());
}


beforeEach(() => {
  escalationReadCount = 0;
  providerStatusCount = 0;
  holdCustomProbes = false;
  holdAllJevProbes = false;
  heldProbes = [];
  failStatusReads = false;
});

describe("mounted shell — live provider state", () => {
  it("enables a custom Jev provider in Connections, grants jev_decisions consent, and preserves Data panel state across navigation", async () => {
    await mountOptionsShell();
    showPanel("Data");
    // An uncommitted edit in the Data panel is the no-remount witness.
    const blocklist = screen.getByRole("region", { name: BLOCKLIST_SECTION });
    fireEvent.change(within(blocklist).getByLabelText(/block a host/i), {
      target: { value: "example.org" },
    });

    await enableCustomJevProvider({
      baseUrl: CUSTOM_ORIGIN,
      model: "jev-latest",
      key: "custom-key-1",
    });

    // Enabling the custom Jev provider automatically grants jev_decisions at its origin.
    await waitFor(async () =>
      expect(
        await hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, CUSTOM_ORIGIN),
      ).toBe(true),
    );
    const banner = await screen.findByTestId("provider-analysis-consent");
    expect(banner.textContent).toContain("Consent granted");

    // Nothing was remounted: the uncommitted edit made in Data before the
    // provider was enabled survived the enable and the panel switch.
    showPanel("Data");
    expect(
      (within(blocklist).getByLabelText(/block a host/i) as HTMLInputElement)
        .value,
    ).toBe("example.org");
  });

  it("drops a revoked custom provider and removes its jev_decisions consent at that origin", async () => {
    await mountOptionsShell();
    await enableCustomJevProvider({
      baseUrl: CUSTOM_ORIGIN,
      model: "jev-latest",
      key: "custom-key-1",
    });
    await waitFor(async () =>
      expect(
        await hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, CUSTOM_ORIGIN),
      ).toBe(true),
    );

    showPanel("Connections");
    fireEvent.click(
      within(screen.getByRole("region", { name: JEV_SECTION })).getByRole(
        "button",
        { name: /revoke custom jev provider access/i },
      ),
    );
    await waitFor(async () =>
      expect(await db.metadata.get(CUSTOM_PROVIDER_ID)).toBeUndefined(),
    );
    expect(
      await hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, CUSTOM_ORIGIN),
    ).toBe(false);
  });

  it("reflects the LLM origin and a changed spending ceiling in Automatic second opinions", async () => {
    await mountOptionsShell();
    showPanel("Connections");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    await within(escalation).findByText(
      /configure and enable an llm provider in connections/i,
    );

    await enableLlmProvider({ cap: "5" });

    await within(escalation).findByRole("region", {
      name: "Second opinion disclosure",
    });
    expect(escalation.textContent).toContain(LLM_ORIGIN);
    await within(escalation).findByText(/Monthly cap: \$5\.00/);

    // A ceiling change in the Connections budget panel flows through too.
    const llmSection = screen.getByRole("region", { name: LLM_SECTION });
    fireEvent.change(
      within(llmSection).getByLabelText(/monthly cap \(usd\)/i),
      { target: { value: "12" } },
    );
    fireEvent.click(
      within(llmSection).getByRole("button", { name: /save ceiling/i }),
    );
    await within(llmSection).findByText(/spending ceiling saved/i);
    await waitFor(() =>
      expect(escalation.textContent).toContain("Monthly cap: $12.00"),
    );
    expect(escalation.textContent).not.toContain("Monthly cap: $5.00");
  });

  it("enables second opinions in one switch click and resets when the LLM provider is revoked", async () => {
    await mountOptionsShell();
    await enableLlmProvider({ cap: "5" });
    showPanel("Connections");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    const toggle = () =>
      within(escalation).getByRole("switch", {
        name: /second opinion on unsure suggestions/i,
      }) as HTMLElement;
    await waitFor(() =>
      expect(toggle().getAttribute("aria-disabled")).toBeNull(),
    );

    const disclosure = within(escalation).getByRole("region", {
      name: "Second opinion disclosure",
    });
    openDetails(disclosure);
    expect(disclosure.textContent).toContain("focusing Tags or clicking Suggest in the popup");
    expect(disclosure.textContent).toContain("clicking Resume");
    expect(disclosure.textContent).not.toMatch(/\bSave\b/);

    fireEvent.click(toggle());
    await waitFor(async () =>
      expect(
        await hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(async () =>
      expect((await db.metadata.get(ESCALATION_KEY))?.value).toMatchObject({
        enabled: true,
      }),
    );

    // Revoking the provider takes the section back to the no-provider state.
    fireEvent.click(
      within(screen.getByRole("region", { name: LLM_SECTION })).getByRole(
        "button",
        { name: /revoke llm provider access/i },
      ),
    );
    await within(escalation).findByText(
      /configure and enable an llm provider in connections/i,
    );
    expect(
      within(escalation).queryByRole("switch", { name: /second opinion/i }),
    ).toBeNull();
  });

  it("jumps a blocked second-opinion toggle to its Connections prerequisite", async () => {
    await mountOptionsShell();
    // A priced provider with no ceiling: the cap is the unmet prerequisite.
    await enableLlmProvider();
    showPanel("Connections");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    await within(escalation).findByText(/no spending ceiling is chosen/i);

    const toggle = within(escalation).getByRole("switch", {
      name: /second opinion on unsure suggestions/i,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-disabled")).toBe("true"),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(document.getElementById("connections")?.hidden).toBe(false),
    );

    fireEvent.click(
      within(escalation).getByRole("button", { name: /open monthly budget/i }),
    );
    await waitFor(() =>
      expect(document.getElementById("connections")?.hidden).toBe(false),
    );
    expect(document.getElementById("llm-budget")).not.toBeNull();
  });

  it("surfaces a settled status failure and recovers when the read is retried", async () => {
    failStatusReads = true;
    await mountOptionsShell();
    showPanel("Connections");
    await screen.findByText(/could not read the second-opinion status/i);

    failStatusReads = false;
    fireEvent.click(
      screen.getByRole("button", { name: /retry second-opinion status/i }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/could not read the second-opinion status/i),
      ).toBeNull(),
    );
  });
});

describe("Phase 4 Task 5: per-feature consent, disclosure control, Enter add, and inline feedback", () => {

  it("inspects active per-feature consent grants (llm_explain, llm_restructure, llm_summary, jev_summary_verify) and revokes them individually", async () => {
    await grantConsentAtOrigin(LLM_EXPLAIN_SCOPE, LLM_ORIGIN);
    await grantConsentAtOrigin(LLM_RESTRUCTURE_SCOPE, LLM_ORIGIN);
    await grantConsentAtOrigin(LLM_SUMMARY_SCOPE, LLM_ORIGIN);
    await grantConsentAtOrigin(JEV_SUMMARY_VERIFY_SCOPE, PRESETS.typesafe.origin);

    render(<DecisionSettings />);

    // All four feature consent titles and their origins appear.
    await screen.findByText(LLM_SCOPE_DISCLOSURES[LLM_EXPLAIN_SCOPE].title);
    expect(
      screen.getByText(LLM_SCOPE_DISCLOSURES[LLM_RESTRUCTURE_SCOPE].title),
    ).toBeTruthy();
    expect(
      screen.getByText(LLM_SCOPE_DISCLOSURES[LLM_SUMMARY_SCOPE].title),
    ).toBeTruthy();
    expect(
      screen.getByText(LLM_SCOPE_DISCLOSURES[JEV_SUMMARY_VERIFY_SCOPE].title),
    ).toBeTruthy();

    // Stale version rows are ignored.
    await act(async () => {
      await db.consents.put({
        scope: LLM_SUMMARY_SCOPE,
        origin: "https://stale.example.com",
        consentVersion: consentVersionForScope(LLM_SUMMARY_SCOPE) - 1,
        acceptedAt: "2025-01-01T00:00:00.000Z",
      });
    });
    expect(screen.queryByText("https://stale.example.com")).toBeNull();

    // Revoking one scope removes only that scope and shows a confirmation notice.
    const revokeExplain = screen.getByRole("button", {
      name: new RegExp(
        `revoke ${LLM_SCOPE_DISCLOSURES[LLM_EXPLAIN_SCOPE].title} consent`,
        "i",
      ),
    });
    fireEvent.click(revokeExplain);

    await waitFor(async () => {
      expect(await hasConsentAtOrigin(LLM_EXPLAIN_SCOPE, LLM_ORIGIN)).toBe(
        false,
      );
    });
    expect(await hasConsentAtOrigin(LLM_RESTRUCTURE_SCOPE, LLM_ORIGIN)).toBe(
      true,
    );
    const statusNotice = await screen.findByRole("status");
    expect(statusNotice.textContent).toMatch(/revoked/i);
  });

  it("keeps Built-in blocklist Disclosure open across re-renders", async () => {
    render(<DecisionSettings />);
    await screen.findByLabelText(/block a host/i);

    const region = screen.getByRole("region", { name: "Built-in blocklist" });
    const details = region.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    openDetails(region);
    expect(details.open).toBe(true);

    // Trigger a state re-render by typing into #blocklist-entry.
    fireEvent.change(screen.getByLabelText(/block a host/i), {
      target: { value: "example.com" },
    });
    expect(details.open).toBe(true);
  });

  it("adds a blocklist entry when pressing Enter in #blocklist-entry and renders feedback inside the acted-on section", async () => {
    render(<DecisionSettings />);
    const blocklistSection = screen.getByRole("region", {
      name: BLOCKLIST_SECTION,
    });
    const input = await within(blocklistSection).findByLabelText(/block a host/i);
    fireEvent.change(input, { target: { value: "enter-host.example" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await within(blocklistSection).findByText("enter-host.example");
    expect(workerBlocklist).toContain("enter-host.example");

    // Feedback notice renders inside the acted-on blocklist section.
    const alertInSection = await within(blocklistSection).findByRole("status");
    expect(alertInSection.textContent).toContain("Blocklist saved.");
  });

  it("uses 'in Connections' copy instead of stale 'above' references", async () => {
    sendMessageSpy.mockImplementation(shellWorkerReply);
    render(<DecisionSettings />);
    const escalationSection = screen.getByRole("region", {
      name: ESCALATION_SECTION,
    });
    expect(escalationSection.textContent).toContain(
      "LLM provider configured in Connections",
    );
    await within(escalationSection).findByText(
      /Configure and enable an LLM provider in Connections/i,
    );
  });
});
