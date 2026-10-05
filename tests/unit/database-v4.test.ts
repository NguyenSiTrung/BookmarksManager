import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  type MetadataEntry,
  type SentLogEntry,
} from "../../src/db/database";
import { Decision } from "../../src/schemas/decision";
import { LlmUsageRecord, type UsageRecord } from "../../src/schemas/usage";
import { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import {
  validConsent,
  validDecision,
  validProviderSettings,
  validSentLogEntry,
} from "../fixtures/base-records";
import { validBookmarkMeta, validTagDef } from "../fixtures/meta";
import { validUndoSnapshot } from "../fixtures/undo";
import { validAuditEvent, validJob, validUsageRecord } from "../fixtures/phase4";

/**
 * The v1–v3 store declarations as standalone Dexie schemas — the migration
 * test builds a real v3 database, seeds Phase 0–4 rows, closes it, then opens
 * the current BookmarksManagerDB class against the same name to prove the
 * v3→v4 upgrade preserves every table.
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

const seededDecision = Decision.parse(validDecision);
const seededBookmarkMeta = BookmarkMeta.parse(validBookmarkMeta);
const seededTag = TagDef.parse(validTagDef);
let seededSentLogId = -1;
let seededUsageId = -1;

async function seedV3Database(): Promise<void> {
  const v3 = new Dexie("BookmarksManager");
  v3.version(1).stores(V1_STORES);
  v3.version(2).stores(V2_STORES);
  v3.version(3).stores(V3_STORES);
  await v3.open();

  await v3.table<MetadataEntry, string>("metadata").put({
    key: validProviderSettings.preset,
    value: { ...validProviderSettings },
  });
  // Fresh copies per write: Dexie writes a generated inbound key back onto
  // the caller's object, so fixtures must never be passed by reference.
  await v3.table("decisions").add({ ...seededDecision });
  await v3.table("consents").add({ ...validConsent });
  seededSentLogId = await v3
    .table<SentLogEntry, number>("sentLog")
    .add({ ...validSentLogEntry });
  await v3.table("keyMaterials").put({
    id: "provider:typesafe",
    key: { fake: "cryptokey-handle" },
  });
  await v3.table("bookmarkMeta").add({ ...seededBookmarkMeta });
  await v3.table("tags").add({ ...seededTag });
  await v3.table("undo").add({ ...validUndoSnapshot });
  await v3.table("jobs").add({ ...validJob });
  await v3.table("audit").add({ ...validAuditEvent });
  seededUsageId = await v3
    .table<UsageRecord, number>("usage")
    .add({ ...validUsageRecord });

  v3.close();
}

describe("BookmarksManagerDB v3 → v4 migration", () => {
  beforeAll(async () => {
    await seedV3Database();
    // Opening the real class on the same name must run the v3→v4 upgrade.
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it("opens at the current version with every table declared", () => {
    // The class now carries the A08 v5 upgrade on top of v4: the v3→v4
    // assertions below verify the v4 tables arrived intact through the
    // chain (Dexie applies every intermediate version).
    expect(db.verno).toBe(5);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "audit",
      "bookmarkMeta",
      "consents",
      "decisions",
      "jobs",
      "keyMaterials",
      "llmReservations",
      "llmUsage",
      "llmUsageMonths",
      "metadata",
      "sentLog",
      "tags",
      "undo",
      "usage",
      "usageMonths",
    ]);
  });

  it("declares llmUsage with its v5 indexes", () => {
    expect(db.llmUsage.schema.primKey.keyPath).toBe("id");
    expect(db.llmUsage.schema.primKey.auto).toBe(true);
    // v5 added `month` and `[providerId+month]` alongside the v4 indexes.
    const indexNames = db.llmUsage.schema.indexes.map((i) => i.name);
    expect(indexNames).toEqual(
      expect.arrayContaining(["providerId", "recordedAt", "month"]),
    );
    expect(
      db.llmUsage.schema.indexes.some((index) => index.compound),
    ).toBe(true);
  });

  it("declares llmReservations with its v5 indexes", () => {
    expect(db.llmReservations.schema.primKey.keyPath).toBe("id");
    const indexNames = db.llmReservations.schema.indexes.map((i) => i.name);
    expect(indexNames).toEqual(
      expect.arrayContaining(["providerId", "status", "month"]),
    );
    expect(
      db.llmReservations.schema.indexes.some((index) => index.compound),
    ).toBe(true);
  });

  it("preserves every pre-v4 row through the upgrade", async () => {
    const meta = await db.metadata.get(validProviderSettings.preset);
    expect(meta?.value).toMatchObject({ preset: validProviderSettings.preset });
    expect(await db.decisions.get(seededDecision.id)).toMatchObject({
      id: seededDecision.id,
    });
    expect(await db.sentLog.get(seededSentLogId)).toBeDefined();
    expect(await db.keyMaterials.get("provider:typesafe")).toBeDefined();
    expect(await db.bookmarkMeta.get(seededBookmarkMeta.id)).toBeDefined();
    expect(await db.tags.get(seededTag.nameKey)).toBeDefined();
    // The v5 upgrade backfilled `month` on the seeded usage row.
    expect(await db.usage.get(seededUsageId)).toMatchObject({
      month: "2026-09",
    });
    expect(await db.jobs.count()).toBe(1);
    expect(await db.audit.count()).toBe(1);
    expect(await db.undo.count()).toBe(1);
    expect(await db.consents.count()).toBe(1);
  });

  it("accepts a valid LlmUsageRecord row", async () => {
    const record = LlmUsageRecord.parse({
      providerId: "preset:openai",
      feature: "llm_explain",
      model: "returned-model",
      configuredModel: "configured-model",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.0004,
      recordedAt: "2026-09-28T00:00:00Z",
    });
    const id = await db.llmUsage.add(record);
    const stored = await db.llmUsage.get(id);
    expect(stored).toMatchObject({
      providerId: "preset:openai",
      model: "returned-model",
      inputTokens: 1200,
      costUsd: 0.0004,
    });
  });
});
