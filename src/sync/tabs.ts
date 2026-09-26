import { isOpenableUrl } from "../search/openable";

/**
 * Minimal typed `chrome.tabs` slice for opening bookmark URLs — the shared
 * open path behind search results on every surface (side panel, command
 * palette, popup, `bm` omnibox; spec §5–§7).
 *
 * House lazy-slice pattern (see `src/sync/chrome-bookmarks.ts` and
 * `src/entrypoints/popup/chrome.ts`): `chrome` is declared per module and
 * resolved lazily at call time so `vi.stubGlobal` works in tests. Access
 * throws SYNCHRONOUSLY when the surface is absent (a `ReferenceError` on a
 * bare `chrome` reference, a `TypeError` on a missing member) — every
 * access below sits inside `tabsApi()`'s or {@link openBookmarkUrl}'s
 * try/catch, so the helper is total: all outcomes are typed
 * `{ok:true} | {ok:false, code, message}` results and nothing crosses the
 * boundary as a throw.
 *
 * Scope: only the two calls the open actions need — `tabs.create` for new
 * tabs and the no-tabId `tabs.update(updateProperties)` overload, which
 * retargets the active tab of the current window (the right target for
 * popup and omnibox "current" opens). `tabs.query`, events, and
 * tabId-addressed updates are deliberately out of this slice. Neither call
 * requires the `tabs` permission.
 */

/** Properties accepted by `chrome.tabs.create` on the open path. */
export interface TabCreateProperties {
  url?: string;
  /** Chrome defaults to `true` — `false` opens in the background. */
  active?: boolean;
}

/** Properties accepted by `chrome.tabs.update` on the open path. */
export interface TabUpdateProperties {
  url?: string;
}

/** The subset of `chrome.tabs.Tab` the open calls resolve to. */
export interface ChromeTab {
  id?: number;
  windowId?: number;
  url?: string;
}

/**
 * The `chrome.tabs` members this module uses. Both are optional so a
 * PARTIAL surface (a `tabs` namespace missing one method) is
 * representable and detected at call time instead of crashing on a
 * `TypeError` — though such a throw is caught anyway.
 */
export interface ChromeTabsApi {
  create(createProperties: TabCreateProperties): Promise<ChromeTab>;
  update(
    updateProperties: TabUpdateProperties,
  ): Promise<ChromeTab | undefined>;
}

declare const chrome: { tabs?: Partial<ChromeTabsApi> | null };

/** Where an open action lands; mirrors the three omnibox dispositions. */
export type OpenUrlDisposition = "current" | "foreground" | "background";

export type OpenUrlErrorCode =
  /** The URL failed {@link isOpenableUrl} (`javascript:`/`data:`/blank). */
  | "not_openable"
  /** `chrome.tabs`, or the method the disposition needs, is unavailable. */
  | "unavailable"
  /** The tabs call itself threw or rejected. */
  | "api";

export interface OpenUrlFailure {
  ok: false;
  code: OpenUrlErrorCode;
  message: string;
}

export interface OpenUrlSuccess {
  ok: true;
}

export type OpenUrlResult = OpenUrlSuccess | OpenUrlFailure;

function failure(code: OpenUrlErrorCode, message: string): OpenUrlFailure {
  return { ok: false, code, message };
}

/** `chrome.tabs`, or `null` when the namespace is absent in this context. */
function tabsApi(): Partial<ChromeTabsApi> | null {
  try {
    return chrome.tabs ?? null;
  } catch {
    return null;
  }
}

/**
 * Open `url` per `disposition`:
 *
 * - `"current"` — `tabs.update({url})`, retargeting the active tab;
 * - `"foreground"` — `tabs.create({url, active:true})`;
 * - `"background"` — `tabs.create({url, active:false})`.
 *
 * Total — the returned promise never rejects. An unopenable URL is refused
 * (`not_openable`) BEFORE `chrome` is touched, an absent or partial
 * `chrome.tabs` surface reports `unavailable`, and a throwing/rejecting
 * tabs call reports `api` with its message.
 */
export async function openBookmarkUrl(
  url: string,
  disposition: OpenUrlDisposition,
): Promise<OpenUrlResult> {
  if (!isOpenableUrl(url)) {
    return failure(
      "not_openable",
      "This bookmark's URL cannot be opened in a tab.",
    );
  }

  const tabs = tabsApi();
  if (tabs === null) {
    return failure(
      "unavailable",
      "chrome.tabs is not available in this context.",
    );
  }

  try {
    if (disposition === "current") {
      if (typeof tabs.update !== "function") {
        return failure(
          "unavailable",
          "chrome.tabs.update is not available in this context.",
        );
      }
      await tabs.update({ url });
    } else {
      if (typeof tabs.create !== "function") {
        return failure(
          "unavailable",
          "chrome.tabs.create is not available in this context.",
        );
      }
      await tabs.create({ url, active: disposition === "foreground" });
    }
    return { ok: true };
  } catch (cause) {
    return failure(
      "api",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
