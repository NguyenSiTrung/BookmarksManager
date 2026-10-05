import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  type MetadataEntry,
  type SentLogEntry,
} from "../../src/db/database";
import { AuditEvent } from "../../src/schemas/audit";
import { Job } from "../../src/schemas/job";
import { UsageRecord } from "../../src/schemas/usage";
import { Decision } from "../../src/schemas/decision";
import { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import { deleteAllExtensionData } from "../../src/security/delete-all";
import {
  validConsent,
  validDecision,
  validProviderSettings,
  validSentLogEntry,
} from "../fixtures/base-records";
import { validBookmarkMeta, validTagDef } from "../fixtures/meta";
import { validUndoSnapshot } from "../fixtures/undo";
import {
  failedJob,
  invalidAuditEvents,
  invalidJobs,
  invalidUsageRecords,
  malformedAuditEvents,
  malformedJobs,
  malformedUsageRecords,
  minimalJob,
  minimalUsageRecord,
  policyAuditEvent,
  validAuditEvent,
  validJob,
  validUsageRecord,
} from "../fixtures/phase4";

/**
 * The version-1 and version-2 schemas as standalone Dexie declarations — the
 * migration test builds a real v2 database, seeds Phase 0/1 rows, closes it,
 * then opens the current BookmarksManagerDB class against the same name.
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

const seededDecision = Decision.parse(validDecision);
const seededBookmarkMeta = BookmarkMeta.parse(validBookmarkMeta);
const seededTag = TagDef.parse(validTagDef);
let seededSentLogId = -1;

async function seedV2Database(): Promise<void> {
  const v2 = new Dexie("BookmarksManager");
  v2.version(1).stores(V1_STORES);
  v2.version(2).stores(V2_STORES);
  await v2.open();

  await v2.table<MetadataEntry, string>("metadata").put({
    key: validProviderSettings.preset,
    value: { ...validProviderSettings },
  });
  await v2.table<Decision, string>("decisions").add({ ...seededDecision });
  await v2
    .table("consents")
    .add({ ...validConsent });
  // Fresh copies per write: Dexie writes a generated inbound key back onto
  // the caller's object, so fixtures must never be passed by reference.
  seededSentLogId = await v2
    .table<SentLogEntry, number>("sentLog")
    .add({ ...validSentLogEntry });
  await v2.table("bookmarkMeta").add({ ...seededBookmarkMeta });
  await v2.table("tags").add({ ...seededTag });
  await v2.table("undo").add({ ...validUndoSnapshot });

  v2.close();
}

describe("BookmarksManagerDB v2 → v3 migration", () => {
  beforeAll(async () => {
    await seedV2Database();
    // Opening the real class on the same name must run the v2→v3 upgrade.
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it("opens at version 9 with all twenty tables declared", () => {
    expect(db.verno).toBe(9);
    // Dexie stores version × 10 natively; 90 proves the class upgraded the
    // existing v2 database rather than creating a new one.
    expect(db.backendDB()?.version).toBe(90);
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

  it("declares jobs as id,status,createdAt", () => {
    expect(db.jobs.schema.primKey.keyPath).toBe("id");
    expect(db.jobs.schema.indexes.map((index) => index.name).sort()).toEqual([
      "[kind+createdAt]",
      "createdAt",
      "status",
    ]);
  });

  it("declares audit as ++id,decisionId,changedAt", () => {
    expect(db.audit.schema.primKey.keyPath).toBe("id");
    expect(db.audit.schema.primKey.auto).toBe(true);
    expect(db.audit.schema.indexes.map((index) => index.name).sort()).toEqual([
      "changedAt",
      "decisionId",
    ]);
  });

  it("declares usage as ++id,jobId,recordedAt,month", () => {
    expect(db.usage.schema.primKey.keyPath).toBe("id");
    expect(db.usage.schema.primKey.auto).toBe(true);
    expect(db.usage.schema.indexes.map((index) => index.name).sort()).toEqual([
      "jobId",
      "month",
      "recordedAt",
    ]);
  });

  it("preserves the seeded v2 rows in every Phase 0/1 table", async () => {
    expect((await db.metadata.get("typesafe"))?.value).toEqual(
      validProviderSettings,
    );
    expect(await db.decisions.get(seededDecision.id)).toEqual(seededDecision);
    expect(
      await db.consents.get([validConsent.scope, validConsent.origin]),
    ).toEqual(validConsent);
    expect(await db.sentLog.get(seededSentLogId)).toEqual({
      ...validSentLogEntry,
      id: seededSentLogId,
    });
    expect(await db.bookmarkMeta.get(seededBookmarkMeta.id)).toEqual(
      seededBookmarkMeta,
    );
    expect(await db.tags.get(seededTag.nameKey)).toEqual(seededTag);
    expect(await db.undo.count()).toBe(1);
  });

  it("accepts writes into the new v3 tables", async () => {
    const job = Job.parse(validJob);
    await db.jobs.add({ ...job });
    expect(await db.jobs.get(job.id)).toEqual(job);
    expect(await db.jobs.where("status").equals("running").count()).toBe(1);
    expect(await db.jobs.orderBy("createdAt").count()).toBe(1);

    const audit = AuditEvent.parse(validAuditEvent);
    const auditId = await db.audit.add({ ...audit });
    expect(typeof auditId).toBe("number");
    expect(await db.audit.get(auditId)).toEqual({ ...audit, id: auditId });
    expect(
      await db.audit.where("decisionId").equals(audit.decisionId).count(),
    ).toBe(1);

    const usage = UsageRecord.parse(validUsageRecord);
    const usageId = await db.usage.add({ ...usage });
    expect(typeof usageId).toBe("number");
    expect(await db.usage.get(usageId)).toEqual({ ...usage, id: usageId });
    expect(await db.usage.where("jobId").equals(job.id).count()).toBe(1);
  });
});

describe("Phase 4 schemas", () => {
  it("accepts a full job and a cursor-resumed minimal job", () => {
    expect(Job.safeParse(validJob).success).toBe(true);
    expect(Job.safeParse(minimalJob).success).toBe(true);
    expect(Job.safeParse(failedJob).success).toBe(true);
  });

  it("rejects invalid and malformed job fixtures", () => {
    for (const [label, fixture] of [
      ...Object.entries(invalidJobs),
      ...Object.entries(malformedJobs),
    ]) {
      expect(Job.safeParse(fixture).success, label).toBe(false);
    }
  });

  it("accepts user- and policy-actor audit events", () => {
    expect(AuditEvent.safeParse(validAuditEvent).success).toBe(true);
    expect(AuditEvent.safeParse(policyAuditEvent).success).toBe(true);
  });

  it("rejects invalid and malformed audit fixtures", () => {
    for (const [label, fixture] of [
      ...Object.entries(invalidAuditEvents),
      ...Object.entries(malformedAuditEvents),
    ]) {
      expect(AuditEvent.safeParse(fixture).success, label).toBe(false);
    }
  });

  it("accepts a job-linked usage row and a standalone one", () => {
    expect(UsageRecord.safeParse(validUsageRecord).success).toBe(true);
    expect(UsageRecord.safeParse(minimalUsageRecord).success).toBe(true);
  });

  it("rejects invalid and malformed usage fixtures", () => {
    for (const [label, fixture] of [
      ...Object.entries(invalidUsageRecords),
      ...Object.entries(malformedUsageRecords),
    ]) {
      expect(UsageRecord.safeParse(fixture).success, label).toBe(false);
    }
  });
});

describe("delete-all drops the v3 tables", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it("removes the whole database — new tables included", async () => {
    await db.jobs.add({ ...Job.parse(validJob) });
    await db.audit.add({ ...AuditEvent.parse(validAuditEvent) });
    await db.usage.add({ ...UsageRecord.parse(validUsageRecord) });
    expect(await db.jobs.count()).toBe(1);

    vi.stubGlobal("chrome", {
      storage: {
        local: { clear: async () => undefined },
        session: { clear: async () => undefined },
      },
      permissions: {
        contains: async () => false,
        remove: async () => true,
      },
    });
    try {
      const result = await deleteAllExtensionData({ releaseGraceMs: 0 });
      expect(result.databaseDeleted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    // `indexedDB.databases()` reports what exists WITHOUT opening the
    // database — asserting absence here never re-creates it.
    const names = (await indexedDB.databases()).map((info) => info.name);
    expect(names).not.toContain("BookmarksManager");
  });
});
