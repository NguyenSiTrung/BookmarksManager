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
  grantTestConsent,
  hasConsent,
  hasTestConsent,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { BUILTIN_SENSITIVE_SITES } from "../../src/decisions/minimize";
import type { DecisionSettings as SettingsValue } from "../../src/decisions/policy";
import { DecisionSettings } from "../../src/entrypoints/options/DecisionSettings";
import { SentLog } from "../../src/entrypoints/options/SentLog";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import { PRESETS } from "../../src/net/presets";
import { SENT_LOG_RETENTION_CAP } from "../../src/net/sent-log";
import {
  DECISIONS_CONSENT_SCOPE,
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

function allowButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /allow .* bookmark analysis/i,
  }) as HTMLButtonElement;
}

async function grantDecisionsConsent(preset: PresetId = "typesafe") {
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

  it("does not send for a duplicate entry", async () => {
    workerBlocklist = ["example.org"];
    render(<DecisionSettings />);
    await screen.findByText("example.org");
    fireEvent.change(screen.getByLabelText(/block a host/i), {
      target: { value: "EXAMPLE.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await screen.findByText(/already/i);
    expect(sentDecisionTypes()).toEqual(["GET_SETTINGS"]);
  });

  it("does not send for input that cannot name a host", async () => {
    render(<DecisionSettings />);
    await screen.findByLabelText(/block a host/i);
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

  it("lists only metadata — time, destination, feature, field names", async () => {
    await seedLog();
    render(<SentLog />);
    await screen.findByText("https://api.typesafe.ai");
    expect(screen.getByText("https://openrouter.ai")).toBeTruthy();
    expect(screen.getByText(/jev_decisions/)).toBeTruthy();
    expect(screen.getByText(/title, url, domain/)).toBeTruthy();
    expect(screen.getByText(/model, state, questions/)).toBeTruthy();
    // The retention cap is disclosed with the enforced bound.
    expect(
      screen.getByText(new RegExp(`${SENT_LOG_RETENTION_CAP}`)),
    ).toBeTruthy();
  });

  it("shows the empty state and clears the log", async () => {
    render(<SentLog />);
    await screen.findByText(/nothing has been sent/i);
    // A Dexie write re-fires the live query — wrap it so the state update
    // lands inside act.
    await act(async () => {
      await db.sentLog.add({
        sentAt: "2026-09-25T10:05:00.000Z",
        destination: "https://api.typesafe.ai",
        feature: "jev_decisions",
        fieldNames: ["title"],
      });
    });
    await screen.findByText("https://api.typesafe.ai");
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
    const totals = await screen.findByText(/600 input tokens/);
    expect(totals.textContent).toContain("180 output tokens");
    expect(totals.textContent).toContain("cost reported on 2 of 3 requests");
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
    const totals = await screen.findByText(/42 input tokens/);
    expect(totals.textContent).toContain("cost reported on 0 of 1 requests");
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
        "LLM_PROVIDER_STATUS",
        "LLM_ESCALATION_STATUS",
      ]).toContain(type);
    }
  });

  it("renders a generic error when the worker returns a non-protocol reply", async () => {
    sendMessageSpy.mockResolvedValue({ nonsense: true });
    render(<DecisionSettings />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/unexpected/i);
  });

  it("renders the worker's {ok:false} code and message verbatim", async () => {
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
  it("shows a retryable failure — not perpetual loading — and retry re-calls GET_SETTINGS", async () => {
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
  });

  it("keeps the retry state when the retried load fails again", async () => {
    sendMessageSpy.mockRejectedValue(new Error("worker gone"));
    render(<DecisionSettings />);
    await screen.findByRole("alert");
    const retries = screen.getAllByRole("button", { name: /^retry$/i });
    fireEvent.click(retries[0]!);
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
