import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { LlmUsageRecord, UsageRecord } from "../../src/schemas/usage";
import { validJob } from "../fixtures/phase4";

/**
 * The v1–v4 store declarations as standalone Dexie schemas — the migration
 * test builds a real v4 database, seeds rows the v5 upgrade must carry over
 * and backfill, closes it, then opens the current BookmarksManagerDB class
 * against the same name to prove the v4→v5 upgrade is additive and
 * lossless.
 */
const V1_STORES = {
  metadata: "key",
  decisions: "id,status,createdAt",
  consents: "[scope+origin],acceptedAt",
  sentLog: "++id,sentAt",
  keyMaterials: "id",
} as const;

const V2_STORES = {
  bookmarkMeta: "id,*tags,category,updatedAt",
  tags: "nameKey",
  undo: "++id,createdAt",
} as const;

const V3_STORES = {
  jobs: "id,status,createdAt",
  audit: "++id,decisionId,changedAt",
  usage: "++id,jobId,recordedAt",
} as const;

const V4_STORES = {
  llmUsage: "++id,providerId,recordedAt",
  llmReservations: "id,providerId,status",
} as const;

/** Rows seeded at v4 — note the ABSENT `month` fields. */
const OLD_USAGE = {
  model: "jev-1.13.0",
  inputTokens: 1_500,
  outputTokens: 400,
  costUsd: 0.00006,
  recordedAt: "2026-08-27T09:12:00.000Z",
};
const OLD_LLM_USAGE = {
  providerId: "preset:openai",
  feature: "llm_explain",
  model: "gpt-4o-mini",
  configuredModel: "gpt-4o-mini",
  inputTokens: 1_200,
  outputTokens: 300,
  costUsd: 0.0004,
  recordedAt: "2026-09-28T00:00:00.000Z",
};
const OLD_RESERVATION = {
  id: "res-legacy-1",
  providerId: "preset:openai",
  model: "gpt-4o-mini",
  month: "2026-09",
  reservedUsd: 0.001,
  maxInputTokens: 100,
  maxOutputTokens: 50,
  kind: "manual",
  status: "settled",
  createdAt: "2026-09-28T00:00:00.000Z",
  settledAt: "2026-09-28T00:00:05.000Z",
};

async function seedV4Database(): Promise<void> {
  const v4 = new Dexie("BookmarksManager");
  v4.version(1).stores(V1_STORES);
  v4.version(2).stores(V2_STORES);
  v4.version(3).stores(V3_STORES);
  v4.version(4).stores(V4_STORES);
  await v4.open();
  await v4.table("jobs").add({ ...validJob });
  await v4.table("usage").add({ ...OLD_USAGE });
  await v4.table("llmUsage").add({ ...OLD_LLM_USAGE });
  await v4.table("llmReservations").add({ ...OLD_RESERVATION });
  v4.close();
}

describe("BookmarksManagerDB v4 → v5 migration", () => {
  beforeAll(async () => {
    await seedV4Database();
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it("opens at version 8 with the rollup tables declared", () => {
    expect(db.verno).toBe(8);
    // Dexie stores version × 10 natively; 70 proves the class upgraded the
    // existing v4 database rather than creating a new one.
    expect(db.backendDB()?.version).toBe(80);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "audit",
      "bookmarkMeta",
      "consents",
      "corruptMeta",
      "decisions",
      "importQueues",
      "importStates",
      "jobs",
      "keyMaterials",
      "llmReservations",
      "llmUsage",
      "llmUsageMonths",
      "metaTombstones",
      "metadata",
      "restructureAssignments",
      "sentLog",
      "tags",
      "undo",
      "usage",
      "usageMonths",
    ]);
  });

  it("declares the new indexes", () => {
    expect(db.usage.schema.indexes.map((i) => i.name).sort()).toEqual([
      "jobId",
      "month",
      "recordedAt",
    ]);
    expect(db.usageMonths.schema.primKey.keyPath).toBe("key");
    expect(db.usageMonths.schema.indexes.map((i) => i.name).sort()).toEqual([
      "jobId",
      "month",
    ]);
    expect(db.llmUsage.schema.indexes.map((i) => i.name).sort()).toEqual(
      expect.arrayContaining(["month", "recordedAt", "providerId"]),
    );
    expect(
      db.llmUsage.schema.indexes.some((i) => i.compound),
    ).toBe(true);
    expect(db.llmReservations.schema.indexes.map((i) => i.name).sort()).toEqual(
      expect.arrayContaining(["month", "providerId", "status"]),
    );
  });

  it("backfills `month` on pre-v5 rows and keeps them readable", async () => {
    const usage = await db.usage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      ...OLD_USAGE,
      month: "2026-08",
    });
    // Round-trips through the schema with the materialized field.
    expect(() => UsageRecord.parse(usage[0])).not.toThrow();

    const llmRows = await db.llmUsage.toArray();
    expect(llmRows).toHaveLength(1);
    expect(llmRows[0]).toMatchObject({
      ...OLD_LLM_USAGE,
      month: "2026-09",
    });
    expect(() => LlmUsageRecord.parse(llmRows[0])).not.toThrow();

    // The compound index resolves them: the budget read hits
    // [providerId+month] — the backfilled row is inside it.
    const viaIndex = await db.llmUsage
      .where("[providerId+month]")
      .equals(["preset:openai", "2026-09"])
      .toArray();
    expect(viaIndex).toHaveLength(1);

    const reservation = await db.llmReservations.get("res-legacy-1");
    expect(reservation).toMatchObject({ status: "settled", month: "2026-09" });
    expect(await db.jobs.count()).toBe(1);
  });
});
