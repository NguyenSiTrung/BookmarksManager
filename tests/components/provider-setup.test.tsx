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
import { PrivacyDraft } from "../../src/entrypoints/options/PrivacyDraft";
import { ProviderSetup } from "../../src/entrypoints/options/ProviderSetup";
import type {
  ProviderMessageResult,
  ProviderStatus,
} from "../../src/messages/provider";
import {
  DEFAULT_PROVIDER_MODEL,
  PRESET_MODELS,
} from "../../src/schemas/provider";

/**
 * jsdom + RTL under Vitest globals-off: the act environment flag and manual
 * cleanup replace the auto-setup RTL only performs when test globals exist.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());

const DISABLED: ProviderStatus = { enabled: false, consentGranted: false };

let requestSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let statusByPreset: Record<string, ProviderStatus>;

/**
 * In-memory worker double: answers the typed provider protocol the way
 * `handleProviderMessage` would, tracking per-preset status across renders so
 * "reload" behavior is exercised through the message boundary.
 */
function workerReply(message: unknown): Promise<ProviderMessageResult> {
  const msg = message as {
    type: string;
    preset: string;
    model?: string;
    key?: string;
  };
  switch (msg.type) {
    case "PROVIDER_STATUS":
      return Promise.resolve({
        ok: true,
        status: { ...(statusByPreset[msg.preset] ?? DISABLED) },
      });
    case "ENABLE_PROVIDER":
      statusByPreset[msg.preset] = {
        enabled: true,
        consentGranted: true,
        model: msg.model,
        keySuffix: (msg.key ?? "").slice(-4),
      };
      return Promise.resolve({
        ok: true,
        status: { ...(statusByPreset[msg.preset] ?? DISABLED) },
      });
    case "REVOKE_PROVIDER":
      statusByPreset[msg.preset] = { ...DISABLED };
      return Promise.resolve({
        ok: true,
        status: { ...(statusByPreset[msg.preset] ?? DISABLED) },
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
  statusByPreset = {
    typesafe: { ...DISABLED },
    openrouter: { ...DISABLED },
    custom: { ...DISABLED },
  };
  requestSpy = vi.fn(async () => true);
  removeSpy = vi.fn(async () => true);
  sendMessageSpy = vi.fn(workerReply);
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("chrome", {
    permissions: { request: requestSpy, remove: removeSpy },
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

function keyInput(): HTMLInputElement {
  return screen.getByLabelText(/api key/i) as HTMLInputElement;
}
function agreeCheckbox(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: /agree/i }) as HTMLInputElement;
}
/**
 * The disclosure read gate (Task 3): the agree checkbox is inert
 * (`aria-disabled`) until the disclosure has been opened once. jsdom does
 * not toggle `<details>` on summary clicks, so flip the DOM attribute and
 * fire `toggle` directly — the same pattern options-primitives uses for
 * Disclosure.
 */
function openDisclosure(): void {
  const details = screen
    .getByRole("region", { name: /data disclosure/i })
    .closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
function enableButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /enable/i }) as HTMLButtonElement;
}
function modelSelect(): HTMLSelectElement {
  // Exact match: the custom-provider card copy mentions "model id" and
  // would otherwise match a loose /model/i query.
  return screen.getByLabelText(/^model$/i) as HTMLSelectElement;
}
function nonStatusCalls(): unknown[] {
  return sendMessageSpy.mock.calls
    .map(([message]) => message as { type: string })
    .filter((message) => message.type !== "PROVIDER_STATUS");
}
async function fillAndAgree() {
  fireEvent.change(await screen.findByLabelText(/api key/i), {
    target: { value: "sk-live-abcdef" },
  });
  openDisclosure();
  fireEvent.click(agreeCheckbox());
  // Enable also waits for the initial status load — allow it to settle.
  await waitFor(() => expect(enableButton().disabled).toBe(false));
}

describe("disclosure", () => {
  it("names the recipient, literal origin, synthetic fields, auth header, purpose, trigger, and privacy links", async () => {
    render(<ProviderSetup />);
    const disclosure = await screen.findByRole("region", {
      name: /data disclosure/i,
    });
    const view = within(disclosure);
    // Recipient and its literal origin (each named in more than one line).
    expect(view.getAllByText(/TypeSafe/).length).toBeGreaterThan(0);
    expect(
      view.getAllByText(/https:\/\/api\.typesafe\.ai/).length,
    ).toBeGreaterThan(0);
    expect(view.getByText("Recipient")).toBeTruthy();
    // The exact synthetic field names.
    expect(view.getByText("model")).toBeTruthy();
    expect(view.getByText("state")).toBeTruthy();
    expect(view.getByText("questions")).toBeTruthy();
    // The key travels only in the Authorization header.
    expect(view.getByText(/Authorization/)).toBeTruthy();
    // Reason and trigger in plain language.
    expect(view.getByText("Why")).toBeTruthy();
    expect(view.getByText("When")).toBeTruthy();
    // Provider privacy-policy link plus the bundled local draft.
    const providerLink = view.getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    // Canonical policy URL — /privacy 308-redirects to /legal/privacy-policy.
    expect(providerLink.href).toBe(
      "https://typesafe.ai/legal/privacy-policy",
    );
    // The draft policy lives in the shell (bundled, zero network) — assert
    // it renders from its own component here.
    cleanup();
    render(<PrivacyDraft />);
    expect(
      screen.getByText(/Privacy Policy — Bookmarks Manager/, {
        selector: "pre",
      }),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swaps the allowlist, pinned default, and disclosure with the provider choice", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    // TypeSafe: only allowlisted models, pinned-release default, no alias warning.
    expect(
      Array.from(modelSelect().options).map((option) => option.value),
    ).toEqual([...PRESET_MODELS.typesafe]);
    expect(modelSelect().value).toBe(DEFAULT_PROVIDER_MODEL.typesafe);
    expect(screen.queryByText(/moving alias/i)).toBeNull();
    // OpenRouter: allowlist, pinned default, and disclosure all switch.
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    // findBy keeps the async status refresh inside act.
    const disclosure = await screen.findByRole("region", {
      name: /data disclosure/i,
    });
    expect(
      within(disclosure).getAllByText(/openrouter\.ai/).length,
    ).toBeGreaterThan(0);
    expect(
      Array.from(modelSelect().options).map((option) => option.value),
    ).toEqual([...PRESET_MODELS.openrouter]);
    expect(modelSelect().value).toBe(DEFAULT_PROVIDER_MODEL.openrouter);
    const link = within(disclosure).getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    expect(link.href).toBe("https://openrouter.ai/privacy");
  });
});

describe("enable flow", () => {
  it("keeps Enable disabled until the unchecked agreement box is checked", async () => {
    render(<ProviderSetup />);
    const enable = await screen.findByRole("button", { name: /enable/i });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    expect(agreeCheckbox().checked).toBe(false);
    fireEvent.click(enable);
    expect(requestSpy).not.toHaveBeenCalled();
    // Entering the key alone is not enough — the box gates the request.
    fireEvent.change(keyInput(), { target: { value: "sk-live-abcdef" } });
    expect(enableButton().disabled).toBe(true);
    openDisclosure();
    fireEvent.click(agreeCheckbox());
    await waitFor(() => expect(enableButton().disabled).toBe(false));
  });

  it("requests the preset host permission once, then sends one ENABLE message", async () => {
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith({
      origins: ["https://api.typesafe.ai/*"],
    });
    await screen.findByRole("button", { name: /revoke/i });
    const calls = nonStatusCalls();
    expect(calls).toEqual([
      {
        type: "ENABLE_PROVIDER",
        preset: "typesafe",
        model: "jev-1.13.0",
        key: "sk-live-abcdef",
      },
    ]);
    // The raw key is dropped from the page: field cleared, never rendered.
    expect(document.body.textContent).not.toContain("sk-live-abcdef");
  });

  it("makes no request and writes nothing when the permission prompt is denied", async () => {
    requestSpy.mockResolvedValue(false);
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    await screen.findByRole("alert");
    expect(requestSpy).toHaveBeenCalledTimes(1);
    // Only the initial PROVIDER_STATUS lookup happened — no enable write.
    expect(nonStatusCalls()).toEqual([]);
    // Still on the setup form, provider not enabled.
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /did not grant|denied|not granted/i,
    );
  });

  it("unwedges and surfaces an error when the permission request throws synchronously", async () => {
    // A synchronous throw is not a promise rejection — without a guard it
    // would leave inFlight/busy stuck and disable every button until reload.
    requestSpy.mockImplementation(() => {
      throw new Error("permissions API unavailable");
    });
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/went wrong/i);
    // No enable message was sent, and the guards reset so the form works.
    expect(nonStatusCalls()).toEqual([]);
    await waitFor(() => expect(enableButton().disabled).toBe(false));
  });

  it("drops an enable result that lands after the provider was switched", async () => {
    let resolveEnable: ((r: ProviderMessageResult) => void) | undefined;
    sendMessageSpy.mockImplementation((message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "ENABLE_PROVIDER") {
        return new Promise<ProviderMessageResult>((resolve) => {
          resolveEnable = resolve;
        });
      }
      return workerReply(message);
    });
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ENABLE_PROVIDER" }),
      ),
    );
    // Switch provider while the enable request is in flight, then let the
    // stale reply land.
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await act(async () => {
      resolveEnable?.({
        ok: true,
        status: {
          enabled: true,
          consentGranted: true,
          model: "jev-latest",
          keySuffix: "cdef",
        },
      });
    });
    // TypeSafe's outcome must not render on the OpenRouter panel: no enabled
    // panel, no "is enabled" notice — OpenRouter shows its own disabled form.
    expect(
      screen.queryByRole("group", { name: /enabled provider/i }),
    ).toBeNull();
    expect(screen.queryByText(/is enabled\./i)).toBeNull();
    expect(screen.getByRole("button", { name: /enable/i })).toBeTruthy();
  });

  it("removes a grant that lands after the preset was switched", async () => {
    // The permission prompt outlives the panel: the user grants TypeSafe's
    // host permission, then switches to OpenRouter before the reply arrives.
    // The abandoned grant must not linger — keeping it would leak a host
    // permission for a provider that was never enabled.
    let resolveRequest: ((granted: boolean) => void) | undefined;
    requestSpy.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    expect(requestSpy).toHaveBeenCalledWith({
      origins: ["https://api.typesafe.ai/*"],
    });
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await act(async () => {
      resolveRequest?.(true);
    });
    await waitFor(() =>
      expect(removeSpy).toHaveBeenCalledWith({
        origins: ["https://api.typesafe.ai/*"],
      }),
    );
    expect(nonStatusCalls()).toEqual([]);
  });

  it("keeps the grant when only the enable reply lands after a switch", async () => {
    // Once ENABLE_PROVIDER persisted the provider, the host permission is
    // required — the stale-reply drop path must not remove it.
    let resolveEnable: ((r: ProviderMessageResult) => void) | undefined;
    sendMessageSpy.mockImplementation((message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "ENABLE_PROVIDER") {
        return new Promise<ProviderMessageResult>((resolve) => {
          resolveEnable = resolve;
        });
      }
      return workerReply(message);
    });
    render(<ProviderSetup />);
    await fillAndAgree();
    fireEvent.click(enableButton());
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ENABLE_PROVIDER" }),
      ),
    );
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await act(async () => {
      resolveEnable?.({
        ok: true,
        status: {
          enabled: true,
          consentGranted: true,
          model: "jev-latest",
          keySuffix: "cdef",
        },
      });
    });
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("never requests permission while the box stays unchecked, even with a key", async () => {
    render(<ProviderSetup />);
    fireEvent.change(await screen.findByLabelText(/api key/i), {
      target: { value: "sk-live-abcdef" },
    });
    fireEvent.click(enableButton());
    expect(requestSpy).not.toHaveBeenCalled();
    expect(nonStatusCalls()).toEqual([]);
  });
});

