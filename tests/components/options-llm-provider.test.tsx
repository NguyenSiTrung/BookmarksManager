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
import { LlmProviderSetup } from "../../src/entrypoints/options/LlmProviderSetup";
import type {
  LlmProviderMessageResult,
  LlmProviderStatus,
} from "../../src/messages/llm-provider";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());

const DISABLED: LlmProviderStatus = {
  configured: false,
  enabled: false,
  consentGranted: false,
  permissionGranted: false,
  active: false,
};

let requestSpy: ReturnType<typeof vi.fn>;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let statusById: Record<string, LlmProviderStatus>;
let activeId: string | null;

function providerIdOf(settings: {
  kind: string;
  preset?: string;
  baseUrl?: string;
}): string {
  return settings.kind === "preset"
    ? `preset:${settings.preset}`
    : `custom:${settings.baseUrl}`;
}

/** In-memory worker double answering the LLM_* protocol. */
function workerReply(message: unknown): Promise<LlmProviderMessageResult> {
  const msg = message as {
    type: string;
    providerId?: string;
    settings?: {
      kind: string;
      preset?: string;
      baseUrl?: string;
      model?: string;
      auth?: string;
    };
    key?: string;
  };
  switch (msg.type) {
    case "LLM_PROVIDER_STATUS": {
      const id = msg.providerId ?? activeId;
      const status =
        id !== null && statusById[id] !== undefined
          ? statusById[id]
          : { ...DISABLED };
      return Promise.resolve({ ok: true, status });
    }
    case "LLM_CONFIGURE": {
      const settings = msg.settings!;
      const id = providerIdOf(settings);
      const model =
        settings.model ?? (settings.kind === "preset" ? "gpt-4o-mini" : "m");
      statusById[id] = {
        configured: true,
        enabled: true,
        consentGranted: true,
        permissionGranted: true,
        active: true,
        providerId: id,
        origin:
          settings.kind === "preset"
            ? settings.preset === "openai"
              ? "https://api.openai.com"
              : "https://openrouter.ai"
            : new URL(settings.baseUrl!).origin,
        model,
        auth: (settings.auth ?? "bearer") as LlmProviderStatus["auth"],
        keySuffix: msg.key !== undefined ? msg.key.slice(-4) : undefined,
      };
      activeId = id;
      const next = statusById[id]!;
      return Promise.resolve({ ok: true, status: next });
    }
    case "LLM_TEST":
      return Promise.resolve({
        ok: true,
        code: "test_ok",
        result: {
          model: "gpt-4o-mini",
          latencyMs: 12,
          tier: "json_schema",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      });
    case "LLM_REVOKE": {
      statusById[msg.providerId!] = {
        configured: false,
        enabled: false,
        consentGranted: false,
        permissionGranted: false,
        active: false,
      };
      if (activeId === msg.providerId) activeId = null;
      const revoked = statusById[msg.providerId!]!;
      return Promise.resolve({ ok: true, status: revoked });
    }
    case "LLM_BUDGET_SNAPSHOT":
      return Promise.resolve({
        ok: true,
        code: "budget_snapshot",
        snapshot: {
          month: "2026-09",
          requestCount: 3,
          inputTokens: 300,
          outputTokens: 120,
          reportedCostUsd: 0.01,
          estimatedCostUsd: 0,
          unknownCostRequests: 1,
          hasUnknownCost: true,
          reservedUsd: 0,
          committedUsd: 0.01,
          budgetUsd: 5,
          remainingUsd: 4.99,
        },
      });
    default:
      return Promise.resolve({
        ok: false,
        code: "malformed_message",
        message: "unrecognized message",
      });
  }
}

beforeEach(() => {
  statusById = {};
  activeId = null;
  requestSpy = vi.fn(async () => true);
  sendMessageSpy = vi.fn(workerReply);
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("chrome", {
    permissions: { request: requestSpy },
    runtime: {
      sendMessage: sendMessageSpy,
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function callsOfType(type: string): unknown[] {
  return sendMessageSpy.mock.calls
    .map(([message]) => message)
    .filter((message) => (message as { type: string }).type === type);
}
function nonStatusCalls(): unknown[] {
  return sendMessageSpy.mock.calls
    .map(([message]) => message as { type: string })
    .filter(
      (message) =>
        message.type !== "LLM_PROVIDER_STATUS" &&
        message.type !== "LLM_BUDGET_SNAPSHOT",
    );
}
function keyInput(): HTMLInputElement {
  return screen.getByLabelText(/api key/i) as HTMLInputElement;
}
function agreeCheckbox(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: /agree/i }) as HTMLInputElement;
}
function enableButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^enable/i }) as HTMLButtonElement;
}
function customRadio(): HTMLInputElement {
  return screen.getByRole("radio", { name: /custom/i }) as HTMLInputElement;
}

async function fillPresetAndAgree(key = "sk-live-abcdef") {
  fireEvent.change(await screen.findByLabelText(/api key/i), {
    target: { value: key },
  });
  fireEvent.click(agreeCheckbox());
  await waitFor(() => expect(enableButton().disabled).toBe(false));
}

describe("disclosure", () => {
  it("names the recipient, exact origin, sent fields, credential use, purpose, and trigger", async () => {
    render(<LlmProviderSetup />);
    const disclosure = await screen.findByRole("region", {
      name: /data disclosure/i,
    });
    const view = within(disclosure);
    expect(view.getAllByText(/api\.openai\.com/).length).toBeGreaterThan(0);
    // llm_test disclosure fields, verbatim.
    expect(view.getByText("model")).toBeTruthy();
    expect(view.getByText("messages")).toBeTruthy();
    expect(view.getByText("response_format")).toBeTruthy();
    expect(view.getByText(/Authorization/)).toBeTruthy();
    expect(view.getByText("Why")).toBeTruthy();
    expect(view.getByText("When")).toBeTruthy();
    // No network while rendering the disclosure.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the stored custom origin once enabled — not the preset default", async () => {
    render(<LlmProviderSetup />);
    fireEvent.click(customRadio());
    fireEvent.change(screen.getByLabelText(/base url/i), {
      target: { value: "https://llm.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^model$/i), {
      target: { value: "local-model" },
    });
    fireEvent.change(await screen.findByLabelText(/api key/i), {
      target: { value: "sk-live-abcdef" },
    });
    fireEvent.click(agreeCheckbox());
    await waitFor(() => expect(enableButton().disabled).toBe(false));
    fireEvent.click(enableButton());

    // Enabled state folded the disclosure; it must name the grant's real
    // origin — before the fix it still read api.openai.com from the form's
    // untouched preset kind.
    const disclosure = await screen.findByRole("region", {
      name: /data disclosure/i,
    });
    expect(disclosure.textContent).toContain("https://llm.example.com");
    expect(disclosure.textContent).not.toContain("api.openai.com");
  });
});

describe("spending ceiling", () => {
  it("sends neither a cap nor unlimited when the form is left untouched", async () => {
    render(<LlmProviderSetup />);
    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    await screen.findByRole("group", { name: /enabled provider/i });
    const configure = callsOfType("LLM_CONFIGURE")[0] as Record<
      string,
      unknown
    >;
    // "Not chosen" must never be sent as an unlimited ceiling.
    expect(configure).not.toHaveProperty("monthlyBudgetUsd");
    expect(configure).not.toHaveProperty("monthlyBudgetUnlimited");
  });

  it("sends the typed cap", async () => {
    render(<LlmProviderSetup />);
    // Await the mount status read before interacting (keeps updates in act).
    fireEvent.change(await screen.findByLabelText(/monthly cap \(usd\)/i), {
      target: { value: "5" },
    });
    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    await screen.findByRole("group", { name: /enabled provider/i });
    expect(callsOfType("LLM_CONFIGURE")[0]).toMatchObject({
      monthlyBudgetUsd: 5,
    });
  });

  it("sends an explicit unlimited choice and warns about it", async () => {
    render(<LlmProviderSetup />);
    const cap = (await screen.findByLabelText(
      /monthly cap \(usd\)/i,
    )) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: "5" } });
    fireEvent.click(
      screen.getByLabelText(/no monthly cap — spend without a limit/i),
    );
    // Choosing unlimited clears and disables the cap field, and states the
    // consequence rather than hiding it.
    expect(cap.disabled).toBe(true);
    expect(cap.value).toBe("");
    expect(
      screen.getByText(/library scan can send a request per bookmark/i),
    ).toBeTruthy();

    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    await screen.findByRole("group", { name: /enabled provider/i });
    const configure = callsOfType("LLM_CONFIGURE")[0] as Record<
      string,
      unknown
    >;
    expect(configure).toMatchObject({ monthlyBudgetUnlimited: true });
    expect(configure).not.toHaveProperty("monthlyBudgetUsd");
  });
});

