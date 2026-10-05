import { db } from "../db/database";
import {
  get,
  getTree,
  getChildren,
  isFolder,
  BOOKMARKS_BAR_ID,
} from "../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import {
  createFolder,
  moveNode,
  removeNode,
  MutationError,
} from "../sync/mutations";
import { getJob, restructurePlanFor } from "../jobs/queue";
import { captureNodes, pushSnapshot } from "../undo/snapshot";
import { buildRestructureDiff } from "./diff";
import type { RestructureProposal } from "../schemas/restructure";
import { undoExpected } from "../undo/restore";
import { withUndoLock } from "../undo/lock";

/**
 * The apply half of spec FR8 — execute a vetted restructure plan as ONE
 * logical batch: create the proposed folders (parents first, existing
 * same-named folders reused), capture a `restructure` undo snapshot of every
 * moved bookmark's pre-move position, then move each resolved bookmark.
 *
 * Scope: preview/status read the root subtree (`getSubTree(ROOT_NODE_ID)`,
 * see `src/messages/restructure.ts`) while apply revalidates with the full
 * `getTree()`; both flatten to the same bar + Other + Mobile scope, so an
 * assignment is never silently dropped just because its bookmark lives
 * outside the bookmarks bar. Apply then filters that diff to the
 * reviewed/accepted ids. A failed or empty tree read is a typed `read_failed`
 * refusal, never an empty scope that would look like "nothing left to do".
 * Created folders still go under the bookmarks bar (destination root policy,
 * {@link ensureFolders}'s `rootId`).
 *
 * Guards (all before any Chrome write): the job is a completed `restructure`
 * job; every resolved bookmark still exists, is a leaf, and sits outside a
 * managed subtree (the diff pre-flags managed/root-adjacent rows as
 * `unresolved`, so they are skipped here rather than failing mid-apply);
 * every proposed path is schema-valid and resolvable to a folder id. On any
 * mid-apply failure the already-applied moves are replayed
 * in reverse (best effort) and only confirmed-empty created folders removed.
 * The snapshot is kept so incomplete compensation can be retried via undo.
 * The plan never auto-applies: this module only runs when a message handler
 * has passed the user's explicit confirmation.
 *
 * Idempotency: the terminal apply record (`restructure.applied`) is
 * persisted on the job row, and the record-check plus the whole apply is
 * serialized twice over — an in-worker per-job promise chain orders
 * same-context confirms, then the extension-wide undo lock
 * (`withUndoLock`, a Web Lock) excludes other contexts AND any undo
 * replay. (`withUndoLock` alone would run a second same-context caller
 * inline inside the first's critical section — that is its nested-call
 * contract — so the promise chain does the same-context ordering.)
 * A second CONFIRM therefore replays the recorded result instead of applying
 * twice: no second set of moves, no second snapshot.
 * A batch that needs no moves (`moved === 0`) pushes NO snapshot — an
 * empty-effect undo entry would replay pointless moves — and cleans up the
 * folders it created; its terminal record carries no `snapshotId`.
 */

/**
 * In-worker per-job serialization — the same shape as `serializeDecision`
 * in `src/decisions/apply.ts`: each new call appends to the previous one's
 * settlement so concurrent CONFIRMs for the same job run one at a time.
 */
const inflightApplies = new Map<string, Promise<unknown>>();

function serializeApply<T>(jobId: string, run: () => Promise<T>): Promise<T> {
  const prior = inflightApplies.get(jobId) ?? Promise.resolve();
  const next = prior.then(run, run);
  inflightApplies.set(jobId, next);
  void next.then(
    () => { if (inflightApplies.get(jobId) === next) inflightApplies.delete(jobId); },
    () => { if (inflightApplies.get(jobId) === next) inflightApplies.delete(jobId); },
  );
  return next;
}

export type ApplyErrorCode =
  | "invalid_job"
  | "not_ready"
  /** No reviewed assignment is still resolvable against the live tree. */
  | "stale"
  /**
   * The live tree could not be read (or read back empty, which Chrome's
   * `getTree()` never legitimately does) — the reviewed scope cannot be
   * revalidated, so nothing is touched.
   */
  | "read_failed"
  | "mutation_failed";

export class ApplyError extends Error {
  readonly code: ApplyErrorCode;

  constructor(code: ApplyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApplyError";
    this.code = code;
  }
}

export interface ApplyResult {
  /** How many bookmarks were moved. */
  readonly moved: number;
  /** Proposed paths that reused an existing folder instead of creating one. */
  readonly reusedPaths: readonly string[];
  /**
   * The undo snapshot row id — needed for `undoRestructurePlan`. Absent
   * when nothing moved: no snapshot was pushed.
   */
  readonly snapshotId?: number;
}

/** Path "a/b/c" → segments. ProposedFolderPath already bounded depth/names. */
function segmentsOf(path: string): readonly string[] {
  return path.split("/");
}

