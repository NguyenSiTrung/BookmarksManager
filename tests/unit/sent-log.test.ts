import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, type SentLogEntry } from "../../src/db/database";
import {
  appendSentLog,
  beginSentLog,
  clearSentLog,
  SENT_LOG_RETENTION_CAP,
} from "../../src/net/sent-log";

beforeEach(async () => {
  vi.restoreAllMocks();
  if (!db.isOpen()) await db.open();
  await db.sentLog.clear();
});

afterAll(() => {
  db.close();
});

/** A fresh metadata-only audit row; `sentAt` defaults to a fixed instant so
 * callers can force identical timestamps and exercise tie-breaking. */
function entry(
  overrides: Partial<SentLogEntry> = {},
): Omit<SentLogEntry, "id"> {
  return {
    sentAt: "2026-09-25T10:05:00.000Z",
    destination: "https://api.typesafe.ai",
    feature: "jev_test",
    fieldNames: ["state", "question"],
    ...overrides,
  };
}

/** Append `count` rows, tagging each with a distinct feature so survival can
 * be asserted by content as well as by row id. */
async function appendMany(count: number): Promise<void> {
  const bulkThreshold = 10;
  if (count <= bulkThreshold) {
    for (let index = 0; index < count; index += 1) {
      await appendSentLog(entry({ feature: `feature-${index}` }));
    }
    return;
  }
  const bulkCount = Math.min(count - 2, SENT_LOG_RETENTION_CAP - 2);
  const seedItems = [];
  for (let index = 0; index < bulkCount; index += 1) {
    seedItems.push(entry({ feature: `feature-${index}` }));
  }
  await db.sentLog.bulkAdd(seedItems as SentLogEntry[]);
  for (let index = bulkCount; index < count; index += 1) {
    await appendSentLog(entry({ feature: `feature-${index}` }));
  }
}

describe("appendSentLog", () => {
  it("keeps safe outcomes but drops arbitrary runtime outcome text", async () => {
    for (const outcome of ["ok", "retried", "timeout", "redirect", "transport", "http_503"]) {
      await appendSentLog({ ...entry(), outcome } as Omit<SentLogEntry, "id">);
    }
    await appendSentLog({ ...entry(), outcome: "Bearer secret / private error" } as unknown as Omit<SentLogEntry, "id">);
    const rows = await db.sentLog.orderBy(":id").toArray();
    expect(rows.map((row) => row.outcome))
      .toEqual(["ok", "retried", "timeout", "redirect", "transport", "http_503", undefined]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
  it("writes exactly one metadata-only row per append", async () => {
    const id = await appendSentLog(entry());
    expect(typeof id).toBe("number");

    const rows = await db.sentLog.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id,
      sentAt: "2026-09-25T10:05:00.000Z",
      destination: "https://api.typesafe.ai",
      feature: "jev_test",
      fieldNames: ["state", "question"],
    });
  });

  it("persists only sentAt/destination/feature/fieldNames — never content", async () => {
    // Extra runtime properties (a request body, a bookmark title, a URL) must
    // not survive the write: the service stores only the four audit fields.
    const poisoned = {
      ...entry(),
      body: "secret request payload",
      title: "My private bookmark",
      url: "https://example.com/private?token=abc",
    } as Omit<SentLogEntry, "id">;

    await appendSentLog(poisoned);

    const stored = await db.sentLog.toArray();
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!).sort()).toEqual([
      "destination",
      "feature",
      "fieldNames",
      "id",
      "sentAt",
    ]);
    expect(JSON.stringify(stored[0])).not.toContain("secret request payload");
    expect(JSON.stringify(stored[0])).not.toContain("My private bookmark");
    expect(JSON.stringify(stored[0])).not.toContain("token=abc");
  });

  it("does not trim while the total is below the cap (cap-1 boundary)", async () => {
    await appendMany(SENT_LOG_RETENTION_CAP - 1);

    expect(await db.sentLog.count()).toBe(SENT_LOG_RETENTION_CAP - 1);
  });

  it("keeps exactly the cap rows at the cap boundary", async () => {
    await appendMany(SENT_LOG_RETENTION_CAP);

    expect(await db.sentLog.count()).toBe(SENT_LOG_RETENTION_CAP);
  });

  it("trims the OLDEST rows once the cap is exceeded (cap+1 boundary)", async () => {
    await appendMany(SENT_LOG_RETENTION_CAP);
    // The oldest row before the overflow append — it must be the one dropped.
    const oldestBefore = (await db.sentLog.orderBy(":id").first())!;

    await appendSentLog(entry({ feature: "newest" }));

    const rows = await db.sentLog.orderBy(":id").toArray();
    expect(rows).toHaveLength(SENT_LOG_RETENTION_CAP);
    // The oldest row is gone and the freshly appended row survives.
    expect(await db.sentLog.get(oldestBefore.id!)).toBeUndefined();
    expect(rows[0]!.feature).toBe("feature-1");
    expect(rows.at(-1)?.feature).toBe("newest");
  });

  it("prunes by insertion order even when sentAt values are identical", async () => {
    // Identical timestamps make `sentAt` a useless tie-breaker; only the
    // auto-incremented `id` (insertion order) may decide survival.
    await appendMany(SENT_LOG_RETENTION_CAP + 5);

    const rows = await db.sentLog.orderBy(":id").toArray();
    expect(rows).toHaveLength(SENT_LOG_RETENTION_CAP);
    // The five oldest inserts (features 0..4) were dropped.
    expect(rows[0]!.feature).toBe("feature-5");
    expect(rows.at(-1)?.feature).toBe(`feature-${SENT_LOG_RETENTION_CAP + 4}`);
  });

  it("never lets the count exceed the cap across many appends", async () => {
    await appendMany(SENT_LOG_RETENTION_CAP + 10);

    expect(await db.sentLog.count()).toBe(SENT_LOG_RETENTION_CAP);
  });
});

