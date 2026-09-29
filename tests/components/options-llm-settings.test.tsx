import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  CONSENT_VERSION,
  hasConsentAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { DecisionSettings } from "../../src/entrypoints/options/DecisionSettings";
import type { DecisionSettings as SettingsValue } from "../../src/decisions/policy";
import { LLM_ESCALATE_SCOPE } from "../../src/schemas/provider";

/**
 * Options → "Automatic second opinions" section (plan Phase 3 Task 4):
 * off-by-default toggle gated behind a configured provider, the
 * `llm_escalate` origin consent (with its verbatim disclosure), and a
 * monthly cap — plus the worker-owned escalation status/set round-trip.
 */

const ALL_OFF: SettingsValue = {
  autoApply: { add_tags: false, set_category: false },
};

const LLM_ORIGIN = "https://api.openai.com";

interface FakeWorkerState {
  providerStatus: {
    configured: boolean;
    enabled: boolean;
    consentGranted: boolean;
    permissionGranted: boolean;
    active: boolean;
    providerId?: string;
    origin?: string;
    monthlyBudgetUsd?: number;
  };
  escalation: {
    enabled: boolean;
    providerConfigured: boolean;
    monthlyBudgetUsd: number | null;
    budget: "capped" | "unlimited" | "unset";
    pricingKnown: boolean;
    providerId?: string;
  };
  escalationSetError?: { code: string; message: string };
}

let workerState: FakeWorkerState;
let sendMessageSpy: ReturnType<typeof vi.fn>;

const CONFIGURED_PROVIDER = {
  configured: true,
  enabled: true,
  consentGranted: true,
  permissionGranted: true,
  active: true,
  providerId: "preset:openai",
  origin: LLM_ORIGIN,
  monthlyBudgetUsd: 5,
};

const IDLE_ESCALATION = {
  enabled: false,
  providerConfigured: true,
  monthlyBudgetUsd: 5,
  budget: "capped" as const,
  pricingKnown: true,
  providerId: "preset:openai",
};

/** Worker double covering the decisions + LLM provider/feature protocols. */
function workerReply(message: unknown): Promise<unknown> {
  const msg = message as {
    type: string;
    settings?: SettingsValue;
    enabled?: boolean;
  };
  switch (msg.type) {
    case "GET_SETTINGS":
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: ALL_OFF,
        blocklist: [],
      });
    case "SET_SETTINGS":
    case "SET_BLOCKLIST":
      return Promise.resolve({
        ok: true,
        code: "settings_ok",
        settings: ALL_OFF,
        blocklist: [],
      });
    case "LLM_PROVIDER_STATUS":
      return Promise.resolve({ ok: true, status: workerState.providerStatus });
    case "LLM_ESCALATION_STATUS":
      return Promise.resolve({
        ok: true,
        code: "escalation_status",
        escalation: workerState.escalation,
      });
    case "LLM_ESCALATION_SET": {
      if (workerState.escalationSetError !== undefined) {
        return Promise.resolve({
          ok: false,
          code: workerState.escalationSetError.code,
          message: workerState.escalationSetError.message,
        });
      }
      workerState.escalation = {
        ...workerState.escalation,
        enabled: msg.enabled === true,
      };
      return Promise.resolve({
        ok: true,
        code: "escalation_status",
        escalation: workerState.escalation,
      });
    }
    default:
      return Promise.resolve({
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      });
  }
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
afterAll(() => {
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.consents.clear();
  await db.metadata.clear();
  workerState = {
    providerStatus: CONFIGURED_PROVIDER,
    escalation: { ...IDLE_ESCALATION },
  };
  delete workerState.escalationSetError;
  sendMessageSpy = vi.fn(workerReply);
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: sendMessageSpy,
      getURL: (p: string) => `chrome-extension://testext/${p}`,
    },
  });
});

async function section(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: /automatic second opinions/i }),
    ).toBeTruthy(),
  );
  return screen.getByRole("heading", { name: /automatic second opinions/i })
    .parentElement as HTMLElement;
}

/**
 * The escalation disclosure read gate (Task 3): the second-opinion agree
 * checkbox is disabled until the disclosure has been opened once. jsdom
 * does not toggle `<details>` on summary clicks, so flip the DOM attribute
 * and fire `toggle` directly. `findByRole` because the disclosure mounts
 * only after the provider-status effect lands `llmOrigin` — under a loaded
 * worker that can trail the section heading by a beat.
 */
