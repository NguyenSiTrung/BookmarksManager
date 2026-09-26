import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";

/**
 * Shared plumbing for the real-browser e2e specs.
 *
 * The built MV3 extension is loaded into a persistent Chromium context
 * (`channel: "chromium"` — branded Chrome ignores `--load-extension`), the
 * extension id is resolved from the service worker's own URL, and surfaces
 * are opened as ordinary pages at `chrome-extension://<id>/<surface>.html`
 * (Chrome refuses `chrome://` navigation). Extension pages can call
 * `chrome.*` from `page.evaluate`, which is how the specs seed and inspect
 * state — see `./seed.ts`.
 */

/** Built extension root — the specs load this directory. */
export const EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.output/chrome-mv3",
);

if (!existsSync(EXTENSION_DIR)) {
  throw new Error(
    `Built extension not found at ${EXTENSION_DIR} — run \`npm run build\` before the e2e suite.`,
  );
}

/** The surfaces the manifest exposes as extension pages. */
export const SURFACE_PAGES = {
  popup: "popup.html",
  sidepanel: "sidepanel.html",
  options: "options.html",
} as const;

export type Surface = keyof typeof SURFACE_PAGES;

/**
 * Headed is the default because MV3 extension loading historically needs a
 * real window (CI supplies one via `xvfb-run -a`). `E2E_HEADLESS=1` opts into
 * headless for environments whose Chromium supports it.
 */
export function headlessFromEnv(): boolean {
  return process.env.E2E_HEADLESS === "1";
}

export interface LaunchOptions {
  /** Overrides the `E2E_HEADLESS` default. */
  headless?: boolean;
}

/**
 * Launch a fresh persistent context with the built extension loaded. The empty
 * user-data-dir means every launch gets an isolated temporary profile (only
 * Chrome's fixed root folders exist), so specs never share bookmark state.
 */
export async function launchExtensionContext(
  options: LaunchOptions = {},
): Promise<BrowserContext> {
  const headless = options.headless ?? headlessFromEnv();
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });
}

/** A launched context plus its resolved extension id. */
export interface Extension {
  context: BrowserContext;
  id: string;
}

/** Launch the extension and resolve its id in one step. */
export async function startExtension(
  options: LaunchOptions = {},
): Promise<Extension> {
  const context = await launchExtensionContext(options);
  const id = await extensionId(context);
  return { context, id };
}

/**
 * The extension id, resolved from the MV3 service worker's URL. A cold profile
 * can take a while to register the worker, so this waits for the
 * `serviceworker` event when none is present yet.
 */
export async function extensionId(context: BrowserContext): Promise<string> {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }
  return new URL(serviceWorker.url()).host;
}

/**
 * Open one extension surface as a normal page. `chrome://` navigation is
 * refused by Chrome, so surfaces are always addressed as
 * `chrome-extension://<id>/<surface>.html`.
 */
export async function openSurface(
  context: BrowserContext,
  id: string,
  surface: Surface,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/${SURFACE_PAGES[surface]}`);
  return page;
}

/** Live recording of the context's outbound http(s) requests. */
export interface RequestLog {
  /** Outbound http(s) URLs recorded so far, in order. */
  readonly urls: string[];
  /** Detach the listener (call after `context.close()`). */
  stop(): void;
}

/**
 * Record every http(s) request the context issues — page- and
 * service-worker-originated alike. Playwright reports both on the context;
 * `chrome-extension://`, `chrome:`, `about:`, `data:` and `blob:` URLs are
 * internal noise and are filtered out.
 */
export function collectOutboundRequests(context: BrowserContext): RequestLog {
  const urls: string[] = [];
  const listener = (request: Request): void => {
    if (/^https?:\/\//.test(request.url())) urls.push(request.url());
  };
  context.on("request", listener);
  return {
    urls,
    stop: () => {
      context.off("request", listener);
    },
  };
}
