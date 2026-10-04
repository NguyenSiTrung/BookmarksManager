import { db } from "../db/database";
import { z } from "../schemas/z";
import { normalizeBlocklistEntry } from "./minimize";

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

/** A privacy-policy read failure, independent of either network gate. */
export class BlocklistReadError extends Error {
  readonly code = "request_not_allowed";

  constructor() {
    super("The current blocklist could not be verified; sending is refused.");
    this.name = "BlocklistReadError";
  }
}

const PersistedBlocklist = z.array(
  z.string().refine((entry) => normalizeBlocklistEntry(entry) !== null),
);

/**
 * The persisted user blocklist, or `[]` when the row is unset. An unreadable
 * or malformed row refuses the whole send, never silently drops policy
 * entries. Native errors and validation details are not retained as causes.
 */
export async function readBlocklist(): Promise<string[]> {
  try {
    const row = await db.metadata.get(DECISION_BLOCKLIST_KEY);
    if (row === undefined) return [];
    const parsed = PersistedBlocklist.safeParse(row.value);
    if (!parsed.success) throw new BlocklistReadError();
    return parsed.data;
  } catch {
    throw new BlocklistReadError();
  }
}