describe("beginSentLog", () => {
  it("persists an unknown dispatch while transport is pending, then updates only its outcome", async () => {
    const finish = beginSentLog(entry());
    await vi.waitFor(async () => expect(await db.sentLog.count()).toBe(1));
    const [pending] = await db.sentLog.toArray();
    expect(pending).toMatchObject({
      destination: "https://api.typesafe.ai",
      feature: "jev_test",
      fieldNames: ["state", "question"],
    });
    expect(pending).not.toHaveProperty("outcome");
    await finish("timeout");
    expect(await db.sentLog.toArray()).toEqual([{ ...pending, outcome: "timeout" }]);
  });

  it("does not resurrect attempts cleared while in flight", async () => {
    const finish = beginSentLog(entry());
    await vi.waitFor(async () => expect(await db.sentLog.count()).toBe(1));
    await clearSentLog();
    await finish("ok");
    expect(await db.sentLog.count()).toBe(0);
  });

  it("does not resurrect an attempt trimmed while in flight", async () => {
    const finish = beginSentLog(entry({ feature: "pending" }));
    await vi.waitFor(async () => expect(await db.sentLog.count()).toBe(1));
    const pendingId = (await db.sentLog.toArray())[0]!.id!;
    await appendMany(SENT_LOG_RETENTION_CAP);
    expect(await db.sentLog.get(pendingId)).toBeUndefined();
    await finish("ok");
    expect(await db.sentLog.get(pendingId)).toBeUndefined();
    expect(await db.sentLog.count()).toBe(SENT_LOG_RETENTION_CAP);
  });

  it("rejects unsafe outcome updates without leaking runtime error text", async () => {
    const finish = beginSentLog(entry());
    await finish("private response / Bearer key" as Parameters<typeof finish>[0]);
    const [row] = await db.sentLog.toArray();
    expect(row).not.toHaveProperty("outcome");
    expect(JSON.stringify(row)).not.toContain("Bearer");
  });
});

describe("clearSentLog", () => {
  it("empties the log and returns the number of rows removed", async () => {
    await appendMany(7);
    expect(await db.sentLog.count()).toBe(7);

    const removed = await clearSentLog();

    expect(removed).toBe(7);
    expect(await db.sentLog.count()).toBe(0);
    expect(await db.sentLog.toArray()).toEqual([]);
  });

  it("returns zero and stays empty on an already-empty log", async () => {
    expect(await clearSentLog()).toBe(0);
    expect(await db.sentLog.count()).toBe(0);
  });
});
