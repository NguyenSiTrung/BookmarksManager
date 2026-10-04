import { afterEach, describe, expect, it, vi } from "vitest";
import { openBookmarkUrl } from "../../src/sync/tabs";
import type { OpenUrlDisposition } from "../../src/sync/tabs";

/**
 * Coverage for the typed `chrome.tabs` open slice. Every surface is stubbed
 * with `vi.stubGlobal("chrome", …)` per the house lazy-slice pattern — the
 * module resolves `chrome.tabs` at call time, so absent, partial, and
 * throwing surfaces must all collapse into typed `{ok:false, code, message}`
 * results and never throw across the helper boundary.
 */

const URL_OK = "https://example.com/";
const DISPOSITIONS: OpenUrlDisposition[] = [
  "current",
  "foreground",
  "background",
];

/** A complete `chrome.tabs` stub with spies for both methods. */
function installTabs() {
  const create = vi.fn(() => Promise.resolve({ id: 42 }));
  const update = vi.fn(() => Promise.resolve({ id: 7 }));
  vi.stubGlobal("chrome", { tabs: { create, update } });
  return { create, update };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openBookmarkUrl dispositions", () => {
  it("opens in the current tab via tabs.update({url})", async () => {
    const { create, update } = installTabs();
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ url: URL_OK });
    expect(create).not.toHaveBeenCalled();
  });

  it("opens a new foreground tab via tabs.create({url, active:true})", async () => {
    const { create, update } = installTabs();
    const result = await openBookmarkUrl(URL_OK, "foreground");
    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ url: URL_OK, active: true });
    expect(update).not.toHaveBeenCalled();
  });

  it("opens a new background tab via tabs.create({url, active:false})", async () => {
    const { create, update } = installTabs();
    const result = await openBookmarkUrl(URL_OK, "background");
    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ url: URL_OK, active: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("openBookmarkUrl openable-URL guard", () => {
  it("rejects a javascript: URL for every disposition without touching chrome.tabs", async () => {
    for (const disposition of DISPOSITIONS) {
      const { create, update } = installTabs();
      const result = await openBookmarkUrl("javascript:alert(1)", disposition);
      expect(result, disposition).toMatchObject({ ok: false, code: "not_openable" });
      expect(create, disposition).not.toHaveBeenCalled();
      expect(update, disposition).not.toHaveBeenCalled();
    }
  });

  it("rejects a data: URL without touching chrome.tabs", async () => {
    const { create, update } = installTabs();
    const result = await openBookmarkUrl(
      "data:text/html,<h1>x</h1>",
      "foreground",
    );
    expect(result).toMatchObject({ ok: false, code: "not_openable" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("guards before resolving chrome at all — not_openable even with no chrome global", async () => {
    vi.stubGlobal("chrome", undefined);
    const result = await openBookmarkUrl(
      "  JaVaScRiPt:alert(1)",
      "background",
    );
    expect(result).toMatchObject({ ok: false, code: "not_openable" });
  });

  it("rejects a blank URL without touching chrome.tabs", async () => {
    const { create, update } = installTabs();
    const result = await openBookmarkUrl("   ", "current");
    expect(result).toMatchObject({ ok: false, code: "not_openable" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("openBookmarkUrl absent and partial surfaces", () => {
  it("reports unavailable when the chrome global itself is absent", async () => {
    // No stub at all: bare `chrome` access throws a ReferenceError.
    vi.unstubAllGlobals();
    const result = await openBookmarkUrl(URL_OK, "foreground");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("reports unavailable when the chrome global is undefined", async () => {
    vi.stubGlobal("chrome", undefined);
    const result = await openBookmarkUrl(URL_OK, "foreground");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("reports unavailable when chrome exists without a tabs namespace", async () => {
    vi.stubGlobal("chrome", { runtime: {} });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("reports unavailable when chrome.tabs is null", async () => {
    vi.stubGlobal("chrome", { tabs: null });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });

  it("reports unavailable for every disposition when chrome.tabs is an empty object", async () => {
    for (const disposition of DISPOSITIONS) {
      vi.stubGlobal("chrome", { tabs: {} });
      const result = await openBookmarkUrl(URL_OK, disposition);
      expect(result, disposition).toMatchObject({ ok: false, code: "unavailable" });
    }
  });

  it("reports unavailable when the disposition's method is missing (create present, update absent)", async () => {
    const create = vi.fn(() => Promise.resolve({ id: 42 }));
    vi.stubGlobal("chrome", { tabs: { create } });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(create).not.toHaveBeenCalled();
  });

  it("still opens when only the needed method is present", async () => {
    const create = vi.fn(() => Promise.resolve({ id: 42 }));
    vi.stubGlobal("chrome", { tabs: { create } });
    const result = await openBookmarkUrl(URL_OK, "foreground");
    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ url: URL_OK, active: true });
  });

  it("treats a non-function member as absent", async () => {
    vi.stubGlobal("chrome", { tabs: { update: 42 } });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("openBookmarkUrl call failures", () => {
  it("maps a rejected tabs.update promise to {ok:false, code:'api'}", async () => {
    const update = vi.fn(() =>
      Promise.reject(new Error("No tab with id: 42.")),
    );
    vi.stubGlobal("chrome", { tabs: { update } });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toEqual({
      ok: false,
      code: "api",
      message: "No tab with id: 42.",
    });
  });

  it("maps a rejected tabs.create promise to {ok:false, code:'api'}", async () => {
    const create = vi.fn(() =>
      Promise.reject(new Error("Tabs cannot be edited right now")),
    );
    vi.stubGlobal("chrome", { tabs: { create } });
    const result = await openBookmarkUrl(URL_OK, "background");
    expect(result).toEqual({
      ok: false,
      code: "api",
      message: "Tabs cannot be edited right now",
    });
  });

  it("maps a synchronous throw inside the tabs call to api — the helper never throws", async () => {
    const create = vi.fn(() => {
      throw new Error("user gesture required");
    });
    vi.stubGlobal("chrome", { tabs: { create } });
    const result = await openBookmarkUrl(URL_OK, "foreground");
    expect(result).toEqual({
      ok: false,
      code: "api",
      message: "user gesture required",
    });
  });

  it("stringifies non-Error rejections", async () => {
    const update = vi.fn(() => Promise.reject("denied"));
    vi.stubGlobal("chrome", { tabs: { update } });
    const result = await openBookmarkUrl(URL_OK, "current");
    expect(result).toEqual({ ok: false, code: "api", message: "denied" });
  });
});