describe("persisted state and revocation", () => {
  it("restores the selected model and masked suffix on load — and across remounts", async () => {
    statusByPreset.typesafe = {
      enabled: true,
      consentGranted: true,
      model: "jev-1.13.0",
      keySuffix: "9abc",
    };
    const first = render(<ProviderSetup />);
    const panel = await screen.findByRole("group", {
      name: /enabled provider/i,
    });
    expect(panel.textContent).toContain("jev-1.13.0");
    expect(panel.textContent).toContain("9abc");
    expect(document.body.textContent).not.toContain("sk-live");
    // The setup form is replaced, not pre-filled.
    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeTruthy();
    // The persisted view survives a remount (reload).
    first.unmount();
    render(<ProviderSetup />);
    const remounted = await screen.findByRole("group", {
      name: /enabled provider/i,
    });
    expect(remounted.textContent).toContain("jev-1.13.0");
    expect(remounted.textContent).toContain("9abc");
  });

  it("revokes consent and deletes the key by default", async () => {
    statusByPreset.typesafe = {
      enabled: true,
      consentGranted: true,
      model: "jev-latest",
      keySuffix: "cdef",
    };
    render(<ProviderSetup />);
    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(nonStatusCalls()).toEqual([
        { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      ]),
    );
    // The setup form returns once the worker reports the revocation.
    await screen.findByRole("button", { name: /enable/i });
  });

  it("lets the user keep the stored key on revoke", async () => {
    statusByPreset.typesafe = {
      enabled: true,
      consentGranted: true,
      model: "jev-latest",
      keySuffix: "cdef",
    };
    render(<ProviderSetup />);
    const keep = await screen.findByRole("checkbox", { name: /delete/i });
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(nonStatusCalls()).toEqual([
        { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: false },
      ]),
    );
  });

  it("drops a revoke result that lands after the provider was switched", async () => {
    statusByPreset.typesafe = {
      enabled: true,
      consentGranted: true,
      model: "jev-latest",
      keySuffix: "cdef",
    };
    let resolveRevoke: ((r: ProviderMessageResult) => void) | undefined;
    sendMessageSpy.mockImplementation((message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "REVOKE_PROVIDER") {
        return new Promise<ProviderMessageResult>((resolve) => {
          resolveRevoke = resolve;
        });
      }
      return workerReply(message);
    });
    render(<ProviderSetup />);
    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "REVOKE_PROVIDER" }),
      ),
    );
    // Switch provider while the revoke request is in flight, then let the
    // stale reply land.
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await act(async () => {
      resolveRevoke?.({
        ok: true,
        status: { ...DISABLED },
      });
    });
    // TypeSafe's removal notice must not render on the OpenRouter panel,
    // which shows its own disabled form once its status load settles.
    expect(
      screen.queryByText(/consent and browser access were removed/i),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /enable/i })).toBeTruthy();
  });

  it("reopens the enabled custom provider instead of defaulting to TypeSafe", async () => {
    statusByPreset.custom = {
      enabled: true,
      consentGranted: true,
      model: "jev-edge",
      keySuffix: "cdef",
      baseUrl: "https://ai.example.com/api",
      origin: "https://ai.example.com",
    };
    render(<ProviderSetup />);
    const custom = (await screen.findByRole("radio", {
      name: "Custom Jev provider",
    })) as HTMLInputElement;
    await waitFor(() => expect(custom.checked).toBe(true));
    const panel = await screen.findByRole("group", {
      name: /enabled provider/i,
    });
    expect(panel.textContent).toContain("jev-edge");
    expect(panel.textContent).toContain("cdef");
    expect(panel.textContent).toContain("https://ai.example.com");
    expect(
      (screen.getByRole("radio", { name: "TypeSafe" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("selects a configured-but-revoked provider when none is enabled", async () => {
    statusByPreset.custom = {
      enabled: false,
      consentGranted: false,
      model: "jev-edge",
      keySuffix: "cdef",
      baseUrl: "https://ai.example.com/api",
      origin: "https://ai.example.com",
    };
    render(<ProviderSetup />);
    const custom = (await screen.findByRole("radio", {
      name: "Custom Jev provider",
    })) as HTMLInputElement;
    await waitFor(() => expect(custom.checked).toBe(true));
    // Not enabled — the custom setup form renders, not the enabled view.
    expect(await screen.findByLabelText(/^base url$/i)).toBeTruthy();
  });
});

describe("model alias warning", () => {
  it("warns under the picker for moving aliases, never for pinned ids, on both presets", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    // The picker defaults to the pinned release id — the warning appears
    // once a moving alias is selected.
    fireEvent.change(modelSelect(), { target: { value: "jev-latest" } });
    const warning = await screen.findByText(/moving alias/i);
    expect(warning.getAttribute("role")).toBe("status");
    // The warning names the selected model and is programmatically
    // associated with the picker via aria-describedby.
    expect(warning.textContent).toContain("jev-latest");
    expect(warning.id).toBeTruthy();
    expect(modelSelect().getAttribute("aria-describedby")).toBe(warning.id);
    // The jev-preview moving alias warns the same way.
    fireEvent.change(modelSelect(), { target: { value: "jev-preview" } });
    const preview = await screen.findByText(/moving alias/i);
    expect(preview.textContent).toContain("jev-preview");
    expect(modelSelect().getAttribute("aria-describedby")).toBe(preview.id);
    // The pinned version id shows the pinned note instead.
    fireEvent.change(modelSelect(), { target: { value: "jev-1.13.0" } });
    expect(screen.queryByText(/moving alias/i)).toBeNull();
    expect(modelSelect().getAttribute("aria-describedby")).toBe(
      "provider-model-pinned-note",
    );
    // OpenRouter: same rule — moving alias warns, pinned ids don't.
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await screen.findByRole("region", { name: /data disclosure/i });
    fireEvent.change(modelSelect(), { target: { value: "jev-latest" } });
    const orWarning = await screen.findByText(/moving alias/i);
    expect(orWarning.textContent).toContain("jev-latest");
    for (const pinned of ["jev-1.13", "typesafe/jev-1.13"]) {
      fireEvent.change(modelSelect(), { target: { value: pinned } });
      expect(screen.queryByText(/moving alias/i)).toBeNull();
      // Pinned release ids show the pinned note; other pinned ids none.
      const expected =
        pinned === "typesafe/jev-1.13"
          ? "provider-model-pinned-note"
          : null;
      expect(modelSelect().getAttribute("aria-describedby")).toBe(expected);
    }
    // Read-only interaction — still no TEST_PROVIDER traffic.
    expect(nonStatusCalls()).toEqual([]);
  });
});

describe("provider data notes and privacy link", () => {
  it("renders each preset's data note verbatim and opens its privacy link safely in a new tab", async () => {
    render(<ProviderSetup />);
    const tsDisclosure = await screen.findByRole("region", {
      name: /typesafe data disclosure/i,
    });
    const tsView = within(tsDisclosure);
    // The §8.5 step-7 provider data note is rendered verbatim.
    expect(
      tsView.getByText(/not trained on customer requests/i),
    ).toBeTruthy();
    const tsLink = tsView.getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    // Canonical URL verified at implementation time (/privacy 308-redirects
    // to /legal/privacy-policy).
    expect(tsLink.href).toBe("https://typesafe.ai/legal/privacy-policy");
    expect(tsLink.target).toBe("_blank");
    expect(tsLink.rel).toContain("noopener");
    expect(tsLink.rel).toContain("noreferrer");
    // OpenRouter's note and link replace TypeSafe's on switch.
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    const orDisclosure = await screen.findByRole("region", {
      name: /openrouter data disclosure/i,
    });
    const orView = within(orDisclosure);
    expect(
      orView.getByText(/forwards Jev requests to TypeSafe/i),
    ).toBeTruthy();
    const orLink = orView.getByRole("link", {
      name: /privacy policy/i,
    }) as HTMLAnchorElement;
    expect(orLink.href).toBe("https://openrouter.ai/privacy");
    expect(orLink.target).toBe("_blank");
    expect(orLink.rel).toContain("noopener");
    expect(orLink.rel).toContain("noreferrer");
  });

  it("shows the custom disclosure — resolved origin, no privacy-policy link", async () => {
    render(<ProviderSetup />);
    fireEvent.click(
      await screen.findByRole("radio", { name: "Custom Jev provider" }),
    );
    fireEvent.change(await screen.findByLabelText(/^base url$/i), {
      target: { value: "https://ai.example.com/api" },
    });
    const disclosure = await screen.findByRole("region", {
      name: /custom jev provider data disclosure/i,
    });
    const view = within(disclosure);
    expect(
      view.getAllByText(/ai\.example\.com/).length,
    ).toBeGreaterThan(0);
    expect(
      view.getByText(/not reviewed by this extension/i),
    ).toBeTruthy();
    // A custom endpoint has no curated policy link to render.
    expect(view.queryByRole("link")).toBeNull();
  });
});

describe("custom provider enable", () => {
  it("collects base URL + model id, requests the computed origin pattern, and sends both in ENABLE", async () => {
    render(<ProviderSetup />);
    fireEvent.click(
      await screen.findByRole("radio", { name: "Custom Jev provider" }),
    );
    fireEvent.change(await screen.findByLabelText(/^base url$/i), {
      target: { value: "https://ai.example.com/api" },
    });
    fireEvent.change(screen.getByLabelText(/^model id$/i), {
      target: { value: "jev-edge" },
    });
    await fillAndAgree();
    fireEvent.click(enableButton());
    // The requested permission is the origin pattern computed from the
    // typed base URL — not a preset's fixed pattern.
    await waitFor(() =>
      expect(requestSpy).toHaveBeenCalledWith({
        origins: ["https://ai.example.com/*"],
      }),
    );
    const enableCall = sendMessageSpy.mock.calls
      .map(([message]) => message as { type: string })
      .find((message) => message.type === "ENABLE_PROVIDER");
    expect(enableCall).toMatchObject({
      preset: "custom",
      baseUrl: "https://ai.example.com/api",
      model: "jev-edge",
      key: "sk-live-abcdef",
    });
  });

  it("keeps Enable disabled until the base URL parses and the model id is non-empty", async () => {
    render(<ProviderSetup />);
    fireEvent.click(
      await screen.findByRole("radio", { name: "Custom Jev provider" }),
    );
    fireEvent.change(await screen.findByLabelText(/api key/i), {
      target: { value: "sk-live-abcdef" },
    });
    openDisclosure();
    fireEvent.click(agreeCheckbox());
    // Wait for the status probe to settle — key + agreement alone are not
    // enough while the endpoint fields are empty.
    await waitFor(() =>
      expect(
        sendMessageSpy.mock.calls.some(
          ([message]) =>
            (message as { type: string }).type === "PROVIDER_STATUS",
        ),
      ).toBe(true),
    );
    expect(enableButton().disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText(/^base url$/i), {
      target: { value: "https://ai.example.com/api" },
    });
    fireEvent.change(screen.getByLabelText(/^model id$/i), {
      target: { value: "jev-edge" },
    });
    await waitFor(() => expect(enableButton().disabled).toBe(false));
  });
});

describe("disclosure read gate", () => {
  it("opens and reveals the disclosure instead of agreeing on an early click", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    const box = agreeCheckbox();
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
    fireEvent.click(agreeCheckbox());
    await waitFor(() => expect(agreeCheckbox().checked).toBe(true));
  });

  it("re-arms the gate when the provider preset changes", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    openDisclosure();
    await waitFor(() =>
      expect(agreeCheckbox().getAttribute("aria-disabled")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await waitFor(() =>
      expect(agreeCheckbox().getAttribute("aria-disabled")).toBe("true"),
    );
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() =>
      expect(agreeCheckbox().getAttribute("aria-disabled")).toBeNull(),
    );
  });
});