/**
 * Resolve every proposed path against the LIVE tree, creating missing
 * folders parents-first under `rootId`. Existing folders whose full path
 * matches a proposed path are reused — never duplicated. Returns the
 * path → folder id map plus the ids this call created (undo cleanup).
 */
async function ensureFolders(
  proposal: RestructureProposal,
  rootId: string,
  created: string[],
): Promise<Map<string, string>> {
  const rootNode = (await get(rootId))[0];
  // All paths, longest-prefix sorted so parents precede children.
  const paths = proposal.folders
    .map((f) => f.path)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const pathToId = new Map<string, string>();
  for (const path of paths) {
    const segments = segmentsOf(path);
    let parentId = rootId;
    let walked = "";
    for (const [depth, segment] of segments.entries()) {
      walked = walked === "" ? segment : `${walked}/${segment}`;
      const known = pathToId.get(walked);
      if (known !== undefined) {
        parentId = known;
        continue;
      }
      if (depth === 0 && rootNode?.title === segment) {
        pathToId.set(walked, rootId);
        parentId = rootId;
        continue;
      }
      // Reuse a same-named folder under the resolved parent, else create.
      const siblings = await getChildren(parentId);
      const existing = siblings.find(
        (s) => isFolder(s) && s.title === segment && s.unmodifiable !== "managed",
      );
      if (existing !== undefined) {
        pathToId.set(walked, existing.id);
        parentId = existing.id;
        continue;
      }
      const createdNode = await createFolder({ parentId, title: segment });
      pathToId.set(walked, createdNode.id);
      created.push(createdNode.id);
      parentId = createdNode.id;
    }
  }
  return pathToId;
}

/**
 * Apply a completed `restructure` job's plan, revalidated against the full
 * live tree. `acceptedBookmarkIds` is the reviewed set the user confirmed
 * (absent ⇒ every resolved row) — it is intersected with the rows that are
 * still resolvable, never used to shrink the read scope. Throws `ApplyError`:
 * `read_failed` before any write when the tree read fails; `stale` when no
 * reviewed assignment remains; on a mid-apply mutation failure it replays the
 * moves already made back to their captured positions and removes the folders
 * it created, then throws `mutation_failed`.
 */
