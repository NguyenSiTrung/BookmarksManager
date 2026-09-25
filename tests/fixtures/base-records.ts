import type { z } from "../../src/schemas/z";
import type { Bookmark, Tag } from "../../src/schemas/bookmark";
import type { Decision } from "../../src/schemas/decision";
import type { ConsentRecord, ProviderSettings } from "../../src/schemas/provider";
import type { SentLogEntry } from "../../src/db/database";

/**
 * Minimal valid bookmark input. `tags` and `health` are intentionally absent
 * so tests can assert the schema defaults.
 */
export const validBookmark = {
  id: "bm-001",
  url: "https://example.com/articles/how-to-test",
  title: "How to Test",
  folderId: "folder-1",
  category: "article",
  notes: "Short owner note.",
  createdAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  schemaVersion: 1,
} satisfies z.input<typeof Bookmark>;

export const validTag = {
  name: "typescript",
  description: "TypeScript language resources",
  color: "#3178c6",
} satisfies z.input<typeof Tag>;

/**
 * Fields shared by every Decision variant. Tests spread this object and add a
 * `kind` plus its kind-specific payload.
 */
export const decisionBase = {
  id: "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a",
  bookmarkIds: ["bm-001"],
  confidence: 0.92,
  status: "pending" as const,
  source: {
    engine: "jev" as const,
    providerId: "typesafe",
    model: "jev-1.13.0",
    questionSetVersion: "qs-1",
  },
  createdAt: "2026-09-25T10:00:00.000Z",
};

export const validDecision = {
  ...decisionBase,
  kind: "set_category",
  category: "article",
} satisfies z.input<typeof Decision>;

export const validProviderSettings = {
  preset: "typesafe",
  model: "jev-latest",
  keySuffix: "wxyz",
} satisfies ProviderSettings;

export const validConsent = {
  scope: "jev_test",
  origin: "https://api.typesafe.ai",
  consentVersion: 1,
  acceptedAt: "2026-09-25T10:00:00.000Z",
} satisfies ConsentRecord;

export const validSentLogEntry = {
  sentAt: "2026-09-25T10:05:00.000Z",
  destination: "https://api.typesafe.ai/v1/systemone",
  feature: "jev_test",
  fieldNames: ["state", "question"],
} satisfies Omit<SentLogEntry, "id">;
