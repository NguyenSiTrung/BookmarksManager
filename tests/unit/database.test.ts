import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { Decision } from "../../src/schemas/decision";
import {
  validConsent,
  validDecision,
  validProviderSettings,
  validSentLogEntry,
} from "../fixtures/base-records";

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
});

describe("BookmarksManager database", () => {
  it("declares the version-1/2 tables alongside the version-3 additions", () => {
    // `verno` reports the highest declared version: version(3) added
    // jobs/audit/usage for Phase 2 without touching the v1/v2 stores.
    expect(db.verno).toBe(3);
    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "audit",
      "bookmarkMeta",
      "consents",
      "decisions",
      "jobs",
      "keyMaterials",
      "metadata",
      "sentLog",
      "tags",
      "undo",
      "usage",
    ]);
  });

  it("uses the compound [scope+origin] primary key on consents", () => {
    const primKey = db.consents.schema.primKey;
    expect(primKey.compound).toBe(true);
    expect(primKey.keyPath).toEqual(["scope", "origin"]);
    expect(db.consents.schema.indexes.map((index) => index.name)).toContain(
      "acceptedAt",
    );
  });

  it("uses auto-incremented ids on sentLog and a string id on keyMaterials", () => {
    expect(db.sentLog.schema.primKey.auto).toBe(true);
    expect(db.sentLog.schema.primKey.keyPath).toBe("id");
    expect(db.keyMaterials.schema.primKey.keyPath).toBe("id");
  });

  it("round-trips a consent record", async () => {
    await db.consents.add(validConsent);
    const stored = await db.consents.get([
      validConsent.scope,
      validConsent.origin,
    ]);
    expect(stored).toEqual(validConsent);
  });

  it("rejects a duplicate [scope+origin] consent", async () => {
    await db.consents.add(validConsent);
    const renewed = { ...validConsent, acceptedAt: "2026-09-25T11:00:00.000Z" };
    await expect(db.consents.add(renewed)).rejects.toMatchObject({
      name: "ConstraintError",
    });
    expect(await db.consents.count()).toBe(1);
  });

  it("allows the same scope on a different origin", async () => {
    await db.consents.add(validConsent);
    const other = { ...validConsent, origin: "https://openrouter.ai" };
    await db.consents.add(other);
    expect(await db.consents.count()).toBe(2);
  });

  it("round-trips provider settings in metadata keyed by preset", async () => {
    await db.metadata.put({
      key: validProviderSettings.preset,
      value: validProviderSettings,
    });
    const row = await db.metadata.get("typesafe");
    expect(row?.value).toEqual(validProviderSettings);
  });

  it("stores decisions keyed by id and indexes status", async () => {
    const decision = Decision.parse(validDecision);
    await db.decisions.add(decision);
    expect(await db.decisions.get(decision.id)).toEqual(decision);
    expect(
      await db.decisions.where("status").equals("pending").count(),
    ).toBe(1);
  });

  it("auto-increments sentLog entries without caller-supplied ids", async () => {
    // Fresh copies per add: Dexie writes the generated key back onto the
    // object it is given, so reusing a fixture would smuggle in the old id.
    const first = await db.sentLog.add({ ...validSentLogEntry });
    const second = await db.sentLog.add({
      ...validSentLogEntry,
      sentAt: "2026-09-25T10:06:00.000Z",
    });
    expect(typeof first).toBe("number");
    expect(second).toBeGreaterThan(first);
    expect(await db.sentLog.orderBy("sentAt").toArray()).toHaveLength(2);
  });

  it("round-trips a non-extractable CryptoKey via structured clone", async () => {
    // node:crypto's CryptoKey type has a wider KeyUsage union than the DOM
    // lib's; the runtime objects are interchangeable for structured clone.
    const key = (await webcrypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    )) as CryptoKey;
    await db.keyMaterials.put({ id: "provider:typesafe", key });

    const stored = await db.keyMaterials.get("provider:typesafe");
    expect(stored).toBeDefined();
    expect(stored?.key.type).toBe("secret");
    expect(stored?.key.extractable).toBe(false);
    expect(stored?.key.algorithm.name).toBe("AES-GCM");

    // The stored key must still be usable by the worker.
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      stored!.key,
      new TextEncoder().encode("payload"),
    );
    const plaintext = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      stored!.key,
      ciphertext,
    );
    expect(new TextDecoder().decode(plaintext)).toBe("payload");
    await expect(webcrypto.subtle.exportKey("raw", stored!.key)).rejects
      .toThrow();
  });
});
