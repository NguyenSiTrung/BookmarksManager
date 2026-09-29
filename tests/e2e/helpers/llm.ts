import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { PRESETS } from "../../../src/net/presets";
import {
  EXTENSION_DIR,
  extensionId,
  headlessFromEnv,
} from "./extension";
import type { LaunchOptions } from "./extension";
import { captureRequest } from "./provider";
import type { CapturedProviderRequest } from "./provider";
import { openOptionsPanel } from "./surfaces";

/**
 * LLM e2e plumbing (Phase 6 Task 1): a launch helper whose manifest variant
 * grants BOTH the TypeSafe and OpenAI host patterns at install time (the
 * `chrome.permissions.request` prompt never resolves under Playwright —
 * the provider.ts module doc has the full story), a scriptable Playwright
 * route standing in for the OpenAI-compatible endpoint, and the Options
 * enable flow for the LLM provider.
 *
 * Every LLM-path production check still runs: the worker's own
 * `permissions.contains` re-checks pass on the install-time grant, the
 * egress gate, consent records, budget accounting, and the sentLog audit
 * write are all real — only the wire after Chromium's network stack is
 * faked (Playwright DOES intercept MV3 service-worker fetches).
 */

/** The OpenAI preset's exact egress origin. */
export const OPENAI_ORIGIN = "https://api.openai.com";

/** Extra host patterns a spec can grant at install time (e.g. the routed
 *  fixture page for summary extraction). */
export interface LlmLaunchOptions extends LaunchOptions {
  extraHostPatterns?: readonly string[];
  /** Same contract as ProviderLaunchOptions.profileDir — a surviving
   *  profile so a relaunch restores IndexedDB (jobs, consents) mid-run. */
  profileDir?: string;
  /** Reused patched-extension root — same extension id across relaunches. */
  extensionRoot?: string;
}

export interface LlmExtension {
  context: BrowserContext;
  id: string;
  dispose(): void;
}

/**
 * Copy the built extension into a temp dir with the TypeSafe + OpenAI host
 * patterns promoted to `host_permissions` (plus any `extraHostPatterns`),
 * then launch it in a persistent context.
 */