async function openEscalationDisclosure(): Promise<void> {
  const region = await screen.findByRole("region", {
    name: "Second opinion disclosure",
  });
  const details = region.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

async function escalateToggle(): Promise<HTMLElement> {
  return await screen.findByRole("switch", {
    name: /second opinion on unsure suggestions/i,
  });
}

describe("escalation section", () => {
  it("renders the disclosure verbatim and the toggle off by default", async () => {
    render(<DecisionSettings />);
    await section();
    const toggle = await escalateToggle();
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(
      screen.getByText(/give a second opinion on a low-confidence/i),
    ).toBeTruthy();
    const region = screen.getByRole("region", {
      name: "Second opinion disclosure",
    });
    expect(region.textContent).toContain("decision state");
    expect(region.textContent).toContain("Jev answer");
    expect(screen.getByText(/Monthly cap: \$5\.00/)).toBeTruthy();
  });

  it("asks for consent before the toggle unlocks", async () => {
    render(<DecisionSettings />);
    await section();
    await openEscalationDisclosure();
    const toggle = await escalateToggle();
    await waitFor(() => expect(toggle).toHaveProperty("disabled", true));
    // Grant the llm_escalate scope at the provider's origin.
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /allow second opinions to be sent to/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Allow second opinions$/ }),
    );
    await waitFor(() =>
      expect(
        hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
      ).resolves.toBe(true),
    );
    await waitFor(async () => expect((await escalateToggle())).toHaveProperty("disabled", false));
  });

  it("gates the second-opinion checkbox on the disclosure and re-arms on revoke", async () => {
    render(<DecisionSettings />);
    await section();
    const box = (await screen.findByRole("checkbox", {
      name: /allow second opinions to be sent to/i,
    })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    // Scoped to the escalation gate's reason <p> (basis-full): the
    // bookmark-analysis gate on the same page renders the same sentence.
    expect(
      screen.getByText("Open the disclosure above first.", {
        selector: "p.basis-full",
      }),
    ).toBeTruthy();
    await openEscalationDisclosure();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: /allow second opinions to be sent to/i,
          }) as HTMLInputElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /allow second opinions to be sent to/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Allow second opinions$/ }),
    );
    await waitFor(() =>
      expect(
        hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
      ).resolves.toBe(true),
    );
    // Revoking returns the consent row with the gate re-armed.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revoke second-opinion consent",
      }),
    );
    const back = (await screen.findByRole("checkbox", {
      name: /allow second opinions to be sent to/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(back.disabled).toBe(true));
    expect(
      screen.getByText("Open the disclosure above first.", {
        selector: "p.basis-full",
      }),
    ).toBeTruthy();
  });

  it("enabling sends LLM_ESCALATION_SET and reflects the reply", async () => {
    render(<DecisionSettings />);
    await section();
    // Consent first (the direct Dexie write the page performs).
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    await waitFor(async () => expect((await escalateToggle())).toHaveProperty("disabled", false));
    fireEvent.click(await escalateToggle());
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith({
        type: "LLM_ESCALATION_SET",
        enabled: true,
      }),
    );
    await waitFor(async () => expect((await escalateToggle()).getAttribute("aria-checked")).toBe("true"));
  });

  it("shows 'no provider' guidance when nothing is configured", async () => {
    workerState.providerStatus = {
      configured: false,
      enabled: false,
      consentGranted: false,
      permissionGranted: false,
      active: false,
    };
    workerState.escalation = {
      enabled: false,
      providerConfigured: false,
      monthlyBudgetUsd: null,
      budget: "unset",
      pricingKnown: false,
    };
    render(<DecisionSettings />);
    await section();
    await waitFor(() =>
      expect(
        screen.getByText(/configure and enable an llm provider above/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("switch", {
      name: /second opinion on unsure suggestions/i,
    })).toBeNull();
  });

  it("blocks the toggle and explains it when no spending ceiling is chosen", async () => {
    workerState.escalation = {
      enabled: false,
      providerConfigured: true,
      monthlyBudgetUsd: null,
      budget: "unset",
      pricingKnown: true,
      providerId: "preset:openai",
    };
    render(<DecisionSettings />);
    await section();
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(
        screen.getByText(/no spending ceiling is chosen/i),
      ).toBeTruthy(),
    );
    expect((await escalateToggle())).toHaveProperty("disabled", true);
  });

  it("unlocks on an explicitly unlimited ceiling and says so", async () => {
    workerState.escalation = {
      enabled: false,
      providerConfigured: true,
      monthlyBudgetUsd: null,
      budget: "unlimited",
      pricingKnown: true,
      providerId: "preset:openai",
    };
    render(<DecisionSettings />);
    await section();
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    await waitFor(async () =>
      expect(await escalateToggle()).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByText(/no monthly cap — this can spend without a limit/i),
    ).toBeTruthy();
  });

  it("blocks the toggle when the provider has no per-token price", async () => {
    workerState.escalation = {
      enabled: false,
      providerConfigured: true,
      monthlyBudgetUsd: 5,
      budget: "capped",
      pricingKnown: false,
      providerId: "preset:openai",
    };
    render(<DecisionSettings />);
    await section();
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    await waitFor(() =>
      expect(
        screen.getByText(/no per-token price is known for this model/i),
      ).toBeTruthy(),
    );
    expect((await escalateToggle())).toHaveProperty("disabled", true);
  });

  it("renders the worker's {ok:false} verbatim in the page alert", async () => {
    workerState.escalationSetError = {
      code: "no_provider",
      message: "Enable escalation needs a configured LLM provider.",
    };
    render(<DecisionSettings />);
    await section();
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    await waitFor(async () => expect((await escalateToggle())).toHaveProperty("disabled", false));
    fireEvent.click(await escalateToggle());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Enable escalation needs a configured LLM provider.",
      ),
    );
  });

  it("revoke removes the llm_escalate grant", async () => {
    await db.consents.put({
      scope: LLM_ESCALATE_SCOPE,
      origin: LLM_ORIGIN,
      consentVersion: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    render(<DecisionSettings />);
    await section();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /revoke second-opinion consent/i,
        }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /revoke second-opinion consent/i }),
    );
    await waitFor(() =>
      expect(
        hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
      ).resolves.toBe(false),
    );
  });
});
