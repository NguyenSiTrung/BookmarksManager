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
import { ProviderSetup } from "../../src/entrypoints/options/ProviderSetup";
import type {
  ProviderErrorCode,
  ProviderMessageResult,
  ProviderStatus,
} from "../../src/messages/provider";
import type { PresetId } from "../../src/schemas/provider";

/**
 * UI-side coverage for the Options Test connection action (Phase 3 Task 2).
 * An in-memory worker double answers the typed provider protocol; the test
 * result it returns for TEST_PROVIDER is per-test configurable via
 * `testReply`. Mounting Options must never produce a TEST_PROVIDER message —
 * only a click may.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());

const DISABLED: ProviderStatus = { enabled: false, consentGranted: false };
const ENABLED: ProviderStatus = {
  enabled: true,
  consentGranted: true,
  model: "jev-1.13.0",
  keySuffix: "9abc",
};

let sendMessageSpy: ReturnType<typeof vi.fn>;
let requestSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let statusByPreset: Record<PresetId, ProviderStatus>;
let testReply: () => Promise<ProviderMessageResult>;

function workerReply(message: unknown): Promise<ProviderMessageResult> {
  const msg = message as { type: string; preset: PresetId };
  switch (msg.type) {
    case "PROVIDER_STATUS":
      return Promise.resolve({
        ok: true,
        status: { ...statusByPreset[msg.preset] },
      });
    case "TEST_PROVIDER": {
      // Mirror the real worker: a not-fully-enabled preset is refused before
      // transport instead of running a test.
      if (!statusByPreset[msg.preset].enabled) {
        return Promise.resolve({
          ok: false,
          code: "not_enabled",
          message: `Provider "${msg.preset}" is not fully enabled.`,
        });
      }
      return testReply();
    }
    default:
      return Promise.resolve({
        ok: false,
        code: "malformed_message",
        message: "unrecognized message",
      });
  }
}

beforeEach(() => {
  statusByPreset = { typesafe: { ...DISABLED }, openrouter: { ...DISABLED } };
  testReply = () =>
    Promise.resolve({
      ok: true,
      code: "test_ok",
      result: { model: "jev-1.13.0", latencyMs: 37 },
    });
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

/** Every sent message that is not the read-only status lookup. */
function testProviderCalls(): Record<string, unknown>[] {
  return sendMessageSpy.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === "TEST_PROVIDER");
}

async function renderEnabled(
  preset: PresetId = "typesafe",
): Promise<HTMLButtonElement> {
  statusByPreset[preset] = { ...ENABLED };
  render(<ProviderSetup />);
  if (preset !== "typesafe") {
    fireEvent.click(
      await screen.findByRole("radio", {
        name: /openrouter/i,
      }),
    );
  }
  return (await screen.findByRole("button", {
    name: /test connection/i,
  })) as HTMLButtonElement;
}

describe("Test connection visibility and traffic discipline", () => {
  it("shows no Test button while the provider is not enabled", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    expect(screen.queryByRole("button", { name: /test connection/i })).toBeNull();
    expect(testProviderCalls()).toEqual([]);
  });

  it("sends no TEST_PROVIDER on mount — only the status lookup runs", async () => {
    await renderEnabled();
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "PROVIDER_STATUS" }),
      ),
    );
    expect(testProviderCalls()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never auto-tests across remounts (returning to Options)", async () => {
    statusByPreset.typesafe = { ...ENABLED };
    const first = render(<ProviderSetup />);
    fireEvent.click(await screen.findByRole("button", { name: /test connection/i }));
    await screen.findByText(/connection test succeeded/i);
    first.unmount();
    sendMessageSpy.mockClear();

    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /test connection/i });
    // Fresh mount re-checks status only; the previous outcome is not replayed
    // and no new test fires.
    expect(testProviderCalls()).toEqual([]);
    expect(screen.queryByText(/connection test succeeded/i)).toBeNull();
  });

  it("drops the Test button when switching to a disabled preset", async () => {
    await renderEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /openrouter/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /test connection/i }),
      ).toBeNull(),
    );
    expect(testProviderCalls()).toEqual([]);
  });
});