export async function applyRestructurePlan(
  jobId: string,
  acceptedBookmarkIds?: readonly string[],
): Promise<ApplyResult> {
  const job = await getJob(jobId);
  if (job === undefined || job.kind !== "restructure" || job.restructure === undefined) {
    throw new ApplyError("invalid_job", "Not a restructure job.");
  }
  if (job.status !== "completed") {
    throw new ApplyError(
      "not_ready",
      `A restructure plan applies only after the job completes (now ${job.status}).`,
    );
  }
  // J13: the effective plan merges committed `restructureAssignments` rows
  // with any legacy inline assignments — `restructure` itself was checked
  // above, so the merged plan is present.
  const plan = (await restructurePlanFor(job))!;
  // Live-tree revalidation over the FULL library (bar + Other + Mobile), the
  // same scope the preview/status replies build their diff from, so moves act
  // on current positions and no reviewed assignment is dropped for living
  // outside the bar. A read failure (or an empty read, which `getTree()`
  // never legitimately returns) is a typed refusal: treating it as "no
  // bookmarks" would silently shrink the reviewed scope to nothing.
  let tree: BookmarksTreeNode[];
  try {
    tree = await getTree();
  } catch (cause) {
    throw new ApplyError(
      "read_failed",
      "The bookmark tree could not be read; nothing was changed.",
      { cause },
    );
  }
  if (tree.length === 0) {
    throw new ApplyError(
      "read_failed",
      "The bookmark tree read came back empty; nothing was changed.",
    );
  }
  const diff = buildRestructureDiff(tree, plan);
  const acceptedSet =
    acceptedBookmarkIds !== undefined ? new Set(acceptedBookmarkIds) : null;
  const resolved = diff.rows.filter(
    (r) =>
      r.status === "resolved" &&
      (acceptedSet === null || acceptedSet.has(r.bookmarkId)),
  );
  if (resolved.length === 0) {
    throw new ApplyError("stale", "No resolved assignments remain to apply.");
  }

  // Same-context serialization first (in-worker promise chain), then the
  // extension-wide undo lock (cross-context + undo-replay exclusion): a
  // second CONFIRM — same context or another surface — queues behind an
  // in-flight apply and then replays the persisted terminal record.
  return serializeApply(jobId, () =>
    withUndoLock(async () => {
      const fresh = await getJob(jobId);
    const freshPlan = fresh?.restructure;
    if (freshPlan?.applied !== undefined) {
      const applied = freshPlan.applied;
      // The terminal record replays only while its snapshot still exists:
      // an UNDO (or discard) that popped it reverted the apply, so a fresh
      // CONFIRM is a real re-apply, not a replay. `moved === 0` records
      // carry no snapshot — nothing can undo them — and always replay.
      const stillApplied =
        applied.snapshotId === undefined ||
        (await db.undo.get(applied.snapshotId)) !== undefined;
      if (stillApplied) {
        return {
          moved: applied.moved,
          reusedPaths: applied.reusedPaths,
          snapshotId: applied.snapshotId,
        };
      }
    }

    const createdFolderIds: string[] = [];
    const moved: Array<{ id: string; parentId: string; index: number }> = [];
    try {
      const pathToId = await ensureFolders(plan.proposal, BOOKMARKS_BAR_ID, createdFolderIds);
      const reusedPaths = plan.proposal.folders
        .map((f) => f.path)
        .filter((p) => !createdFolderIds.includes(pathToId.get(p) ?? ""));

      // Resolve every row's live target BEFORE pushing a snapshot: a batch
      // whose bookmarks already sit at their proposed folders moves nothing
      // and must not leave an empty-effect undo entry behind.
      const pending: Array<{
        id: string;
        targetParentId: string;
        from: { parentId: string; index: number };
      }> = [];
      for (const row of resolved) {
        const targetParentId = pathToId.get(row.toPath!);
        if (targetParentId === undefined) {
          throw new ApplyError(
            "stale",
            `Proposed path ${JSON.stringify(row.toPath)} did not resolve to a folder.`,
          );
        }
        const before = (await get(row.bookmarkId))[0];
        if (before === undefined) {
          throw new ApplyError("stale", `Bookmark ${JSON.stringify(row.bookmarkId)} is gone.`);
        }
        if (before.parentId === targetParentId) {
          continue;
        }
        pending.push({
          id: row.bookmarkId,
          targetParentId,
          from: { parentId: before.parentId!, index: before.index ?? 0 },
        });
      }

      let snapshotId: number | undefined;
      if (pending.length === 0) {
        // Nothing to move — the folders created above are empty by
        // construction, so remove them best-effort (a raced child or an
        // unreadable node leaves it; it never held a moved bookmark).
        for (const id of [...createdFolderIds].reverse()) {
          try {
            const children = await getChildren(id);
            if (children.length !== 0) continue;
            await removeNode(id);
          } catch {
            // Occupied, managed, missing, or unreadable: leave it.
          }
        }
      } else {
        // Pre-move capture of exactly the bookmarks about to move — the undo
        // snapshot's `nodes`, pushed before any mutation.
        const capture = await captureNodes(pending.map((p) => p.id));
        // Per-node targets (D09): undo skips a node moved again afterwards.
        const targetById = new Map(
          pending.map((p) => [p.id, p.targetParentId] as const),
        );
        snapshotId = await pushSnapshot({
          kind: "restructure",
          nodes: capture.nodes.map((node) => ({
            ...node,
            movedToParentId: targetById.get(node.id),
          })),
          meta: capture.meta,
          createdFolderIds,
          origin: "decision",
        });

        for (const p of pending) {
          const destIndex = (await getChildren(p.targetParentId)).length;
          await moveNode(p.id, { parentId: p.targetParentId, index: destIndex });
          moved.push({ id: p.id, parentId: p.from.parentId, index: p.from.index });
        }
      }

      const applied = {
        at: new Date().toISOString(),
        moved: moved.length,
        ...(snapshotId === undefined ? {} : { snapshotId }),
        reusedPaths,
      };
      await db.jobs.update(jobId, {
        restructure: { ...freshPlan!, applied },
      });
      return { moved: moved.length, reusedPaths, snapshotId };
    } catch (cause) {
    // Compensating rollback: replay moved bookmarks back to their captured
    // positions, then remove confirmed-empty created folders bottom-up.
    // Failed reads never authorize deletion; non-recursive removal also
    // protects children inserted between the emptiness check and removal.
    // Keep the snapshot, especially when an inverse move or cleanup fails.
      for (const m of [...moved].reverse()) {
        await moveNode(m.id, { parentId: m.parentId, index: m.index }).catch(() => {});
      }
      for (const id of [...createdFolderIds].reverse()) {
        try {
          const children = await getChildren(id);
          if (children.length !== 0) continue;
          await removeNode(id);
        } catch {
          // Occupied, managed, missing, or unreadable: leave it for undo.
        }
      }
      if (cause instanceof ApplyError) throw cause;
      if (cause instanceof MutationError) {
        throw new ApplyError("mutation_failed", cause.message, { cause });
      }
      throw new ApplyError("mutation_failed", "The apply failed midway.", { cause });
    }
    }),
  );
}

/**
 * Undo a specific restructure apply — the `snapshotId` a `RESTRUCTURE_CONFIRM`
 * reply returned. Thin wrapper over the undo stack's `undoExpected`: the
 * snapshot replays only when it is verifiably the stack head, so a stale id
 * (another apply or undo landed on top) is refused with `conflict` instead
 * of replaying someone else's undoable action.
 */
export function undoRestructurePlan(snapshotId: number): ReturnType<typeof undoExpected> {
  return undoExpected(snapshotId);
}

export { db as _dbForTests };
