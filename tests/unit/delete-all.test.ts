import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  DELETE_ALL_ITEMS,
  NATIVE_BOOKMARKS_NOTICE,
  OPTIONAL_HOST_ORIGINS,
  deleteAllExtensionData,
} from "../../src/security/delete-all";
import { PRESETS } from "../../src/net/presets";
import { createFakeBookmarks, type FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Minimal in-memory `chrome.storage` area stub with a live backing map, so a
 * test can seed data and prove `clear()` emptied it.
 */
interface AreaStub {
  store: Record<string, unknown>;
  clear: ReturnType<typeof vi.fn>;
}

function areaStub(seed: Record<string, unknown> = {}): AreaStub {
  const store: Record<string, unknown> = { ...seed };
  const clear = vi.fn(async () => {
    for (const key of Object.keys(store)) delete store[key];
  });
  return { store, clear };
}

interface ChromeStub {
  local: AreaStub;
  session: AreaStub;
  contains: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

/**
 * Compose the `chrome` surface `delete-all` touches plus a bookmarks fake so
 * the "native bookmarks untouched" assertion can run against the same global.
 */
function installChromeStub(options: {
  local?: AreaStub;
  session?: AreaStub;
  granted?: string[];
  removeResult?: (origin: string) => boolean;
  bookmarks?: FakeBookmarksApi;
}): ChromeStub {
  const local = options.local ?? areaStub();
  const session = options.session ?? areaStub();
  const granted = new Set(options.granted ?? []);
  const contains = vi.fn(async ({ origins }: { origins?: string[] }) =>
    (origins ?? []).some((origin) => granted.has(origin)),
  );
  const remove = vi.fn(async ({ origins }: { origins?: string[] }) => {
    const origin = origins?.[0] ?? "";
    const result = options.removeResult?.(origin) ?? true;
    if (result) granted.delete(origin);
    return result;
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: { clear: local.clear },
      session: { clear: session.clear },
    },
    permissions: { contains, remove },
    ...(options.bookmarks === undefined
      ? {}
      : { bookmarks: options.bookmarks }),
  });
  return { local, session, contains, remove };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

describe("deleteAllExtensionData", () => {
  it("deletes the extension's IndexedDB database", async () => {
    installChromeStub({});
    await db.metadata.put({ key: "typesafe", value: { model: "x" } });
    await db.bookmarkMeta.put({
      id: "b1",
      tags: ["reading"],
      updatedAt: "2026-09-26T10:00:00.000Z",
    });
    await db.tags.put({
      name: "Reading",
      nameKey: "reading",
      createdAt: "2026-09-26T10:00:00.000Z",
      updatedAt: "2026-09-26T10:00:00.000Z",
    });
    expect(await Dexie.exists("BookmarksManager")).toBe(true);

    await deleteAllExtensionData();

    // The database itself is gone, not merely its rows.
    expect(await Dexie.exists("BookmarksManager")).toBe(false);
    // Re-opening recreates an empty database (first-run state).
    await db.open();
    expect(await db.metadata.count()).toBe(0);
    expect(await db.bookmarkMeta.count()).toBe(0);
    expect(await db.tags.count()).toBe(0);
  });

  it("clears chrome.storage.local including provider-key ciphertext", async () => {
    const local = areaStub({
      "providerKey:typesafe": { v: 1, iv: "a", ct: "b" },
      "providerKey:openrouter": { v: 1, iv: "c", ct: "d" },
      typesafe: { model: "jev-latest", keySuffix: "cdef" },
    });
    installChromeStub({ local });

    await deleteAllExtensionData();

    expect(local.clear).toHaveBeenCalledTimes(1);
    expect(local.store).toEqual({});
  });

  it("clears chrome.storage.session best-effort when present", async () => {
    const session = areaStub({ scratch: 1 });
    installChromeStub({ session });

    await deleteAllExtensionData();

    expect(session.clear).toHaveBeenCalledTimes(1);
    expect(session.store).toEqual({});
  });

  it("removes only the GRANTED optional host permissions", async () => {
    const granted = [PRESETS.typesafe.permissionPattern];
    const chrome = installChromeStub({ granted });

    const result = await deleteAllExtensionData();

    expect(OPTIONAL_HOST_ORIGINS).toEqual([
      PRESETS.typesafe.permissionPattern,
      PRESETS.openrouter.permissionPattern,
    ]);
    // Only the granted origin is removed; the never-granted one is skipped.
    expect(chrome.remove).toHaveBeenCalledTimes(1);
    expect(chrome.remove).toHaveBeenCalledWith({
      origins: [PRESETS.typesafe.permissionPattern],
    });
    expect(result.permissionsRemoved).toEqual([
      PRESETS.typesafe.permissionPattern,
    ]);
    expect(result.permissionsFailed).toEqual([]);
  });

  it("ignores origins that were never granted", async () => {
    const chrome = installChromeStub({ granted: [] });

    const result = await deleteAllExtensionData();

    expect(chrome.remove).not.toHaveBeenCalled();
    expect(result.permissionsRemoved).toEqual([]);
    expect(result.permissionsFailed).toEqual([]);
  });

  it("reports a granted origin whose removal fails", async () => {
    const chrome = installChromeStub({
      granted: [PRESETS.openrouter.permissionPattern],
      removeResult: () => false,
    });

    const result = await deleteAllExtensionData();

    expect(chrome.remove).toHaveBeenCalledTimes(1);
    expect(result.permissionsRemoved).toEqual([]);
    expect(result.permissionsFailed).toEqual([
      PRESETS.openrouter.permissionPattern,
    ]);
  });

  it("counts a grant as removed when remove reports false but the grant is gone", async () => {
    // Simulate Chrome returning false for an already-released grant: the
    // origin is released from `held`, so the follow-up `contains` is false.
    const held = new Set<string>([PRESETS.typesafe.permissionPattern]);
    const contains = vi.fn(async ({ origins }: { origins?: string[] }) =>
      (origins ?? []).some((origin) => held.has(origin)),
    );
    const remove = vi.fn(async ({ origins }: { origins?: string[] }) => {
      for (const origin of origins ?? []) held.delete(origin);
      return false;
    });
    vi.stubGlobal("chrome", {
      storage: {},
      permissions: { contains, remove },
    });

    const result = await deleteAllExtensionData();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(result.permissionsRemoved).toEqual([
      PRESETS.typesafe.permissionPattern,
    ]);
    expect(result.permissionsFailed).toEqual([]);
  });

  it("tolerates missing storage areas", async () => {
    vi.stubGlobal("chrome", {
      storage: {},
      permissions: {
        contains: vi.fn(async () => false),
        remove: vi.fn(async () => true),
      },
    });

    await expect(deleteAllExtensionData()).resolves.toEqual({
      permissionsRemoved: [],
      permissionsFailed: [],
    });
  });

  it("propagates a chrome.storage.local clear failure", async () => {
    const local = areaStub();
    local.clear.mockImplementation(async () => {
      throw new Error("storage unavailable");
    });
    const chrome = installChromeStub({ local });

    await expect(deleteAllExtensionData()).rejects.toThrow(
      /storage unavailable/,
    );
    // A failed local clear stops before permissions are touched.
    expect(chrome.remove).not.toHaveBeenCalled();
  });

  it("never touches native Chrome bookmarks", async () => {
    const bookmarks = createFakeBookmarks({
      bookmarksBar: [
        { title: "Example", url: "https://example.com/" },
        {
          title: "Folder",
          children: [{ title: "Nested", url: "https://nested.example/" }],
        },
      ],
      otherBookmarks: [{ title: "Other", url: "https://other.example/" }],
    });
    installChromeStub({ bookmarks });
    const before = JSON.stringify(await bookmarks.getTree());

    await deleteAllExtensionData();

    const after = JSON.stringify(await bookmarks.getTree());
    expect(after).toBe(before);
  });

  it("makes no network requests", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    installChromeStub({});

    await deleteAllExtensionData();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("delete-all copy", () => {
  it("lists tags, categories, notes, undo history, imported-file metadata, provider keys/settings, and permissions", () => {
    const copy = DELETE_ALL_ITEMS.join("\n").toLowerCase();
    expect(copy).toMatch(/tags/);
    expect(copy).toMatch(/categor/);
    expect(copy).toMatch(/notes/);
    expect(copy).toMatch(/undo/);
    expect(copy).toMatch(/imported-file metadata/);
    expect(copy).toMatch(/provider keys/);
    expect(copy).toMatch(/permissions/);
  });

  it("states plainly that native bookmarks are untouched", () => {
    expect(NATIVE_BOOKMARKS_NOTICE.toLowerCase()).toContain("native");
    expect(NATIVE_BOOKMARKS_NOTICE.toLowerCase()).toContain("bookmarks");
    expect(NATIVE_BOOKMARKS_NOTICE.toLowerCase()).toContain("untouched");
  });
});
