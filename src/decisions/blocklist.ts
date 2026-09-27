import { db } from "../db/database";

/**
 * The persisted user blocklist (spec FR2, PROJECT_PLAN.md §12): the hosts the
 * user has told the extension never to send to Jev, stored as a namespaced
 * `metadata` row. This module is the single reader/writer-key owner so both
 * the background worker (`src/entrypoints/background.ts`, which persists it)
 * and the consented egress gate (`src/net/send.ts`, which re-checks it as
 * defense-in-depth) can read the live list without importing each other and
 * without a circular dependency.
 */

/** The namespaced `metadata` key under which the user blocklist is stored. */
export const DECISION_BLOCKLIST_KEY = "decisions:blocklist";

/**
 * The persisted user blocklist (normalized hosts), or `[]` when unset or
 * unreadable. Fails closed to an empty list: a broken lookup must not block
 * every send, and a missing list means the user has added no entries.
 */
export async function readBlocklist(): Promise<string[]> {
  try {
    const row = await db.metadata.get(DECISION_BLOCKLIST_KEY);
    const value = row?.value;
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}