describe("enable flow", () => {
  it("mount sends only a status lookup — never a test request", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    expect(callsOfType("LLM_TEST")).toEqual([]);
    expect(nonStatusCalls()).toEqual([]);
  });

  it("keeps Enable disabled until the unchecked agreement box is checked", async () => {
    render(<LlmProviderSetup />);
    const enable = (await screen.findByRole("button", {
      name: /^enable/i,
    })) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(agreeCheckbox().checked).toBe(false);
    fireEvent.change(keyInput(), { target: { value: "sk-live-abcdef" } });
    expect(enableButton().disabled).toBe(true);
    fireEvent.click(agreeCheckbox());
    await waitFor(() => expect(enableButton().disabled).toBe(false));
  });

  it("requests the exact preset origin once, then sends one LLM_CONFIGURE", async () => {
    render(<LlmProviderSetup />);
    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"],
    });
    await screen.findByRole("group", { name: /enabled provider/i });
    expect(callsOfType("LLM_CONFIGURE")).toEqual([
      {
        type: "LLM_CONFIGURE",
        settings: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
        key: "sk-live-abcdef",
      },
    ]);
    // The raw key is dropped from the page: field cleared, never rendered.
    expect(document.body.textContent).not.toContain("sk-live-abcdef");
  });

  it("makes no request and writes nothing when the permission prompt is denied", async () => {
    requestSpy.mockResolvedValue(false);
    render(<LlmProviderSetup />);
    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    await screen.findByRole("alert");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(callsOfType("LLM_CONFIGURE")).toEqual([]);
    expect(screen.getByRole("alert").textContent).toMatch(
      /did not grant|denied|not granted/i,
    );
  });

  it("rejects a non-loopback http custom URL before any request", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /^enable/i });
    fireEvent.click(customRadio());
    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: "http://api.evil.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^model/i), {
      target: { value: "m" },
    });
    fireEvent.change(keyInput(), { target: { value: "sk-x" } });
    fireEvent.click(agreeCheckbox());
    fireEvent.click(enableButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/localhost|loopback|https/i);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(callsOfType("LLM_CONFIGURE")).toEqual([]);
  });

  it("rejects negative pricing before any request", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /^enable/i });
    fireEvent.click(customRadio());
    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: "https://llm.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^model/i), {
      target: { value: "m" },
    });
    fireEvent.change(screen.getByLabelText(/input.*price|price.*input/i), {
      target: { value: "-1" },
    });
    fireEvent.change(keyInput(), { target: { value: "sk-x" } });
    fireEvent.click(agreeCheckbox());
    fireEvent.click(enableButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/price|pricing|negative|nonnegative/i);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("enables a loopback auth:none provider without a key field requirement", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /^enable/i });
    fireEvent.click(customRadio());
    fireEvent.change(await screen.findByLabelText(/base url/i), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(screen.getByLabelText(/^model/i), {
      target: { value: "llama3" },
    });
    fireEvent.change(screen.getByLabelText(/auth/i), {
      target: { value: "none" },
    });
    // auth:none — no key input rendered at all.
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    fireEvent.click(agreeCheckbox());
    await waitFor(() => expect(enableButton().disabled).toBe(false));
    fireEvent.click(enableButton());
    expect(requestSpy).toHaveBeenCalledWith({
      origins: ["http://localhost/*"],
    });
    await screen.findByRole("group", { name: /enabled provider/i });
    const configure = callsOfType("LLM_CONFIGURE")[0] as {
      settings: { auth: string; baseUrl: string };
      key?: string;
    };
    expect(configure.settings.auth).toBe("none");
    expect(configure.key).toBeUndefined();
  });

  it("drops an enable result that lands after the provider kind was switched", async () => {
    let resolveConfigure: ((r: LlmProviderMessageResult) => void) | undefined;
    sendMessageSpy.mockImplementation((message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "LLM_CONFIGURE") {
        return new Promise<LlmProviderMessageResult>((resolve) => {
          resolveConfigure = resolve;
        });
      }
      return workerReply(message);
    });
    render(<LlmProviderSetup />);
    await fillPresetAndAgree();
    fireEvent.click(enableButton());
    await waitFor(() => expect(callsOfType("LLM_CONFIGURE")).toHaveLength(1));
    fireEvent.click(customRadio());
    await act(async () => {
      resolveConfigure?.({
        ok: true,
        status: {
          configured: true,
          enabled: true,
          consentGranted: true,
          permissionGranted: true,
          active: true,
          providerId: "preset:openai",
          origin: "https://api.openai.com",
          model: "gpt-4o-mini",
          auth: "bearer",
          keySuffix: "cdef",
        },
      });
    });
    // Stale preset outcome must not render on the custom panel.
    expect(
      screen.queryByRole("group", { name: /enabled provider/i }),
    ).toBeNull();
    expect(screen.queryByText(/is enabled\./i)).toBeNull();
  });
});

