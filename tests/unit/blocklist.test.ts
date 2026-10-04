import "fake-indexeddb/auto";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { DECISION_BLOCKLIST_KEY, readBlocklist } from "../../src/decisions/blocklist";

beforeEach(async () => {
  await db.delete();
  await db.open();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.close());

describe("persisted blocklist admission", () => {
  it("allows an unset row and valid empty/nonempty lists", async () => {
    await expect(readBlocklist()).resolves.toEqual([]);
    await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: [] });
    await expect(readBlocklist()).resolves.toEqual([]);
    await db.metadata.put({
      key: DECISION_BLOCKLIST_KEY, value: ["blocked-site.dev", "other-site.org", "::1"],
    });
    await expect(readBlocklist()).resolves.toEqual(["blocked-site.dev", "other-site.org", "::1"]);
  });

  it.each([
    undefined, null, "blocked-site.dev", { host: "blocked-site.dev" },
    ["blocked-site.dev", 42], ["blocked-site.dev", null], [""], ["   "],
    ["not a host"], ["host/path"], ["https://"], Array(1),
  ])("refuses malformed persisted value %# rather than dropping entries", async (value) => {
    await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value });
    const error: unknown = await readBlocklist().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "BlocklistReadError", code: "request_not_allowed" });
    expect((error as Error).cause).toBeUndefined();
    expect(inspect(error)).not.toContain("blocked-site.dev");
  });

  it("redacts an unreadable database without retaining a native cause", async () => {
    vi.spyOn(db.metadata, "get").mockRejectedValue(new Error("sensitive-db-detail.dev"));
    const error: unknown = await readBlocklist().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "BlocklistReadError", code: "request_not_allowed" });
    expect((error as Error).cause).toBeUndefined();
    for (const text of [String(error), JSON.stringify(error), inspect(error)]) {
      expect(text).not.toContain("sensitive-db-detail.dev");
    }
  });
});
