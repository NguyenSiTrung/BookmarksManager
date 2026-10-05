import { db } from "./database";
import { BookmarkMeta, type MetaTombstone } from "../schemas/meta";
import { putMeta, retainCorruptMeta } from "./meta";

/**
 * URL-keyed tombstones for removed bookmark metadata (D12).
 *
 * `chrome.bookmarks.onRemoved` fires with the removed subtree — including
 * every leaf's URL — so the cascade can keep the deleted meta rows instead
 * of dropping them. When a node with the same URL is created inside the
 * retention window the fields are written onto the new id and the
 * tombstone is consumed. Rows that fail `BookmarkMeta` validation take the
 * `corruptMeta` forensic path instead — tombstones only hold usable data.
 *
 * Design rules (locked by tests/unit/meta-tombstones.test.ts):
 *
 * - **Bounded.** Rows expire after {@link TOMBSTONE_RETENTION_DAYS} days
 *   and the table is capped at {@link TOMBSTONE_ROW_CAP} — pruning runs on
 *   every write and at startup reconcile. Expired rows never re-attach.
 * - **URL-keyed, last write wins.** Removing a second bookmark with the
 *   same URL replaces the tombstone — the most recently removed metadata
 *   is the truth the next create sees.
 * - **Re-attach never clobbers a VALID row.** `reattachTombstone` writes
 *   only when the new id has no parseable meta row; a fresher valid row
 *   wins and still consumes the tombstone (an unreadable incumbent is
 *   absent — the attach proceeds and retains it on overwrite, D13).
 * - **Every candidate row leaves `bookmarkMeta`.** Tombstonable or not —
 *   folders, url-less rows, unparseable rows — the live row always dies
 *   with its bookmark; the retained copy is elsewhere by construction.
 */

/** Tombstones older than this never re-attach and are pruned. */
export const TOMBSTONE_RETENTION_DAYS = 30;

/** Hard cap on retained tombstones — oldest are evicted first. */
export const TOMBSTONE_ROW_CAP = 2000;

/**
 * One dead id to reap. `url` is the URL the tombstone keys under — the
 * witnessed-remove path passes the node's snapshot URL (fresher than any
 * recorded field); the reconcile path passes nothing and the row's own
 * `meta.url` keys the tombstone instead. Rows with no URL at all are
 * deleted without a tombstone.
 */
export interface TombstoneCandidate {
  id: string;
  url?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cutoffIso(now: Date): string {
  return new Date(
    now.getTime() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Drop expired tombstones and evict the oldest beyond the cap. Runs on
 * every tombstone write and at startup reconcile. Returns rows removed.
 */
export async function pruneTombstones(now = new Date()): Promise<number> {
  const cutoff = cutoffIso(now);
  let removed = await db.metaTombstones
    .where("removedAt")
    .below(cutoff)
    .delete();
  const excess = (await db.metaTombstones.count()) - TOMBSTONE_ROW_CAP;
  if (excess > 0) {
    const stale = await db.metaTombstones
      .orderBy("removedAt")
      .limit(excess)
      .primaryKeys();
    await db.metaTombstones.bulkDelete(stale);
    removed += stale.length;
  }
  return removed;
}

/**
 * Reap the candidates' meta rows: a schema-invalid row is retained to
 * `corruptMeta` first (D13), a valid row whose URL is known becomes a
 * tombstone (D12), and a valid row without a URL cannot be re-attached.
 * Every candidate row leaves `bookmarkMeta`. Returns tombstones written.
 */
export async function tombstoneMetaByIds(
  candidates: readonly TombstoneCandidate[],
  options: { corruptReason?: "delete" | "reconcile" } = {},
): Promise<number> {
  if (candidates.length === 0) return 0;
  const corruptReason = options.corruptReason ?? "delete";
  return db.transaction(
    "rw",
    db.bookmarkMeta,
    db.metaTombstones,
    db.corruptMeta,
    async () => {
      const removedAt = nowIso();
      let tombstoned = 0;
      for (const { id, url } of candidates) {
        const raw = await db.bookmarkMeta.get(id);
        if (raw === undefined) continue;
        const meta = BookmarkMeta.safeParse(raw);
        if (!meta.success) {
          await retainCorruptMeta(id, corruptReason);
          continue;
        }
        // Prefer the witnessed URL (freshest); fall back to the row's own
        // recorded url for the unwitnessed reconcile path.
        const key = url ?? meta.data.url;
        if (key === undefined) continue; // no re-attach key — delete only
        const tombstone: MetaTombstone = {
          url: key,
          tags: meta.data.tags,
          ...(meta.data.category === undefined
            ? {}
            : { category: meta.data.category }),
          ...(meta.data.notes === undefined ? {} : { notes: meta.data.notes }),
          ...(meta.data.summary === undefined
            ? {}
            : { summary: meta.data.summary }),
          deadId: id,
          removedAt,
        };
        await db.metaTombstones.put(tombstone);
        tombstoned += 1;
      }
      // Every candidate row dies — tombstoned, corrupt-retained, or plain.
      await db.bookmarkMeta
        .where("id")
        .anyOf(candidates.map((candidate) => candidate.id))
        .delete();
      await pruneTombstones();
      return tombstoned;
    },
  );
}

/**
 * Re-attach a tombstoned row to a just-created bookmark with the same URL
 * (D12). Writes the tombstoned fields onto `bookmarkId` — with its URL and
 * schema stamp — and consumes the tombstone. Returns false when there is
 * no live tombstone for `url`, when it has expired, or when the new id
 * already carries a meta row (a fresher row wins; the tombstone is still
 * consumed so it can't attach to a LATER create with stale data).
 */
export async function reattachTombstone(
  bookmarkId: string,
  url: string,
): Promise<boolean> {
  return db.transaction(
    "rw",
    db.bookmarkMeta,
    db.metaTombstones,
    db.corruptMeta,
    async () => {
      const tombstone = await db.metaTombstones.get(url);
      if (tombstone === undefined) return false;
      // Whatever happens below, this tombstone is spent: it can only ever
      // describe THIS url, and either it lands now or it never lands.
      await db.metaTombstones.delete(url);
      const live = await db.bookmarkMeta.get(bookmarkId);
      // A VALID live row is fresher — it wins. An UNPARSEABLE one counts
      // as absent (same rule as every read): the attach proceeds and
      // commitMeta's corrupt-retention keeps its copy on the overwrite.
      if (live !== undefined && BookmarkMeta.safeParse(live).success) {
        return false;
      }
      if (tombstone.removedAt < cutoffIso(new Date())) {
        return false; // expired — consumed but not re-attached
      }
      await putMeta(bookmarkId, {
        tags: tombstone.tags,
        category: tombstone.category ?? null,
        notes: tombstone.notes ?? null,
        summary: tombstone.summary ?? null,
        url,
      });
      return true;
    },
  );
}
