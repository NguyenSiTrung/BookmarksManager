import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { createTag, listTags } from "../../src/db/meta";
import {
  STARTER_TAGS,
  STARTER_TAGS_SEEDED_KEY,
  seedStarterTags,
} from "../../src/db/starter-tags";

/**
 * Starter-tag seeding: one-shot inject of a tech/dev pack when the library
 * is empty and the seed flag has never been written. Never re-injects after
 * the user deletes tags, and never injects into a non-empty library.
 */

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.tags.clear();
  await db.metadata.delete(STARTER_TAGS_SEEDED_KEY);
});

afterAll(() => {
  db.close();
});

describe("STARTER_TAGS", () => {
  it("is a non-empty pack of unique names with short descriptions", () => {
    expect(STARTER_TAGS.length).toBeGreaterThanOrEqual(15);
    const nameKeys = STARTER_TAGS.map((tag) => tag.name.trim().toLowerCase());
    expect(new Set(nameKeys).size).toBe(STARTER_TAGS.length);
    for (const tag of STARTER_TAGS) {
      expect(tag.name.trim()).not.toBe("");
      expect(tag.name.length).toBeLessThanOrEqual(64);
      expect(tag.description.length).toBeGreaterThan(0);
      expect(tag.description.length).toBeLessThanOrEqual(300);
    }
  });
});

describe("seedStarterTags", () => {
  it("seeds the pack once when the library is empty", async () => {
    const result = await seedStarterTags();
    expect(result).toEqual({ seeded: true, created: STARTER_TAGS.length });
    const tags = await listTags();
    expect(tags).toHaveLength(STARTER_TAGS.length);
    expect(tags.map((t) => t.nameKey).sort()).toEqual(
      STARTER_TAGS.map((t) => t.name.trim().toLowerCase()).sort(),
    );
    expect(tags.find((t) => t.nameKey === "reading-list")?.description).toBe(
      STARTER_TAGS.find((t) => t.name === "reading-list")?.description,
    );
  });

  it("does not re-seed after the flag is set", async () => {
    await seedStarterTags();
    await db.tags.clear();
    const again = await seedStarterTags();
    expect(again).toEqual({ seeded: false, created: 0 });
    expect(await listTags()).toHaveLength(0);
  });

  it("skips a non-empty library and marks the flag", async () => {
    await createTag("mine");
    const result = await seedStarterTags();
    expect(result).toEqual({ seeded: false, created: 0 });
    expect(await listTags()).toHaveLength(1);
    const flag = await db.metadata.get(STARTER_TAGS_SEEDED_KEY);
    expect(flag?.value).toBe(true);
    // Later emptiness must not re-inject.
    await db.tags.clear();
    expect(await seedStarterTags()).toEqual({ seeded: false, created: 0 });
    expect(await listTags()).toHaveLength(0);
  });

  it("is a no-op when the flag is already set", async () => {
    await db.metadata.put({ key: STARTER_TAGS_SEEDED_KEY, value: true });
    expect(await seedStarterTags()).toEqual({ seeded: false, created: 0 });
    expect(await listTags()).toHaveLength(0);
  });
});