describe("Test connection request", () => {
  it("sends exactly one TEST_PROVIDER naming only the preset", async () => {
    const button = await renderEnabled();
    fireEvent.click(button);
    await screen.findByText(/connection test succeeded/i);
    expect(testProviderCalls()).toEqual([
      { type: "TEST_PROVIDER", preset: "typesafe" },
    ]);
    // The page never picks the model per test and never attaches key material.
    const sent = testProviderCalls()[0] as Record<string, unknown>;
    expect("model" in sent).toBe(false);
    expect("key" in sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("collapses a double click during flight into one request", async () => {
    let resolveTest: ((r: ProviderMessageResult) => void) | undefined;
    testReply = () =>
      new Promise<ProviderMessageResult>((resolve) => {
        resolveTest = resolve;
      });
    const button = await renderEnabled();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(testProviderCalls()).toHaveLength(1));
    resolveTest?.({
      ok: true,
      code: "test_ok",
      result: { model: "jev-1.13.0", latencyMs: 20 },
    });
    await screen.findByText(/connection test succeeded/i);
    expect(testProviderCalls()).toHaveLength(1);
  });

  it("shows a busy state while the test is in flight", async () => {
    let resolveTest: ((r: ProviderMessageResult) => void) | undefined;
    testReply = () =>
      new Promise<ProviderMessageResult>((resolve) => {
        resolveTest = resolve;
      });
    // Same DOM node across re-renders — the label flips to "Testing…" while
    // the request is in flight.
    const button = await renderEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.textContent).toMatch(/testing/i);
    resolveTest?.({
      ok: true,
      code: "test_ok",
      result: { model: "jev-1.13.0", latencyMs: 20 },
    });
    await screen.findByText(/connection test succeeded/i);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toMatch(/test connection/i);
  });
});

describe("Test connection results", () => {
  it("shows the returned model and latency on success", async () => {
    testReply = () =>
      Promise.resolve({
        ok: true,
        code: "test_ok",
        result: { model: "jev-1.13.0", latencyMs: 37 },
      });
    const button = await renderEnabled();
    fireEvent.click(button);
    const text = await screen.findByText(/connection test succeeded/i);
    expect(text.textContent).toContain("jev-1.13.0");
    expect(text.textContent).toContain("37 ms");
    // TypeSafe reports no usage.cost — no cost line is rendered.
    expect(text.textContent).not.toContain("$");
  });

  it("shows the reported cost when the worker returns one", async () => {
    testReply = () =>
      Promise.resolve({
        ok: true,
        code: "test_ok",
        result: { model: "typesafe/jev-1.13", latencyMs: 58, cost: 0.000041 },
      });
    const button = await renderEnabled("openrouter");
    fireEvent.click(button);
    const text = await screen.findByText(/connection test succeeded/i);
    expect(text.textContent).toContain("typesafe/jev-1.13");
    expect(text.textContent).toContain("58 ms");
    expect(text.textContent).toContain("0.000041");
  });

  const failureCases: [ProviderErrorCode, string][] = [
    [
      "auth",
      "The provider rejected the API key (HTTP 401). Check the key and reconnect.",
    ],
    [
      "incompatible",
      "The provider could not process the request (HTTP 422). The gateway may be incompatible with the System One schema.",
    ],
    [
      "retry_later",
      "The provider is rate limiting requests (HTTP 429). Try again later.",
    ],
    ["timeout", "The jev_test request timed out after 10000 ms."],
    [
      "invalid_response",
      "The provider returned a body that is not a valid System One response.",
    ],
    ["not_enabled", 'Provider "typesafe" is not fully enabled.'],
  ];
  it.each(failureCases)(
    "renders the worker's redacted %s failure verbatim",
    async (code, message) => {
      testReply = () => Promise.resolve({ ok: false, code, message });
      const button = await renderEnabled();
      fireEvent.click(button);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(code);
      expect(alert.textContent).toContain(message);
    },
  );

  it("shows a generic error when the worker reply fails schema validation", async () => {
    testReply = () =>
      Promise.resolve({ unexpected: true } as unknown as ProviderMessageResult);
    const button = await renderEnabled();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/unexpected response|went wrong/i);
  });

  it("shows a generic error when the worker message rejects", async () => {
    testReply = () => Promise.reject(new Error("worker crashed"));
    const button = await renderEnabled();
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/went wrong|failed/i);
    // The internal error text is not echoed.
    expect(alert.textContent).not.toContain("worker crashed");
  });
});
