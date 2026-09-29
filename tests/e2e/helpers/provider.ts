import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";
import type { ConsentRecord } from "../../../src/schemas/provider";
import type { SentLogEntry } from "../../../src/db/database";
import type { SystemOneResponse } from "../../../src/jev/wire";
import { PRESETS } from "../../../src/net/presets";
import { DB_NAME } from "./db";
import {
  EXTENSION_DIR,
  extensionId,
  headlessFromEnv,
} from "./extension";
import type { LaunchOptions } from "./extension";
import { openOptionsPanel } from "./surfaces";

/**
 * Provider-setup e2e plumbing (Phase 4 Task 2): a scriptable Playwright route
 * standing in for the TypeSafe System One endpoint, a launch helper whose
 * manifest variant grants the host permission at install time, a Chrome
 * messaging bridge for the provider protocol, and non-creating IndexedDB
 * readers for the provider tables.
 *
 * Two Playwright/Chromium realities shape this module (verified empirically
 * against the Playwright-bundled Chromium build):
 *
 * 1. `browserContext.route()` DOES intercept `fetch` issued by the extension's
 *    MV3 service worker — the routed fake answers the real gate's real fetch,
 *    so the consented-send path in `src/net/send.ts` runs end to end.
 * 2. `chrome.permissions.request()` NEVER resolves under Playwright's
 *    Chromium — headed under xvfb or headless, real click or CDP
 *    `Runtime.evaluate` with `userGesture: true`: the promise pends forever
 *    and no prompt window ever appears, so the real Enable click cannot get
 *    past the browser's own dialog. CDP `Browser.grantPermissions` only
 *    covers web permission types (geolocation, notifications, …), not
 *    extension host permissions.
 *
 * The workaround that keeps the click path REAL: copy `.output/chrome-mv3`
 * into a temp dir and promote the TypeSafe pattern from
 * `optional_host_permissions` to `host_permissions`, which Chrome grants
 * silently at install. The unchanged production click handler then calls
 * `chrome.permissions.request`, which resolves `true` immediately for an
 * already-held permission (no prompt needed), and the worker's own
 * `permissions.contains` re-check in `enableProvider` still passes for real.
 * The only production behavior not exercised is the native prompt widget —
 * which belongs to the browser, not the extension.
 */

/** A persistent context running a manifest-patched copy of the extension. */
export interface ProviderExtension {
  context: BrowserContext;
  id: string;
  /** Remove the patched extension directory (call after context.close()). */
  dispose(): void;
}

export interface ProviderLaunchOptions extends LaunchOptions {
  /**
   * Launch on this persistent profile directory instead of a Playwright
   * temp profile. The directory SURVIVES `context.close()`, so a second
   * launch on the same path restores the extension's IndexedDB (provider
   * settings, consents, job rows) and the Chrome profile's bookmarks — how
   * the decisions specs restart the browser mid-job. When set, the TypeSafe
   * and OpenRouter origins are also mapped to an unroutable local address
   * via `--host-resolver-rules`: a relaunched worker may boot and resume a
   * job before the spec has registered its route, and a real DNS attempt
   * would be genuine egress. The sink turns any pre-route attempt into an
   * instant connection refusal, which the client classifies as a retryable
   * transport error — its retries then land on the route (routes intercept
   * before the resolver once registered).
   */
  profileDir?: string;
  /**
   * Reuse this directory as the patched-extension root across launches. The
   * unpacked extension id derives from the load path, so a relaunch from the
   * same root keeps the SAME extension id. The caller owns the directory's
   * lifetime (`dispose()` will not remove it).
   */
  extensionRoot?: string;
  /**
   * Add the `"tabs"` permission to the patched manifest copy. The shipped
   * build never holds it: production prefills the quick-save popup from the
   * active tab via `activeTab`, which Playwright cannot grant (it needs a
   * real action-icon click). The popup-prefill spec grants the equivalent
   * tab visibility on its throwaway copy only — every later step (the
   * `SAVE_SUGGEST` message, the worker's own consent/permission re-checks,
   * the egress gate) runs unchanged.
   */
  grantTabsPermission?: boolean;
}

/**
 * Copy the built extension into a fresh temp dir with the TypeSafe host
 * pattern moved from `optional_host_permissions` to `host_permissions`, then
 * launch it in a persistent context. The unpacked extension id is derived
 * from the load path, so it differs from a stock-build launch — always use
 * the returned `id`.
 */
