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
  DECISIONS_NEVER_SENT_FIELDS,
  DECISIONS_PURPOSES,
  DECISIONS_SENT_FIELDS,
  DECISIONS_TRIGGER_NOTE,
  DECISIONS_TRIGGERS,
  PROVIDER_DISCLOSURES,
} from "../../src/consent/disclosure";
import {
  CONSENT_VERSION,
  grantConsent,
  grantConsentAtOrigin,
  grantTestConsent,
  hasConsent,
  hasConsentAtOrigin,
  hasTestConsent,
  revokeConsentsAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { BUILTIN_SENSITIVE_SITES } from "../../src/decisions/minimize";
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
  LLM_ESCALATE_SCOPE,
  LLM_TEST_SCOPE,
  ProviderSettings,
  type JevProviderId,
  type PresetId,
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

const ALL_OFF: SettingsValue = {
  autoApply: { add_tags: false, set_category: false },
};

/**
 * In-memory worker double for the decisions settings protocol. The worker is
 * not running in tests; this answers GET_SETTINGS/SET_SETTINGS/SET_BLOCKLIST
 * the way `handleDecisionsMessage` would and tracks state across renders so
 * round-trips are exercised through the message boundary.
 */
function workerReply(message: unknown): Promise<DecisionMessageResult> {
  const msg = message as {
    type: string;
    settings?: SettingsValue;
    blocklist?: string[];
  };
  switch (msg.type) {
    case "GET_SETTINGS":
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
    case "SET_SETTINGS":
      workerSettings = msg.settings ?? ALL_OFF;
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
    case "SET_BLOCKLIST":
      workerBlocklist = [...(msg.blocklist ?? [])];
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: workerSettings,
        blocklist: [...workerBlocklist],
      });
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

const DECISION_TYPES = ["GET_SETTINGS", "SET_SETTINGS", "SET_BLOCKLIST"];

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

function agreeBox(): HTMLInputElement {
  return screen.getByRole("checkbox", {
    name: /agree/i,
  }) as HTMLInputElement;
}

/**
 * The disclosure read gate (Task 3): the agree box is inert (`aria-disabled`)
 * until the disclosure has been opened once. jsdom does not toggle `<details>`
 * on summary clicks, so flip the DOM attribute and fire `toggle` directly —
 * the same pattern options-primitives uses for Disclosure.
 */
function openDisclosure(): void {
  const details = screen
    .getByRole("region", { name: /bookmark data disclosure/i })
    .closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

function allowButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /allow .* bookmark analysis/i,
  }) as HTMLButtonElement;
}

async function grantDecisionsConsent(preset: PresetId = "typesafe") {
  openDisclosure();
  fireEvent.click(agreeBox());
  await waitFor(() => expect(allowButton().disabled).toBe(false));
  fireEvent.click(allowButton());
  await waitFor(async () => {
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, preset)).toBe(true);
  });
}

