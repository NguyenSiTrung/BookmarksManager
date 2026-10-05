import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { getMeta, getTag } from "../../src/db/meta";
import {
  handleSaveMessage,
  SaveMessageResult,
} from "../../src/messages/save";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * The worker-side quick-save protocol (U06): one `SAVE` message runs the
 * whole popup save sequence — scheme boundary, tag-def resolve-or-create,
 * bookmark create, meta write (unwind on failure), last-folder — in the
 * worker so a destroyed popup context cannot leave a half-saved bookmark.
 *
 * `handleSaveMessage` is total: every path resolves to a
 * `SaveMessageResult`, or `undefined` for a message this module does not
 * own. Untrusted senders and malformed payloads fail closed, and non-code
 * throws collapse to `internal_error` (a raw error string never crosses).
 */

const EXTENSION_ID = "test-extension-id";
const POPUP_URL = `chrome-extension://${EXTENSION_ID}/popup.html`;
const CONTENT_URL = "https://example.com/page";

let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.metadata.clear();
  fake = createFakeBookmarks({
    bookmarksBar: [{ id: "fold", title: "Dev", children: [] }],
    otherBookmarks: [],
  });
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
  });
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

function saveMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "SAVE",
    parentId: "fold",
    title: "Page",
    url: "https://fresh.example/page",
    tags: [] as { key: string; label: string }[],
    category: "",
    notes: "",
    ...overrides,
  };
}

describe("handleSaveMessage", () => {
  it("returns undefined for a message it does not own", async () => {
    await expect(
      handleSaveMessage({ type: "OTHER" }, { url: POPUP_URL }),
    ).resolves.toBeUndefined();
  });

  it("refuses an untrusted sender", async () => {
    const result = await handleSaveMessage(saveMessage(), {
      url: CONTENT_URL,
    });
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect((await fake.getChildren("fold")).length).toBe(0);
  });

  it("refuses a malformed message", async () => {
    const result = await handleSaveMessage(
      { type: "SAVE" },
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
  });

  it("creates the bookmark and commits tags/category/notes meta", async () => {
    const result = await handleSaveMessage(
      saveMessage({
        tags: [{ key: "urgent", label: "Urgent" }],
        category: "docs",
        notes: "read later",
      }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: true });
    const created = (await fake.getChildren("fold")).find(
      (node) => node.url === "https://fresh.example/page",
    );
    expect(created).toBeDefined();
    expect(await getMeta(created?.id ?? "")).toMatchObject({
      tags: ["urgent"],
      category: "docs",
      notes: "read later",
    });
    // Tag def resolved on demand; folder remembered for the next save.
    expect(await getTag("urgent")).toBeDefined();
    expect((await db.metadata.get("prefs:lastFolderId"))?.value).toBe(
      "fold",
    );
    // The reply itself is protocol-shaped (validates on the wire).
    expect(SaveMessageResult.safeParse(result).success).toBe(true);
  });

  it("refuses an over-length note as malformed rather than unwinding", async () => {
    // The store bound is NOTES_MAX_LENGTH (10k): a paste beyond it fails at
    // the message schema — no bookmark is created to unwind.
    const result = await handleSaveMessage(
      saveMessage({ notes: "x".repeat(10_001) }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect((await fake.getChildren("fold")).length).toBe(0);
  });

  it("refuses a chip whose key is not tagNameKey(label)", async () => {
    // A mismatched key would tag the bookmark under a def that was never
    // resolved — the protocol derives keys, it does not trust them.
    const result = await handleSaveMessage(
      saveMessage({ tags: [{ key: "zzz", label: "Urgent" }] }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect((await fake.getChildren("fold")).length).toBe(0);
  });

  it("refuses an over-length tag label (TagDef name bound)", async () => {
    const label = "t".repeat(65);
    const result = await handleSaveMessage(
      saveMessage({ tags: [{ key: label, label }] }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
  });

  it("re-checks the scheme boundary at the trust line", async () => {
    const result = await handleSaveMessage(
      saveMessage({ url: "javascript:alert(1)" }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: false, code: "blocked_scheme" });
    expect(JSON.stringify(await fake.getTree())).not.toContain(
      "javascript:alert(1)",
    );
  });

  it("unwinds the created bookmark when the meta write fails", async () => {
    const putSpy = vi
      .spyOn(db.bookmarkMeta, "put")
      .mockRejectedValue(new Error("storage gone"));
    const result = await handleSaveMessage(
      saveMessage({ tags: [{ key: "urgent", label: "Urgent" }] }),
      { url: POPUP_URL },
    );
    putSpy.mockRestore();
    // A code-less throw collapses to internal_error — the raw string
    // never crosses the message boundary.
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
    expect(JSON.stringify(result)).not.toContain("storage gone");
    expect(
      (await fake.getChildren("fold")).filter(
        (node) => node.url === "https://fresh.example/page",
      ),
    ).toHaveLength(0);
    // The resolved tag def stays — it is not tree state.
    expect(await getTag("urgent")).toBeDefined();
  });

  it("falls back to the URL when the title is blank", async () => {
    const result = await handleSaveMessage(
      saveMessage({ title: "   " }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: true });
    const created = (await fake.getChildren("fold")).find(
      (node) => node.url === "https://fresh.example/page",
    );
    expect(created?.title).toBe("https://fresh.example/page");
  });

  it("tolerates a tag_exists race while resolving defs", async () => {
    // The def exists but the lookup misses (a lookup→create race elsewhere):
    // createTag throws tag_exists, which the save absorbs instead of
    // unwinding the bookmark.
    const { createTag } = await import("../../src/db/meta");
    await createTag("Urgent");
    // Only the handler's lookup misses — later table reads (createTag's own
    // existence check, patchMeta's) see the real def.
    vi.spyOn(db.tags, "get").mockResolvedValueOnce(undefined);
    const result = await handleSaveMessage(
      saveMessage({ tags: [{ key: "urgent", label: "Urgent" }] }),
      { url: POPUP_URL },
    );
    expect(result).toMatchObject({ ok: true });
    const created = (await fake.getChildren("fold")).find(
      (node) => node.url === "https://fresh.example/page",
    );
    expect(await getMeta(created?.id ?? "")).toMatchObject({
      tags: ["urgent"],
    });
  });
});