export async function launchProviderExtension(
  options: ProviderLaunchOptions = {},
): Promise<ProviderExtension> {
  const callerRoot = options.extensionRoot;
  const root =
    callerRoot ?? mkdtempSync(path.join(tmpdir(), "bm-e2e-provider-"));
  try {
    // `cpSync` nests the source when the destination is a non-empty
    // directory, so a reused root is populated exactly once — the copied
    // manifest doubles as the "copy complete" marker.
    if (!existsSync(path.join(root, "manifest.json"))) {
      cpSync(EXTENSION_DIR, root, { recursive: true });
    }
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      permissions?: string[];
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };
    manifest.host_permissions = [
      ...(manifest.host_permissions ?? []),
      PRESETS.typesafe.permissionPattern,
    ];
    if (options.grantTabsPermission === true) {
      manifest.permissions = [...(manifest.permissions ?? []), "tabs"];
    }
    manifest.optional_host_permissions = (
      manifest.optional_host_permissions ?? []
    ).filter((pattern) => pattern !== PRESETS.typesafe.permissionPattern);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const context = await chromium.launchPersistentContext(
      options.profileDir ?? "",
      {
        channel: "chromium",
        headless: options.headless ?? headlessFromEnv(),
        args: [
          `--disable-extensions-except=${root}`,
          `--load-extension=${root}`,
          ...(options.profileDir === undefined
            ? []
            : [
                // See ProviderLaunchOptions.profileDir: a pre-route resume
                // attempt must fail instantly and locally, never reach the
                // network.
                `--host-resolver-rules=MAP ${new URL(
                  PRESETS.typesafe.origin,
                ).host} 127.0.0.1, MAP ${new URL(PRESETS.openrouter.origin).host} 127.0.0.1`,
              ]),
        ],
      },
    );
    const id = await extensionId(context);
    return {
      context,
      id,
      dispose: () => {
        if (callerRoot === undefined) {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (cause) {
    if (callerRoot === undefined) {
      rmSync(root, { recursive: true, force: true });
    }
    throw cause;
  }
}

/** One request observed at the routed fake endpoint. */
export interface CapturedProviderRequest {
  readonly method: string;
  readonly url: string;
  /** Header names lowercased for case-insensitive lookup. */
  readonly headers: Record<string, string>;
  /** JSON-parsed request body, the raw string when not JSON, or undefined. */
  readonly postData: unknown;
}

/** Live log of requests observed at the routed provider endpoint. */
export interface ProviderRouteLog {
  readonly requests: CapturedProviderRequest[];
}

export function captureRequest(request: Request): CapturedProviderRequest {
  const raw = request.postData();
  let postData: unknown;
  if (raw !== null) {
    try {
      postData = JSON.parse(raw);
    } catch {
      postData = raw;
    }
  }
  return {
    method: request.method(),
    url: request.url(),
    headers: Object.fromEntries(
      Object.entries(request.headers()).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    ),
    postData,
  };
}

/** Scriptable fields of the fake endpoint's `SystemOneResponse`. */
export interface FakeProviderReply {
  /** Versioned model id the fake claims answered; default "jev-1.13.0". */
  model?: string;
  /** `usage.cost` to report — the spec scripts this to cover the UI's cost branch. */
  cost?: number;
}

/**
 * Route every request to the TypeSafe origin (`context.route` intercepts the
 * service worker's `fetch`, not just page requests) and answer with a
 * schema-valid `SystemOneResponse`: a `noul` answer for the synthetic
 * `test` question and deterministic usage numbers. Returns the live capture
 * log — the spec asserts on its exact contents.
 */
export async function routeFakeTypesafe(
  context: BrowserContext,
  reply: FakeProviderReply = {},
): Promise<ProviderRouteLog> {
  const requests: CapturedProviderRequest[] = [];
  await context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
    requests.push(captureRequest(route.request()));
    const usage: SystemOneResponse["usage"] = {
      input_tokens: 128,
      output_tokens: 8,
      ...(reply.cost !== undefined ? { cost: reply.cost } : {}),
    };
    const body: SystemOneResponse = {
      model: reply.model ?? "jev-1.13.0",
      answers: { test: { type: "noul", noul: 1 } },
      usage,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return { requests };
}

/**
 * Route the TypeSafe origin to a RECORDING BLACK HOLE: every attempted
 * request is captured and aborted, so a privacy regression can neither
 * escape to the network nor go unnoticed. The "no consent" leg asserts the
 * returned log stays empty.
 */
export async function abortProviderRequests(
  context: BrowserContext,
): Promise<ProviderRouteLog> {
  const requests: CapturedProviderRequest[] = [];
  await context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
    requests.push(captureRequest(route.request()));
    await route.abort();
  });
  return { requests };
}

/**
 * The `chrome` slice the provider helpers call from inside extension pages.
 * Same house pattern as `src/`: only the used surface is declared; the
 * evaluated callback runs where the real `chrome` exists.
 */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

/**
 * Send one provider-protocol message from an extension page and return the
 * worker's raw reply. The reply path is trusted only when `sender.url` is
 * the built `options.html`, so callers must evaluate this from the Options
 * page — that is also what makes it the real production entry point.
 */
export async function sendProviderMessage(
  page: Page,
  message: unknown,
): Promise<unknown> {
  return page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
}

/** Wait for the Options provider panel's initial PROVIDER_STATUS round trip. */
export async function waitForProviderStatus(page: Page): Promise<void> {
  await expect(
    page.getByText("Checking the current provider status"),
  ).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Drive the real enable flow on the Options page: pick the model, fill the
 * API key, check the affirmative-consent box, click Enable, and wait for the
 * enabled panel — the synchronous `chrome.permissions.request` resolves
 * immediately on the install-time grant (see module doc), so this exercises
 * the unchanged production click handler and the worker's own re-verification.
 *
 * The form lives in the Connections panel, so the helper selects that panel
 * first — the shell mounts all four panels with only the active one visible.
 */
export async function enableTypesafe(
  page: Page,
  details: { key: string; model?: string },
): Promise<void> {
  await openOptionsPanel(page, "Connections");
  await waitForProviderStatus(page);
  // Scope to the Jev section — Options also hosts the LLM provider form,
  // whose "Model"/"API key"/consent labels collide with these.
  const region = page.getByRole("region", { name: "AI provider connection" });
  if (details.model !== undefined) {
    await region.getByLabel("Model").selectOption(details.model);
  }
  await region.getByLabel("API key").fill(details.key);
  // Task 3 read gate: the agree checkbox is disabled until the disclosure
  // has been opened once — click its summary first.
  await region
    .locator("summary", { hasText: "What enabling TypeSafe means" })
    .click();
  await region.getByLabel(/agree to enable/).check();
  const enable = region.getByRole("button", { name: "Enable TypeSafe" });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(
    page.getByRole("group", { name: "TypeSafe enabled provider" }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Non-creating `getAll` over one object store of the extension's IndexedDB —
 * the same contract as `./db.ts`: returns `[]` without opening the database
 * when it does not exist, so reads never create a stray empty database.
 * Exported for the decisions specs, which read the `decisions`,
 * `bookmarkMeta`, and `jobs` stores the same way this module reads the
 * provider tables.
 */
export async function readStoreRows<Row>(page: Page, store: string): Promise<Row[]> {
  return page.evaluate(
    async ({ dbName, storeName }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((info) => info.name === dbName)) return [];
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        if (!database.objectStoreNames.contains(storeName)) return [];
        return await new Promise<Row[]>((resolve, reject) => {
          const transaction = database.transaction(storeName, "readonly");
          const getAll = transaction.objectStore(storeName).getAll();
          getAll.onsuccess = () => resolve(getAll.result as Row[]);
          getAll.onerror = () => reject(getAll.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, storeName: store },
  );
}

/**
 * Every `sentLog` audit row — the gate appends one row per request that
 * actually left the device (`src/net/send.ts`). The spec's "exactly one row"
 * assertion reads the real table the real worker wrote.
 */
export async function sentLogRows(page: Page): Promise<SentLogEntry[]> {
  return readStoreRows<SentLogEntry>(page, "sentLog");
}

/** Every consent record, keyed `[scope+origin]` — what Enable persists. */
export async function consentRows(page: Page): Promise<ConsentRecord[]> {
  return readStoreRows<ConsentRecord>(page, "consents");
}