describe("decisions consent disclosure", () => {
  it("renders every sent field, never-sent field, purpose, trigger, and the privacy-policy link verbatim", async () => {
    render(<DecisionSettings />);
    const disclosure = await screen.findByRole("region", {
      name: /bookmark data disclosure/i,
    });
    const view = within(disclosure);
    // Recipient and literal origin.
    expect(disclosure.textContent).toContain(PROVIDER_DISCLOSURES.typesafe.name);
    expect(disclosure.textContent).toContain(PRESETS.typesafe.origin);
    // Every sent field, verbatim from the typed constants.
    for (const field of DECISIONS_SENT_FIELDS) {
      expect(disclosure.textContent).toContain(field);
    }
    // The negative list is stated plainly.
    for (const field of DECISIONS_NEVER_SENT_FIELDS) {
      expect(disclosure.textContent).toContain(field);
    }
    // Every purpose and trigger, plus the user-started-only note.
    for (const purpose of DECISIONS_PURPOSES) {
      expect(disclosure.textContent).toContain(purpose);
    }
    for (const trigger of DECISIONS_TRIGGERS) {
      expect(disclosure.textContent).toContain(trigger);
    }
    expect(disclosure.textContent).toContain(DECISIONS_TRIGGER_NOTE);
    // Provider data note and privacy-policy link.
    expect(disclosure.textContent).toContain(
      PROVIDER_DISCLOSURES.typesafe.dataNote,
    );
    const link = view.getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    expect(link.href).toBe(PROVIDER_DISCLOSURES.typesafe.privacyPolicyUrl);
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("starts the agree checkbox unchecked and the consent action disabled", async () => {
    render(<DecisionSettings />);
    const agree = await screen.findByRole("checkbox", { name: /agree/i });
    expect((agree as HTMLInputElement).checked).toBe(false);
    const allow = allowButton();
    expect(allow.disabled).toBe(true);
    // Clicking the disabled button grants nothing and sends nothing.
    fireEvent.click(allow);
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(false);
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("switches the disclosure with the provider radio", async () => {
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    const disclosure = await screen.findByRole("region", {
      name: /openrouter bookmark data disclosure/i,
    });
    expect(disclosure.textContent).toContain(PRESETS.openrouter.origin);
    expect(disclosure.textContent).toContain(
      PROVIDER_DISCLOSURES.openrouter.dataNote,
    );
    const link = within(disclosure).getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    expect(link.href).toBe(PROVIDER_DISCLOSURES.openrouter.privacyPolicyUrl);
    // Switching resets the agreement box — never pre-checked. The consent
    // panel reads pending until the live query emits for the new preset.
    const agree = (await screen.findByRole("checkbox", {
      name: /agree/i,
    })) as HTMLInputElement;
    expect(agree.checked).toBe(false);
    expect(allowButton().disabled).toBe(true);
  });

  it("reopens the configured custom provider instead of the first preset", async () => {
    sendMessageSpy.mockImplementation((message: unknown) => {
      const msg = message as { type: string; preset?: string };
      if (msg.type === "PROVIDER_STATUS") {
        const configured = msg.preset === "custom";
        return Promise.resolve({
          ok: true,
          status: {
            enabled: configured,
            consentGranted: configured,
            ...(configured
              ? { origin: "https://jev.example.com", model: "jev-latest" }
              : {}),
          },
        } as unknown as DecisionMessageResult);
      }
      return workerReply(message);
    });
    render(<DecisionSettings />);
    // Before the probe the picker sat on TypeSafe regardless of what the
    // worker holds — the consent would have been written to the wrong origin.
    const radio = (await screen.findByRole("radio", {
      name: /custom jev provider/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(radio.checked).toBe(true));
    const disclosure = await screen.findByRole("region", {
      name: /custom jev provider bookmark data disclosure/i,
    });
    expect(disclosure.textContent).toContain("https://jev.example.com");
  });
});

describe("decisions consent grant and revoke", () => {
  it("writes a jev_decisions consent row directly (no consent message exists)", async () => {
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    await grantDecisionsConsent();
    // The granted panel replaces the form once the live query re-reads.
    await screen.findByRole("button", { name: /revoke .* analysis consent/i });
    // Consent is a direct Dexie write — the only message ever sent is the
    // settings read; no consent message leaves the page.
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("shows the un-consented screen (re-disclosure) for a stale consentVersion row", async () => {
    await db.consents.put({
      scope: DECISIONS_CONSENT_SCOPE,
      origin: PRESETS.typesafe.origin,
      consentVersion: CONSENT_VERSION - 1,
      acceptedAt: "2025-01-01T00:00:00.000Z",
    });
    render(<DecisionSettings />);
    // hasConsent rejects the stale version — the grant flow is shown again.
    const agree = await screen.findByRole("checkbox", { name: /agree/i });
    expect((agree as HTMLInputElement).checked).toBe(false);
    expect(allowButton().disabled).toBe(true);
    expect(
      screen.queryByRole("button", { name: /revoke .* analysis consent/i }),
    ).toBeNull();
  });

  it("revokes only the jev_decisions grant and leaves jev_test intact", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await grantTestConsent("typesafe");
    render(<DecisionSettings />);
    const revoke = await screen.findByRole("button", {
      name: /revoke .* analysis consent/i,
    });
    fireEvent.click(revoke);
    await waitFor(async () => {
      expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(false);
    });
    // The provider connection consent is untouched.
    expect(await hasTestConsent("typesafe")).toBe(true);
    // The un-consented screen returns.
    await screen.findByRole("checkbox", { name: /agree/i });
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("keeps consent state per provider", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "openrouter");
    render(<DecisionSettings />);
    // TypeSafe un-consented; OpenRouter granted.
    await screen.findByRole("checkbox", { name: /agree/i });
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await screen.findByRole("button", { name: /revoke .* analysis consent/i });
    expect(screen.queryByRole("checkbox", { name: /agree/i })).toBeNull();
  });

  it("renders pending — not the previous provider's panel — across a preset switch", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    render(<DecisionSettings />);
    await screen.findByRole("button", {
      name: /revoke typesafe analysis consent/i,
    });
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    // Synchronously after the switch the stale TypeSafe verdict is still the
    // live query's last emission — it must read pending, never a "Revoke
    // OpenRouter…" panel under the new disclosure.
    expect(screen.getByText(/checking consent/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /revoke openrouter/i }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /agree/i })).toBeNull();
    // Once the query emits for OpenRouter, its real un-consented form shows.
    const agree = await screen.findByRole("checkbox", { name: /agree/i });
    expect((agree as HTMLInputElement).checked).toBe(false);
    expect(allowButton().textContent).toContain("OpenRouter");
  });
});

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

  it("persists a flip via SET_SETTINGS carrying the whole DecisionSettings object", async () => {
    render(<DecisionSettings />);
    const addTags = await screen.findByRole("switch", {
      name: /tag additions/i,
    });
    fireEvent.click(addTags);
    await waitFor(() => {
      expect(sentDecisionTypes()).toEqual(["GET_SETTINGS", "SET_SETTINGS"]);
    });
    const message = sendMessageSpy.mock.calls
      .map(([m]) => m as { type: string; settings?: SettingsValue })
      .find((m) => m.type === "SET_SETTINGS") as {
      type: string;
      settings: SettingsValue;
    };
    expect(message.type).toBe("SET_SETTINGS");
    expect(message.settings).toEqual({
      autoApply: { add_tags: true, set_category: false },
    });
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
          type: "SET_SETTINGS",
          settings: { autoApply: { add_tags: true, set_category: true } },
        }),
      ),
    );
  });
});