export async function launchLlmExtension(
  options: LlmLaunchOptions = {},
): Promise<LlmExtension> {
  const root =
    options.extensionRoot ?? mkdtempSync(path.join(tmpdir(), "bm-e2e-llm-"));
  try {
    if (!existsSync(path.join(root, "manifest.json"))) {
      cpSync(EXTENSION_DIR, root, { recursive: true });
    }
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };
    const promoted = [
      PRESETS.typesafe.permissionPattern,
      `${OPENAI_ORIGIN}/*`,
      ...(options.extraHostPatterns ?? []),
    ];
    manifest.host_permissions = [
      ...(manifest.host_permissions ?? []),
      ...promoted,
    ];
    manifest.optional_host_permissions = (
      manifest.optional_host_permissions ?? []
    ).filter((pattern) => !promoted.includes(pattern));
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const context = await (
      await import("@playwright/test")
    ).chromium.launchPersistentContext(options.profileDir ?? "", {
      headless: headlessFromEnv(),
      channel: "chromium",
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
      ],
    });
    return {
      context,
      id: await extensionId(context),
      dispose: () => {
        if (options.extensionRoot === undefined) rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (options.extensionRoot === undefined) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Live log of requests observed at the routed OpenAI endpoint. */
export interface LlmRouteLog {
  readonly requests: CapturedProviderRequest[];
}

/** Scripted reply shape: `content` is the assistant message body. */
export interface FakeOpenAiReply {
  /** Assistant message content — JSON string for structured tiers. */
  content?: string;
  /** Model id the fake claims answered; default "gpt-4o-mini-2024-07-18". */
  model?: string;
  /** Reported token usage. */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** HTTP status — 4xx/5xx exercises the error path. */
  status?: number;
}

/**
 * Route every request to the OpenAI origin and answer with a schema-valid
 * chat.completions response. `reply` may be a constant or a per-request
 * callback (receives the parsed request body + 1-based call index).
 */
export async function routeFakeOpenAi(
  context: BrowserContext,
  reply: FakeOpenAiReply | ((body: unknown, call: number) => FakeOpenAiReply) = {},
  origin: string = OPENAI_ORIGIN,
): Promise<LlmRouteLog> {
  const requests: CapturedProviderRequest[] = [];
  await context.route(`${origin}/**`, async (route) => {
    requests.push(captureRequest(route.request()));
    const scripted =
      typeof reply === "function" ? reply(route.request().postDataJSON(), requests.length) : reply;
    const body = {
      id: `chatcmpl-e2e-${requests.length}`,
      object: "chat.completion",
      created: 1_700_000_000,
      model: scripted.model ?? "gpt-4o-mini-2024-07-18",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: scripted.content ?? "{}",
          },
          finish_reason: "stop",
        },
      ],
      usage: scripted.usage ?? { prompt_tokens: 40, completion_tokens: 12 },
    };
    await route.fulfill({
      status: scripted.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return { requests };
}

/**
 * Route the OpenAI origin to a RECORDING BLACK HOLE — every attempt is
 * captured and aborted so a privacy regression can neither escape nor go
 * unnoticed.
 */
export async function abortLlmRequests(
  context: BrowserContext,
): Promise<LlmRouteLog> {
  const requests: CapturedProviderRequest[] = [];
  await context.route(`${OPENAI_ORIGIN}/**`, async (route) => {
    requests.push(captureRequest(route.request()));
    await route.abort();
  });
  return { requests };
}

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

/** Send one message from an extension page; returns the raw worker reply. */
export async function sendLlmMessage(
  page: Page,
  message: unknown,
): Promise<unknown> {
  return page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
}

/**
 * Drive the real Options custom-endpoint enable flow, including the optional
 * per-million-token pricing fields (shared by both provider branches: a
 * preset pre-fills nothing, its default model is priced by the built-in
 * table). `baseUrl` must be canonical HTTPS (or loopback HTTP) and its origin
 * pattern must already be install-time granted via `extraHostPatterns`. The
 * form lives in the Connections panel, so the helper selects that panel
 * first.
 */
export async function enableCustom(
  page: Page,
  details: {
    baseUrl: string;
    key: string;
    model?: string;
    budgetCap?: string;
    inputPrice?: string;
    outputPrice?: string;
  },
): Promise<void> {
  await openOptionsPanel(page, "Connections");
  await expect(
    page.getByText("Checking the current provider status"),
  ).toHaveCount(0, { timeout: 15_000 });
  // The redesigned provider cards hide the native radio (`sr-only`) inside a
  // wrapping label, so a direct `check()` can never receive the pointer
  // events — click the card's visible title and let the label forward
  // activation to the input.
  const llm = page.getByRole("region", { name: "Optional LLM provider" });
  const customRadio = llm.getByRole("radio", {
    name: "Custom OpenAI-compatible endpoint",
  });
  await llm
    .getByText("Custom OpenAI-compatible endpoint", { exact: true })
    .click();
  await expect(customRadio).toBeChecked();
  await page.locator("#llm-base-url").fill(details.baseUrl);
  if (details.model !== undefined) {
    await page.locator("#llm-model").fill(details.model);
  }
  if (details.budgetCap !== undefined) {
    await page.locator("#llm-budget-cap").fill(details.budgetCap);
  }
  if (details.inputPrice !== undefined) {
    await page.locator("#llm-input-price").fill(details.inputPrice);
  }
  if (details.outputPrice !== undefined) {
    await page.locator("#llm-output-price").fill(details.outputPrice);
  }
  await page.locator("#llm-api-key").fill(details.key);
  // Task 3 read gate: open the disclosure before the agree checkbox. The
  // section has a single disclosure regardless of provider kind.
  await llm
    .locator("summary", { hasText: "What enabling an LLM provider means" })
    .click();
  await page
    .getByLabel(/agree to enable this LLM provider/)
    .check();
  const enable = page.getByRole("button", { name: "Enable LLM provider" });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(
    page.getByRole("group", { name: "LLM enabled provider" }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Drive the real Options LLM enable flow: OpenAI preset is the default
 * radio, fill model + key, check the affirmative-consent box, click Enable —
 * `chrome.permissions.request` resolves immediately on the install-time
 * grant, so the unchanged production handler runs end to end. The form lives
 * in the Connections panel, so the helper selects that panel first.
 */
export async function enableOpenAi(
  page: Page,
  details: {
    key: string;
    model?: string;
    budgetCap?: string;
    /** Pick the explicit "no monthly cap" ceiling instead of a cap. */
    budgetUnlimited?: boolean;
  },
): Promise<void> {
  await openOptionsPanel(page, "Connections");
  await expect(
    page.getByText("Checking the current provider status"),
  ).toHaveCount(0, { timeout: 15_000 });
  // The Jev provider select is also labelled "Model" — scope to the LLM ids.
  if (details.model !== undefined) {
    await page.locator("#llm-model").fill(details.model);
  }
  if (details.budgetCap !== undefined) {
    await page.locator("#llm-budget-cap").fill(details.budgetCap);
  }
  if (details.budgetUnlimited === true) {
    await page
      .getByLabel(/no monthly cap — spend without a limit/i)
      .check();
  }
  await page.locator("#llm-api-key").fill(details.key);
  // Task 3 read gate: open the disclosure before the agree checkbox.
  await page
    .getByRole("region", { name: "Optional LLM provider" })
    .locator("summary", { hasText: "What enabling an LLM provider means" })
    .click();
  await page
    .getByLabel(/agree to enable this LLM provider/)
    .check();
  const enable = page.getByRole("button", { name: "Enable LLM provider" });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(
    page.getByRole("group", { name: "LLM enabled provider" }),
  ).toBeVisible({ timeout: 15_000 });
}
