import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Request, Worker } from "@playwright/test";

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
 * The extension's MV3 service worker. A cold profile can take a while to
 * register the worker, so this waits for the `serviceworker` event when none
 * is present yet.
 */
export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  const [existing] = context.serviceWorkers();
  if (existing) return existing;
  return context.waitForEvent("serviceworker");
}

/**
 * The extension id, resolved from the MV3 service worker's URL.
 */
export async function extensionId(context: BrowserContext): Promise<string> {
  const worker = await serviceWorker(context);
  return new URL(worker.url()).host;
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

/**
 * Internal schemes that are NOT egress: they address the extension's own
 * resources, the browser's own UI, or in-memory data. Everything else counts
 * as an outbound request — including `ws://`, `wss://`, `ftp://` and any other
 * scheme, so a non-http leak cannot slip past the assertion.
 */
const INTERNAL_SCHEME = /^(chrome-extension|chrome|devtools|data|blob|about):/;

/** `true` when `url` is an internal, non-egress URL (see {@link INTERNAL_SCHEME}). */
export function isInternalRequestUrl(url: string): boolean {
  return INTERNAL_SCHEME.test(url);
}

/** Live recording of the context's outbound (non-internal) requests. */
export interface RequestLog {
  /** Outbound URLs recorded so far, in order. */
  readonly urls: string[];
  /** Detach the listener (call after `context.close()`). */
  stop(): void;
}

/**
 * Record every request the context issues — page- and
 * service-worker-originated alike — EXCEPT those on an internal scheme
 * ({@link INTERNAL_SCHEME}). Playwright reports both on the context; filtering
 * by exclusion rather than by an `^https?://` allow-list means a `ws://`,
 * `wss://` or `ftp://` request fails the assertion too.
 */
export function collectOutboundRequests(context: BrowserContext): RequestLog {
  const urls: string[] = [];
  const listener = (request: Request): void => {
    const url = request.url();
    if (!isInternalRequestUrl(url)) urls.push(url);
  };
  context.on("request", listener);
  return {
    urls,
    stop: () => {
      context.off("request", listener);
    },
  };
}

/** One context-menu click to replay through the worker (see below). */
export interface ContextMenuClick {
  menuItemId: string;
  pageUrl?: string;
  linkUrl?: string;
  linkText?: string;
}

/**
 * The `chrome` slice the worker-side helpers call. Declared as a narrow local
 * slice (the house pattern the app's own modules follow — `@types/chrome`
 * supplies the namespace but no usable global value binding); the evaluated
 * callbacks are serialized and re-run inside the worker, where the real
 * `chrome` exists.
 */
declare const chrome: {
  contextMenus: {
    onClicked: {
      dispatch?(info: unknown): void;
      hasListeners?(): boolean;
    };
  };
  commands: {
    getAll(): Promise<{ name?: string; shortcut?: string }[]>;
  };
};

/**
 * Drive the extension's context-menu save path inside the MV3 service worker.
 *
 * Chrome offers no way to synthesize a real right-click plus native menu
 * selection from Playwright/CDP, and `chrome.contextMenus.onClicked` is not
 * exposed for scripting — but the event object carries the binding's own
 * `dispatch(info)` entry point, which invokes the listeners the extension
 * registered (`registerContextMenus` in `src/sync/context-menu.ts`) with
 * `info` and no `tab`. That is the real handler, running in the real worker,
 * so this exercises the production click path rather than a re-implementation.
 *
 * `tab` cannot be supplied (the binding dispatches a single argument), so a
 * page click's title falls back to its URL exactly as it does when Chrome
 * reports no tab title; use a link click with `linkText` when a titled
 * bookmark matters.
 *
 * Throws when the worker has no registered listener or the binding does not
 * expose `dispatch`, so the spec can never silently "pass" without exercising
 * anything.
 */
export async function dispatchContextMenuClick(
  context: BrowserContext,
  click: ContextMenuClick,
): Promise<void> {
  const worker = await serviceWorker(context);
  await worker.evaluate((info) => {
    const event = chrome.contextMenus.onClicked as {
      dispatch?: (info: unknown) => void;
      hasListeners?: () => boolean;
    };
    if (typeof event.hasListeners !== "function" || !event.hasListeners()) {
      throw new Error(
        "the extension registered no chrome.contextMenus.onClicked listener",
      );
    }
    if (typeof event.dispatch !== "function") {
      throw new Error(
        "chrome.contextMenus.onClicked.dispatch is unavailable in this Chromium build",
      );
    }
    event.dispatch(info);
  }, click);
}

/**
 * The keyboard shortcut the browser actually resolved for `command`, read
 * from the worker (`chrome.commands.getAll()`). Proves the `_execute_action`
 * binding exists in the running browser, which is what the shortcut opens.
 * `null` when the command is not registered at all.
 */
export async function commandShortcut(
  context: BrowserContext,
  command: string,
): Promise<string | null> {
  const worker = await serviceWorker(context);
  return worker.evaluate(async (name) => {
    const commands = await chrome.commands.getAll();
    const match = commands.find((entry) => entry.name === name);
    return match?.shortcut ?? null;
  }, command);
}