describe("blocklist editor", () => {
  it("adds a normalized entry via SET_BLOCKLIST and lists it", async () => {
    render(<DecisionSettings />);
    const input = await screen.findByLabelText(/block a host/i);
    fireEvent.change(input, { target: { value: "Example.ORG" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SET_BLOCKLIST",
          blocklist: ["example.org"],
        }),
      ),
    );
    await screen.findByText("example.org");
    expect(workerBlocklist).toEqual(["example.org"]);
  });

  it("removes an entry via SET_BLOCKLIST", async () => {
    workerBlocklist = ["example.org", "example.net"];
    render(<DecisionSettings />);
    await screen.findByText("example.org");
    fireEvent.click(
      screen.getByRole("button", { name: /remove example\.org/i }),
    );
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SET_BLOCKLIST",
          blocklist: ["example.net"],
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("example.org")).toBeNull());
    expect(screen.getByText("example.net")).toBeTruthy();
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
    await screen.findByRole("checkbox", { name: /agree/i });
    await grantDecisionsConsent();
    fireEvent.click(
      await screen.findByRole("switch", { name: /tag additions/i }),
    );
    await waitFor(() =>
      expect(sentDecisionTypes()).toContain("SET_SETTINGS"),
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

describe("disclosure read gate", () => {
  it("opens and reveals the disclosure instead of agreeing on an early click", async () => {
    render(<DecisionSettings />);
    const box = (await screen.findByRole("checkbox", {
      name: /agree/i,
    })) as HTMLInputElement;
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    fireEvent.click(box);
    // The click opened the disclosure and did not record agreement.
    await waitFor(() => expect(box.getAttribute("aria-disabled")).toBeNull());
    expect(box.checked).toBe(false);
    expect(
      screen.queryByText("Open the disclosure above first."),
    ).toBeNull();
    // The disclosure is read now, so the next click is an affirmation.
    fireEvent.click(agreeBox());
    await waitFor(() => expect(agreeBox().checked).toBe(true));
  });

  it("re-arms the gate on preset changes and after consent is revoked", async () => {
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    openDisclosure();
    await waitFor(() =>
      expect(agreeBox().getAttribute("aria-disabled")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await waitFor(() =>
      expect(agreeBox().getAttribute("aria-disabled")).toBe("true"),
    );
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    cleanup();
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    await grantDecisionsConsent();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /revoke .* analysis consent/i,
      }),
    );
    const box = (await screen.findByRole("checkbox", {
      name: /agree/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(box.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
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
const CONSENT_SECTION = /bookmark analysis consent/i;
const ESCALATION_SECTION = /automatic second opinions/i;
const BLOCKLIST_SECTION = /never send these sites/i;

const CUSTOM_ORIGIN = "https://jev.example.com";
const SECOND_ORIGIN = "https://jev2.example.com";
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

/**
 * A valid stored custom-Jev settings row — the shape ENABLE_PROVIDER
 * persists. `keySuffix` is the masked display hint, never key material.
 */
function customJevSettings(baseUrl: string): ProviderSettings {
  return ProviderSettings.parse({
    preset: CUSTOM_PROVIDER_ID,
    baseUrl,
    model: "jev-latest",
    keySuffix: "****",
  });
}

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

/** Grant the bookmark-analysis consent at the currently selected origin. */
async function grantDecisionsConsentInShell(origin: string): Promise<void> {
  const section = screen.getByRole("region", { name: CONSENT_SECTION });
  openDetails(
    await within(section).findByRole("region", {
      name: /bookmark data disclosure/i,
    }),
  );
  const box = (await within(section).findByRole("checkbox", {
    name: /agree/i,
  })) as HTMLInputElement;
  await waitFor(() => expect(box.getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(box);
  const allow = within(section).getByRole("button", {
    name: /allow .* bookmark analysis/i,
  }) as HTMLButtonElement;
  await waitFor(() => expect(allow.disabled).toBe(false));
  fireEvent.click(allow);
  await waitFor(async () =>
    expect(await hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, origin)).toBe(true),
  );
}

/** The radio input inside a provider card, by accessible name. */
function cardFor(section: HTMLElement, name: RegExp): HTMLInputElement {
  return within(section).getByRole("radio", { name }) as HTMLInputElement;
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
  it("reflects a custom Jev provider enabled in Connections without remounting", async () => {
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    // Nothing is configured yet: only the two registry presets are offered.
    expect(within(consent).queryByRole("radio", { name: /custom/i })).toBeNull();
    // An uncommitted edit in this panel is the no-remount witness.
    const blocklist = screen.getByRole("region", { name: BLOCKLIST_SECTION });
    fireEvent.change(within(blocklist).getByLabelText(/block a host/i), {
      target: { value: "example.org" },
    });

    await enableCustomJevProvider({
      baseUrl: CUSTOM_ORIGIN,
      model: "jev-latest",
      key: "custom-key-1",
    });

    // While the Permissions panel is still hidden, it already has the card.
    await waitFor(() =>
      expect(
        within(
          document.getElementById("permissions") as HTMLElement,
        ).queryByRole("radio", {
          name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
          hidden: true,
        }),
      ).not.toBeNull(),
    );

    showPanel("Permissions");
    const radio = await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
    // Nothing was remounted: the uncommitted edit made before the provider
    // was enabled survived the enable and the panel switch.
    expect(
      (within(blocklist).getByLabelText(/block a host/i) as HTMLInputElement)
        .value,
    ).toBe("example.org");
    fireEvent.click(radio);
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
    const card = radio.closest("label") as HTMLElement;
    expect(card.textContent).toContain(CUSTOM_ORIGIN);
    // The freshly read origin is the one consent is granted against.
    await grantDecisionsConsentInShell(CUSTOM_ORIGIN);
    await within(consent).findByRole("button", {
      name: /revoke custom jev provider analysis consent/i,
    });
  });

  it("drops a revoked custom provider and never reuses consent from a replaced origin", async () => {
    await mountOptionsShell();
    await enableCustomJevProvider({
      baseUrl: CUSTOM_ORIGIN,
      model: "jev-latest",
      key: "custom-key-1",
    });
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    fireEvent.click(
      await within(consent).findByRole("radio", {
        name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
      }),
    );
    await grantDecisionsConsentInShell(CUSTOM_ORIGIN);

    // Revoke it from Connections while Permissions is hidden.
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

    showPanel("Permissions");
    await waitFor(() =>
      expect(
        within(consent).queryByRole("radio", { name: /custom/i }),
      ).toBeNull(),
    );
    // The selection falls back to a provider that still exists.
    await waitFor(() => expect(cardFor(consent, /^TypeSafe$/).checked).toBe(true));
    // Revoking the provider removed the grant it carried at its origin.
    expect(await hasConsentAtOrigin(DECISIONS_CONSENT_SCOPE, CUSTOM_ORIGIN)).toBe(
      false,
    );

    // Re-enabling at a different origin starts un-consented there: the grant
    // recorded for the replaced origin is never reused.
    await enableCustomJevProvider({
      baseUrl: SECOND_ORIGIN,
      model: "jev-latest",
      key: "custom-key-2",
    });
    showPanel("Permissions");
    const radio = await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
    fireEvent.click(radio);
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
    const card = radio.closest("label") as HTMLElement;
    expect(card.textContent).toContain(SECOND_ORIGIN);
    expect(card.textContent).not.toContain(CUSTOM_ORIGIN);
    await within(consent).findByRole("checkbox", { name: /agree/i });
    expect(
      within(consent).queryByRole("button", {
        name: /revoke .* analysis consent/i,
      }),
    ).toBeNull();
  });

  it("drops a superseded custom-origin reply instead of reusing it", async () => {
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });

    // Hold every custom-provider reply, then move the provider twice.
    holdCustomProbes = true;
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(CUSTOM_ORIGIN),
      });
    });
    await waitFor(() => expect(heldProbes).toHaveLength(1));
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(SECOND_ORIGIN),
      });
    });
    await waitFor(() => expect(heldProbes).toHaveLength(2));

    // The newer read answers first.
    await act(async () => {
      heldProbes[1]!();
    });
    const card = () =>
      cardFor(consent, new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i")).closest(
        "label",
      ) as HTMLElement;
    await waitFor(() => expect(card().textContent).toContain(SECOND_ORIGIN));

    // The superseded reply now settles — it must not overwrite the newer one.
    await act(async () => {
      heldProbes[0]!();
    });
    expect(card().textContent).not.toContain(CUSTOM_ORIGIN);
    expect(card().textContent).toContain(SECOND_ORIGIN);
  });

  it("reflects the LLM origin and a changed spending ceiling in the hidden panel", async () => {
    await mountOptionsShell();
    showPanel("Permissions");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    await within(escalation).findByText(
      /configure and enable an llm provider above/i,
    );

    await enableLlmProvider({ cap: "5" });

    // Already live in the hidden Permissions panel…
    await waitFor(() =>
      expect(
        within(
          document.getElementById("permissions") as HTMLElement,
        ).getByRole("region", {
          name: "Second opinion disclosure",
          hidden: true,
        }),
      ).toBeTruthy(),
    );

    showPanel("Permissions");
    await within(escalation).findByRole("region", {
      name: "Second opinion disclosure",
    });
    expect(escalation.textContent).toContain(LLM_ORIGIN);
    await within(escalation).findByText(/Monthly cap: \$5\.00/);

    // A ceiling change in the Connections budget panel flows through too.
    showPanel("Connections");
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

  it("keeps the second-opinion controls in step with consent, the toggle, and a revoke", async () => {
    await mountOptionsShell();
    await enableLlmProvider({ cap: "5" });
    showPanel("Permissions");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    const toggle = () =>
      within(escalation).getByRole("switch", {
        name: /second opinion on unsure suggestions/i,
      }) as HTMLElement;
    // No `llm_escalate` grant yet: the toggle is soft-blocked, not dead —
    // the reason names the consent step.
    await waitFor(() =>
      expect(toggle().getAttribute("aria-disabled")).toBe("true"),
    );
    expect(
      await within(escalation).findByText(
        /grant second-opinion consent above/i,
      ),
    ).toBeTruthy();

    const disclosure = within(escalation).getByRole("region", {
      name: "Second opinion disclosure",
    });
    openDetails(disclosure);
    expect(disclosure.textContent).toContain("focusing Tags or clicking Suggest in the popup");
    expect(disclosure.textContent).toContain("clicking Resume");
    expect(disclosure.textContent).not.toMatch(/\bSave\b/);
    fireEvent.click(
      await within(escalation).findByRole("checkbox", {
        name: /allow second opinions to be sent to/i,
      }),
    );
    const allow = await within(escalation).findByRole("button", {
      name: /^allow second opinions$/i,
    }) as HTMLButtonElement;
    await waitFor(() => expect(allow.disabled).toBe(false));
    fireEvent.click(allow);
    await waitFor(() =>
      expect(toggle().getAttribute("aria-disabled")).toBeNull(),
    );
    expect(
      await hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
    ).toBe(true);

    fireEvent.click(toggle());
    await waitFor(() =>
      expect(toggle().getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(async () =>
      expect((await db.metadata.get(ESCALATION_KEY))?.value).toMatchObject({
        enabled: true,
      }),
    );

    // Revoking the provider takes the section back to the no-provider state.
    showPanel("Connections");
    fireEvent.click(
      within(screen.getByRole("region", { name: LLM_SECTION })).getByRole(
        "button",
        { name: /revoke llm provider access/i },
      ),
    );
    showPanel("Permissions");
    await within(escalation).findByText(
      /configure and enable an llm provider above/i,
    );
    expect(
      within(escalation).queryByRole("switch", { name: /second opinion/i }),
    ).toBeNull();
  });

  it("jumps a blocked second-opinion toggle to its Connections prerequisite", async () => {
    await mountOptionsShell();
    // A priced provider with no ceiling: with consent granted, the cap is
    // the one unmet prerequisite for the switch.
    await enableLlmProvider();
    await act(async () => {
      await db.consents.put({
        scope: LLM_ESCALATE_SCOPE,
        origin: LLM_ORIGIN,
        consentVersion: CONSENT_VERSION,
        acceptedAt: new Date().toISOString(),
      });
    });
    showPanel("Permissions");
    const escalation = screen.getByRole("region", { name: ESCALATION_SECTION });
    await within(escalation).findByText(/no spending ceiling is chosen/i);

    // Clicking the blocked switch jumps to the panel that unblocks it.
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

    // The named action in the reason list jumps the same way.
    showPanel("Permissions");
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
    showPanel("Permissions");
    await screen.findByText(/could not read the provider status/i);
    await screen.findByText(/could not read the second-opinion status/i);

    failStatusReads = false;
    fireEvent.click(
      screen.getByRole("button", { name: /retry provider status/i }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/could not read the provider status/i)).toBeNull(),
    );

    // The live path is re-armed after a retry: a new provider still lands.
    await enableCustomJevProvider({
      baseUrl: CUSTOM_ORIGIN,
      model: "jev-latest",
      key: "custom-key-3",
    });
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
  });

  it("does not render a superseded origin while the newer read is in flight", async () => {
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(CUSTOM_ORIGIN),
      });
    });
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
    // The first read has settled: the card names the stored origin and the
    // restore has landed the selection on it.
    await waitFor(() => expect(consent.textContent).toContain(CUSTOM_ORIGIN));
    await waitFor(() =>
      expect(cardFor(consent, new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i")).checked).toBe(
        true,
      ),
    );

    // Hold the next custom-origin read, then move the provider: the settled
    // value now belongs to a revision the current one has superseded.
    holdCustomProbes = true;
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(SECOND_ORIGIN),
      });
    });
    await waitFor(() => expect(heldProbes).toHaveLength(1));

    // Pre-settle window: the superseded origin is tagged with the OLD
    // revision, so it must not be rendered as the current provider — the
    // panel reads as pending instead.
    expect(consent.textContent).not.toContain(CUSTOM_ORIGIN);
    expect(
      within(consent).queryByRole("radio", { name: /custom/i }),
    ).toBeNull();
    expect(within(consent).getByText(/checking consent/i)).toBeTruthy();

    // Releasing the held read lands the new origin.
    await act(async () => {
      heldProbes[0]!();
    });
    await waitFor(() => expect(consent.textContent).toContain(SECOND_ORIGIN));
    expect(consent.textContent).not.toContain(CUSTOM_ORIGIN);
  });

  it("re-reads the worker when only a connectivity consent changes", async () => {
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    await within(consent).findByRole("radio", { name: /^TypeSafe$/ });

    // No settings row moves here: the only input is a connectivity consent
    // grant. This panel renders no control for the synthetic `jev_test` /
    // `llm_test` scopes, so the contract under test is that the worker is
    // re-asked at all — a status read that never re-runs is the bug.
    const probesBefore = providerStatusCount;
    const escalationBefore = escalationReadCount;
    await act(async () => {
      await grantConsentAtOrigin(CONSENT_SCOPE, CUSTOM_ORIGIN);
    });
    await waitFor(() =>
      expect(providerStatusCount).toBeGreaterThanOrEqual(probesBefore + 3),
    );
    expect(escalationReadCount).toBeGreaterThanOrEqual(escalationBefore + 1);

    // The LLM connectivity scope is a revision input too.
    const afterJev = providerStatusCount;
    await act(async () => {
      await grantConsentAtOrigin(LLM_TEST_SCOPE, LLM_ORIGIN);
    });
    await waitFor(() =>
      expect(providerStatusCount).toBeGreaterThanOrEqual(afterJev + 3),
    );
  });

  it("preserves a provider selected before the first settled read", async () => {
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(CUSTOM_ORIGIN),
      });
    });
    // Every Jev status probe is held, so the first settled read — and the
    // restore-once it drives — lands only when this test releases it.
    holdAllJevProbes = true;
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    const openrouter = cardFor(consent, /^OpenRouter$/);
    fireEvent.click(openrouter);
    await waitFor(() => expect(openrouter.checked).toBe(true));
    // Nothing has settled: the configured custom provider is not even known.
    expect(
      within(consent).queryByRole("radio", { name: /custom/i }),
    ).toBeNull();

    // The restore would pick the stored custom provider; it must not move a
    // selection the user already made.
    await act(async () => {
      for (const release of [...heldProbes]) release();
      heldProbes.length = 0;
    });
    await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
    expect(cardFor(consent, /^OpenRouter$/).checked).toBe(true);
    expect(
      cardFor(consent, new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i")).checked,
    ).toBe(false);
  });

  it("withholds the grant control until a custom origin resolves, and recovers on retry", async () => {
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(CUSTOM_ORIGIN),
      });
    });
    await mountOptionsShell();
    showPanel("Permissions");
    const consent = screen.getByRole("region", { name: CONSENT_SECTION });
    // The origin is known, so the grant form is live.
    await within(consent).findByRole("radio", {
      name: new RegExp(CUSTOM_JEV_PROVIDER_NAME, "i"),
    });
    await within(consent).findByRole("checkbox", { name: /agree/i });

    // The status read starts failing and the provider moves: the origin is
    // unknown, so the grant form must not render as if its Allow button
    // could act — `onGrant` no-ops against a null origin.
    failStatusReads = true;
    await act(async () => {
      await db.metadata.put({
        key: CUSTOM_PROVIDER_ID,
        value: customJevSettings(SECOND_ORIGIN),
      });
    });
    await screen.findByText(/could not read the provider status/i);
    expect(
      within(consent).queryByRole("checkbox", { name: /agree/i }),
    ).toBeNull();
    expect(
      within(consent).queryByRole("button", {
        name: /allow .* bookmark analysis/i,
      }),
    ).toBeNull();
    expect(
      within(consent).getByText(/cannot be read or changed/i),
    ).toBeTruthy();
    // The new state adds no alert: the page's alert surface stays reserved
    // for the worker's own {ok:false} reports.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(
      within(consent)
        .getByText(/cannot be read or changed/i)
        .getAttribute("role"),
    ).toBeNull();

    // Retrying resolves the moved origin and the control comes back.
    failStatusReads = false;
    fireEvent.click(
      screen.getByRole("button", { name: /retry provider status/i }),
    );
    await within(consent).findByRole("checkbox", { name: /agree/i });
    await waitFor(() => expect(consent.textContent).toContain(SECOND_ORIGIN));
  });
});
