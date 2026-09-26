import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import Dexie from "dexie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  type KeyMaterialEntry,
  type MetadataEntry,
  type SentLogEntry,
} from "../../src/db/database";
import { Decision } from "../../src/schemas/decision";
import { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import type { ConsentRecord } from "../../src/schemas/provider";
import { UndoSnapshot } from "../../src/schemas/undo";
import {
  validConsent,
  validDecision,
  validProviderSettings,
  validSentLogEntry,
} from "../fixtures/base-records";
import { validBookmarkMeta, validTagDef } from "../fixtures/meta";
import { validUndoSnapshot } from "../fixtures/undo";

/**
 * The version-1 schema as a standalone Dexie declaration — the migration test
 * builds a real v1 database, seeds Phase 0 rows, closes it, then opens the
 * current BookmarksManagerDB class against the same name.
 */
const V1_STORES = {
  metadata: "key",
  decisions: "id,status,createdAt",
  consents: "[scope+origin],acceptedAt",
  sentLog: "++id,sentAt",
  keyMaterials: "id",
} as const;

const seededDecision = Decision.parse(validDecision);
let seededSentLogId = -1;

async function seedV1Database(): Promise<void> {
  const v1 = new Dexie("BookmarksManager");
  v1.version(1).stores(V1_STORES);
  await v1.open();

  await v1.table<MetadataEntry, string>("metadata").put({
    key: validProviderSettings.preset,
    value: { ...validProviderSettings },
  });
  await v1.table<Decision, string>("decisions").add({ ...seededDecision });
  await v1
    .table<ConsentRecord, [string, string]>("consents")
    .add({ ...validConsent });
  // Fresh copies per write: Dexie writes a generated inbound key back onto
  // the caller's object, so fixtures must never be passed by reference.
  seededSentLogId = await v1
    .table<SentLogEntry, number>("sentLog")
    .add({ ...validSentLogEntry });
  const key = (await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )) as CryptoKey;
  await v1
    .table<KeyMaterialEntry, string>("keyMaterials")
    .put({ id: "provider:typesafe", key });

  v1.close();
}

describe("BookmarksManagerDB v1 → v2 migration", () => {
  beforeAll(async () => {
    await seedV1Database();
    // Opening the real class on the same name must run the v1→v2 upgrade.
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  it("opens at version 2 with all eight tables declared", () => {
    expect(db.verno).toBe(2);
    // Dexie stores version × 10 natively; 20 proves the class upgraded the
    // existing v1 database rather than creating a new one.
    expect(db.backendDB()?.version).toBe(20);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "bookmarkMeta",
      "consents",
      "decisions",
      "keyMaterials",
      "metadata",
      "sentLog",
      "tags",
      "undo",
    ]);
  });

  it("declares bookmarkMeta as id,*tags,category,updatedAt", () => {
    expect(db.bookmarkMeta.schema.primKey.keyPath).toBe("id");
    const indexes = db.bookmarkMeta.schema.indexes;
    expect(indexes.map((index) => index.name).sort()).toEqual([
      "category",
      "tags",
      "updatedAt",
    ]);
    // *tags is a multiEntry index over tag nameKeys.
    expect(indexes.find((index) => index.name === "tags")?.multi).toBe(true);
  });

  it("declares tags keyed by nameKey", () => {
    expect(db.tags.schema.primKey.keyPath).toBe("nameKey");
    expect(db.tags.schema.indexes).toHaveLength(0);
  });

  it("declares undo as ++id,createdAt", () => {
    expect(db.undo.schema.primKey.keyPath).toBe("id");
    expect(db.undo.schema.primKey.auto).toBe(true);
    expect(db.undo.schema.indexes.map((index) => index.name)).toEqual([
      "createdAt",
    ]);
  });

  it("preserves the seeded v1 rows in every Phase 0 table", async () => {
    const settings = await db.metadata.get("typesafe");
    expect(settings?.value).toEqual(validProviderSettings);

    expect(await db.decisions.get(seededDecision.id)).toEqual(seededDecision);
    expect(
      await db.decisions.where("status").equals("pending").count(),
    ).toBe(1);

    expect(
      await db.consents.get([validConsent.scope, validConsent.origin]),
    ).toEqual(validConsent);

    const sentRow = await db.sentLog.get(seededSentLogId);
    expect(sentRow).toEqual({ ...validSentLogEntry, id: seededSentLogId });

    const keyRow = await db.keyMaterials.get("provider:typesafe");
    expect(keyRow?.key.type).toBe("secret");
    expect(keyRow?.key.extractable).toBe(false);
    expect(keyRow?.key.algorithm.name).toBe("AES-GCM");
    // The migrated key is still usable, not just structurally present.
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyRow!.key,
      new TextEncoder().encode("payload"),
    );
    const plaintext = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyRow!.key,
      ciphertext,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("payload");
  });

  it("accepts writes into the new v2 tables", async () => {
    const meta = BookmarkMeta.parse(validBookmarkMeta);
    await db.bookmarkMeta.add({ ...meta });
    expect(await db.bookmarkMeta.get(meta.id)).toEqual(meta);
    // The multiEntry index resolves a single tag nameKey to the row.
    expect(
      await db.bookmarkMeta.where("tags").equals("typescript").count(),
    ).toBe(1);

    const tag = TagDef.parse(validTagDef);
    await db.tags.add({ ...tag });
    expect(await db.tags.get(tag.nameKey)).toEqual(tag);

    const snapshot = UndoSnapshot.parse(validUndoSnapshot);
    const undoId = await db.undo.add({ ...snapshot });
    expect(typeof undoId).toBe("number");
    expect(await db.undo.get(undoId)).toEqual({ ...snapshot, id: undoId });
    expect(await db.undo.orderBy("createdAt").count()).toBe(1);
  });
});