describe("enabled provider", () => {
  const ENABLED: LlmProviderStatus = {
    configured: true,
    enabled: true,
    consentGranted: true,
    permissionGranted: true,
    active: true,
    providerId: "preset:openai",
    origin: "https://api.openai.com",
    model: "gpt-4o-mini",
    auth: "bearer",
    keySuffix: "cdef",
  };

  beforeEach(() => {
    statusById["preset:openai"] = { ...ENABLED };
    activeId = "preset:openai";
  });

  it("shows masked suffix, origin, and model — never the raw key", async () => {
    render(<LlmProviderSetup />);
    const panel = await screen.findByRole("group", {
      name: /enabled provider/i,
    });
    expect(panel.textContent).toContain("cdef");
    expect(panel.textContent).toContain("api.openai.com");
    expect(panel.textContent).toContain("gpt-4o-mini");
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
  });

  it("Test connection sends one LLM_TEST and reports tier, model, latency, usage", async () => {
    render(<LlmProviderSetup />);
    fireEvent.click(
      await screen.findByRole("button", { name: /test connection/i }),
    );
    await waitFor(() => expect(callsOfType("LLM_TEST")).toHaveLength(1));
    expect(callsOfType("LLM_TEST")[0]).toEqual({
      type: "LLM_TEST",
      providerId: "preset:openai",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/json_schema/);
    expect(status.textContent).toMatch(/gpt-4o-mini/);
    expect(status.textContent).toMatch(/12 ?ms/);
  });

  it("renders the monthly budget snapshot with unknown-cost count", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("group", { name: /enabled provider/i });
    await waitFor(() =>
      expect(callsOfType("LLM_BUDGET_SNAPSHOT")).toHaveLength(1),
    );
    const budget = await screen.findByRole("region", { name: /budget/i });
    expect(budget.textContent).toContain("2026-09");
    expect(budget.textContent).toMatch(/3.*requests/i);
    expect(budget.textContent).toMatch(/\$0\.01/);
    expect(budget.textContent).toMatch(/1.*unknown|unknown.*1/i);
    expect(budget.textContent).toMatch(/\$4\.99|\$5\.00|of \$5/i);
  });

  it("revokes with deleteKey by default", async () => {
    render(<LlmProviderSetup />);
    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(callsOfType("LLM_REVOKE")).toEqual([
        { type: "LLM_REVOKE", providerId: "preset:openai", deleteKey: true },
      ]),
    );
    await screen.findByRole("button", { name: /^enable/i });
  });

  it("lets the user keep the stored key on revoke", async () => {
    render(<LlmProviderSetup />);
    const keep = await screen.findByRole("checkbox", { name: /delete/i });
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(callsOfType("LLM_REVOKE")).toEqual([
        { type: "LLM_REVOKE", providerId: "preset:openai", deleteKey: false },
      ]),
    );
  });
});
