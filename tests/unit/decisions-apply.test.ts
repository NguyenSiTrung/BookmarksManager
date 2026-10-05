import "fake-indexeddb/auto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import {
  DecisionApplyError,
  approveDecision,
  bulkApprove,
  rejectDecision,
  revertBatch,
  revertDecision,
} from "../../src/decisions/apply";
import { persistDecision } from "../../src/decisions/store";
import type { DecisionRow } from "../../src/decisions/store";
import { getMeta, putMeta } from "../../src/db/meta";
import { Decision } from "../../src/schemas/decision";
import { get } from "../../src/sync/chrome-bookmarks";
import { moveNode, removeTree } from "../../src/sync/mutations";
import { captureSubtree, peekLatest, pushSnapshot } from "../../src/undo/snapshot";
import { decisionBase } from "../fixtures/base-records";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { removeWebLocksFake } from "../fakes/web-locks";

/**
 * Coverage for `src/decisions/apply.ts` — approve (which applies through the
 * guarded mutation service, tag ops, or the duplicate merge, each behind an
 * undo snapshot), reject, revert, and bulk approve, plus the stale-decision
 * refusal and the per-transition audit row (spec FR6).
 *
 * Seeded tree:
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ f-target            (folder "Target")
 * │  ├─ bm-a   https://a.example/
 * │  ├─ bm-b   https://b.example/
 * │  ├─ bm-c   https://dup.example/
 * │  └─ bm-d   https://dup.example/
 * └─ 2 Other bookmarks
 * ```
 */

let nextId = 0;
function uuid(): string {
  nextId += 1;
  const tail = String(nextId).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}

function decision(over: Partial<Decision> = {}): Decision {
  return Decision.parse({
    ...decisionBase,
    kind: "set_category",
    category: "article",
    id: uuid(),
    bookmarkIds: ["bm-a"],
    ...over,
  });
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  installBookmarksFake({
    bookmarksBar: [
      { id: "f-target", title: "Target" },
      { id: "bm-a", title: "A", url: "https://a.example/" },
      { id: "bm-b", title: "B", url: "https://b.example/" },
      { id: "bm-c", title: "C", url: "https://dup.example/" },
      { id: "bm-d", title: "D", url: "https://dup.example/" },
    ],
  });
  await db.decisions.clear();
  await db.audit.clear();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

async function expectApplyError(
  fn: () => Promise<unknown>,
  code: string,
): Promise<DecisionApplyError> {
  try {
    await fn();
  } catch (cause) {
    expect(cause).toBeInstanceOf(DecisionApplyError);
    expect((cause as DecisionApplyError).code).toBe(code);
    return cause as DecisionApplyError;
  }
  throw new Error(`expected a DecisionApplyError(${code}), but it resolved`);
}

/**
 * Pause `db.undo.get` — the read `restoreById` performs (D07) — so a test
 * can push an unrelated snapshot into the window between a caller's read
 * and its replay. A by-id fetch can't be fooled by an intervening PUSH the
 * way a head check can, but pausing it still proves the "decoy lands
 * mid-flight" case: the replay pops only the row it read, never the
 * injected one. Returns a handle to observe the pause and release it.
 *
 * Dexie resolves a `PromiseExtended`, so the gate chains on the real
 * promise; an `async` wrapper would return a plain promise and fail the
 * spy's type. (The gate must NOT touch `db.undo.toArray`: `pushSnapshot`
 * calls it inside its own transaction, and awaiting a foreign promise in
 * there would trip a PrematureCommit abort.)
 */
function gateFirstUndoGet(): { delayed: () => boolean; release: () => void } {
  const realGet = db.undo.get.bind(db.undo);
  let delayed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(db.undo, "get").mockImplementation((key: Parameters<typeof db.undo.get>[0]) =>
    realGet(key).then((row) => {
      if (delayed) return row;
      delayed = true;
      return gate.then(() => row);
    }),
  );
  return { delayed: () => delayed, release };
}

// ---------------------------------------------------------------------------
// approve — add_tags
// ---------------------------------------------------------------------------

describe("approveDecision — add_tags", () => {
  it("adds every tag through the tag-ops service and marks the row applied", async () => {
    await putMeta("bm-a", { notes: "keep me" });
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["Rust", "Web"] }),
    );
    const row = await approveDecision(d.id);
    expect(row.status).toBe("applied");
    const meta = await getMeta("bm-a");
    expect(meta?.tags).toEqual(["rust", "web"]);
    expect(meta?.notes).toBe("keep me");
  });

  it("pushes the meta snapshot and writes exactly one audit row", async () => {
    await putMeta("bm-a", { tags: ["old"] });
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["new"] }),
    );
    await approveDecision(d.id);
    const snapshot = await peekLatest();
    expect(snapshot?.kind).toBe("delete");
    expect(snapshot?.nodes).toEqual([]);
    expect(snapshot?.meta.map((m) => m.id)).toEqual(["bm-a"]);
    expect(snapshot?.meta[0]?.tags).toEqual(["old"]);
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decisionId: d.id, from: "pending", to: "applied", actor: "user" });
    expect(Object.keys(audit[0] as object).sort()).toEqual(
      ["actor", "changedAt", "decisionId", "from", "id", "to"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// approve — set_category
// ---------------------------------------------------------------------------

describe("approveDecision — set_category", () => {
  it("sets the category through the tag-ops service with an undo snapshot", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "docs" }),
    );
    const row = await approveDecision(d.id);
    expect(row.status).toBe("applied");
    expect((await getMeta("bm-a"))?.category).toBe("docs");
    expect((await peekLatest())?.kind).toBe("delete");
  });
});

// ---------------------------------------------------------------------------
// approve — move
// ---------------------------------------------------------------------------

describe("approveDecision — move", () => {
  it("moves the bookmark through moveNode and snapshots its position", async () => {
    const d = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-b"], targetFolderId: "f-target" }),
    );
    const row = await approveDecision(d.id);
    expect(row.status).toBe("applied");
    expect((await get("bm-b"))[0]?.parentId).toBe("f-target");
    const snapshot = await peekLatest();
    expect(snapshot?.kind).toBe("bulk_move");
    expect(snapshot?.nodes[0]).toMatchObject({ id: "bm-b", parentId: "1" });
  });
});

// ---------------------------------------------------------------------------
// approve — merge_duplicates
// ---------------------------------------------------------------------------

describe("approveDecision — merge_duplicates", () => {
  it("merges through mergeGroup, deleting the losers", async () => {
    const d = await persistDecision(
      decision({
        kind: "merge_duplicates",
        bookmarkIds: ["bm-c", "bm-d"],
        keepId: "bm-c",
      }),
    );
    const row = await approveDecision(d.id);
    expect(row.status).toBe("applied");
    await expect(get("bm-d")).rejects.toThrow();
    expect((await get("bm-c"))[0]?.id).toBe("bm-c");
    // mergeGroup pushed its own merge snapshot.
    expect((await peekLatest())?.kind).toBe("merge");
  });

  it("records the merge snapshot's own id even when another snapshot interleaves (D04)", async () => {
    // A foreign context pushes a snapshot between mergeGroup's push and the
    // decision's snapshot recording — the recorded undoSnapshotId must be
    // the merge row's, not whatever sits at the head.
    const realAdd = db.undo.add.bind(db.undo);
    let mergeSnapshotId: number | undefined;
    const spy = vi.spyOn(db.undo, "add").mockImplementation((row) => {
      const pushed = (async () => {
        const id = await realAdd(row as never);
        if ((row as { kind?: string }).kind === "merge") {
          mergeSnapshotId = Number(id);
          // Simulate the interleave: the head moves to a foreign snapshot.
          await pushSnapshot({ kind: "delete", nodes: [], meta: [] });
        }
        return id;
      })();
      return pushed as never;
    });
    try {
      const d = await persistDecision(
        decision({
          kind: "merge_duplicates",
          bookmarkIds: ["bm-c", "bm-d"],
          keepId: "bm-c",
        }),
      );
      const row = await approveDecision(d.id);
      expect(mergeSnapshotId).toBeDefined();
      expect(row.status).toBe("applied");
      expect(row.undoSnapshotId).toBe(mergeSnapshotId);
      // The head IS the foreign decoy — under the old peekLatest() read this
      // is the id that would have been recorded instead.
      expect((await peekLatest())?.kind).toBe("delete");
      // The recorded id resolves to the merge row — the decoy's id, by
      // contrast, would point at an empty delete snapshot.
      const recorded = await db.undo.get(row.undoSnapshotId as number);
      expect(recorded?.kind).toBe("merge");
      expect(
        (recorded?.nodes as { id: string }[]).map((n) => n.id),
      ).toEqual(["bm-d"]);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// approve — auto_applied target (policy auto-apply)
// ---------------------------------------------------------------------------

describe("approveDecision — auto_applied target", () => {
  it("records the auto_applied status and audit row for the policy actor", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    const row = await approveDecision(d.id, "policy", "auto_applied");
    expect(row.status).toBe("auto_applied");
    expect((await getMeta("bm-a"))?.tags).toEqual(["x"]);
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      decisionId: d.id,
      from: "pending",
      to: "auto_applied",
      actor: "policy",
    });
  });

  it("reverts an auto_applied row via its recorded snapshot", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "docs" }),
    );
    await approveDecision(d.id, "policy", "auto_applied");
    const row = await revertDecision(d.id);
    expect(row.status).toBe("reverted");
    expect(await getMeta("bm-a")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe("rejectDecision", () => {
  it("marks the row rejected without touching the tree and audits it", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    const row = await rejectDecision(d.id);
    expect(row.status).toBe("rejected");
    expect(await getMeta("bm-a")).toBeUndefined();
    expect(await peekLatest()).toBeUndefined();
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ to: "rejected", from: "pending" });
  });

});

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

describe("revertDecision", () => {
  it("reverts an applied tag change using the recorded undo snapshot", async () => {
    await putMeta("bm-a", { tags: ["old"] });
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["new"] }),
    );
    await approveDecision(d.id);
    const row = await revertDecision(d.id);
    expect(row.status).toBe("reverted");
    expect((await getMeta("bm-a"))?.tags).toEqual(["old"]);
  });

  it("reverts an applied move back to the original folder", async () => {
    const d = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-b"], targetFolderId: "f-target" }),
    );
    await approveDecision(d.id);
    const row = await revertDecision(d.id);
    expect(row.status).toBe("reverted");
    expect((await get("bm-b"))[0]?.parentId).toBe("1");
  });

  it("deletes meta-less rows entirely and audits the revert transition", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "docs" }),
    );
    await approveDecision(d.id);
    await revertDecision(d.id);
    expect(await getMeta("bm-a")).toBeUndefined();
    const audit = await db.audit.toArray();
    expect(audit.map((a) => a.to)).toEqual(["applied", "reverted"]);
  });

  it("refuses rows that were never applied or carry no snapshot", async () => {
    const pending = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await expectApplyError(() => revertDecision(pending.id), "illegal_transition");
    const noSnap = await persistDecision(
      decision({
        kind: "add_tags",
        bookmarkIds: ["bm-a"],
        tags: ["x"],
        status: "applied",
      }),
    );
    await expectApplyError(() => revertDecision(noSnap.id), "invalid");
  });

  it("reverts mid-stack — an unrelated snapshot on top is left in place (D07)", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
    // An unrelated snapshot pushed on top of the decision's own snapshot:
    // `restoreById` still replays exactly the recorded row (D07) — the
    // head-ness refusal was the same false-negative the toast had.
    const interloper = await pushSnapshot({ kind: "delete", nodes: [], meta: [] });
    await revertDecision(d.id);
    // The decision's tags came off; the unrelated snapshot is untouched.
    // (Empty row → lazy-row rule may delete the row entirely.)
    expect((await getMeta("bm-a"))?.tags ?? []).toEqual([]);
    expect((await peekLatest())?.id).toBe(interloper);
  });

});

// ---------------------------------------------------------------------------
// illegal transitions
// ---------------------------------------------------------------------------

describe("illegal transitions", () => {
  it("refuses reverted rows, unsupported kinds, unknown ids, and applied rows", async () => {
    const reverted = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(reverted.id);
    await revertDecision(reverted.id);
    const err = await expectApplyError(() => approveDecision(reverted.id), "illegal_transition");
    expect(err.message).toMatch(/reverted/);
    const unsupported = await persistDecision(
      decision({ kind: "rename", bookmarkIds: ["bm-a"], newTitle: "Renamed" }),
    );
    await expectApplyError(() => approveDecision(unsupported.id), "unsupported");
    expect((await get("bm-a"))[0]?.title).toBe("A");
    await expectApplyError(() => approveDecision(uuid()), "not_found");
    const applied = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(applied.id);
    await expectApplyError(() => rejectDecision(applied.id), "illegal_transition");
  });
});

// ---------------------------------------------------------------------------
// stale decisions
// ---------------------------------------------------------------------------

describe("stale decisions", () => {
  it("refuses gone bookmarks and bookmarks moved since the decision", async () => {
    const gone = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-ghost"], targetFolderId: "f-target" }),
    );
    const goneErr = await expectApplyError(() => approveDecision(gone.id), "stale");
    expect(goneErr.staleReason).toBe("bookmark_gone");
    expect((await db.decisions.get(gone.id))?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
    const moved = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-b"], targetFolderId: "f-target" }),
    );
    // The user moves the bookmark elsewhere between decision and review.
    await moveNode("bm-b", { parentId: "2" });
    const movedErr = await expectApplyError(() => approveDecision(moved.id), "stale");
    expect(movedErr.staleReason).toBe("bookmark_moved");
    expect((await get("bm-b"))[0]?.parentId).toBe("2"); // not applied blindly
  });
});

// ---------------------------------------------------------------------------
// rollback / compensation
// ---------------------------------------------------------------------------

describe("apply rollback and compensation", () => {
  it("discards the pushed snapshot by id when the first tag op fails", async () => {
    // A blank tag normalizes to an empty nameKey → bulkAddTag fails invalid_tag
    // before anything was applied, so there is nothing to restore.
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["   "] }),
    );
    await expectApplyError(() => approveDecision(d.id), "invalid_tag");
    expect(await peekLatest()).toBeUndefined(); // snapshot discarded
    expect(await getMeta("bm-a")).toBeUndefined();
    expect((await db.decisions.get(d.id))?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("undoes the tags already applied when a later tag op fails mid-way", async () => {
    await putMeta("bm-a", { tags: ["old"] });
    const d = await persistDecision(
      decision({
        kind: "add_tags",
        bookmarkIds: ["bm-a"],
        tags: ["one", "   "], // second fails after the first is applied
      }),
    );
    await expectApplyError(() => approveDecision(d.id), "invalid_tag");
    // The partially-applied change is compensated, not left orphaned.
    expect((await getMeta("bm-a"))?.tags).toEqual(["old"]);
    expect(await peekLatest()).toBeUndefined(); // snapshot replayed and popped
    expect((await db.decisions.get(d.id))?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("undoes the mutation when the status/audit write fails afterwards", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    const addSpy = vi
      .spyOn(db.audit, "add")
      .mockRejectedValue(new Error("audit write failed"));
    await expectApplyError(() => approveDecision(d.id), "api");
    addSpy.mockRestore();
    // No orphaned, un-revertable mutation: the tag is undone and the row
    // stays pending with no audit row.
    expect(await getMeta("bm-a")).toBeUndefined();
    expect(await peekLatest()).toBeUndefined();
    expect((await db.decisions.get(d.id))?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("replays its own snapshot, never a head another context pushed mid-revert", async () => {
    const d = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-b"], targetFolderId: "f-target" }),
    );
    await approveDecision(d.id);
    expect((await get("bm-b"))[0]?.parentId).toBe("f-target");

    const decoy = await captureSubtree("bm-c");
    if (decoy === undefined) throw new Error("missing fixture node bm-c");

    // Pause the revert's by-id read (`restoreById`'s `db.undo.get`); an
    // unrelated snapshot lands mid-flight — the replay must still target
    // only the row it read.
    const read = gateFirstUndoGet();

    const reverting = revertDecision(d.id);
    await vi.waitFor(() => expect(read.delayed()).toBe(true));
    const decoyId = await pushSnapshot({
      kind: "delete",
      nodes: [decoy.node],
      meta: [],
    });
    await removeTree("bm-c");
    read.release();

    const row = await reverting;
    expect(row.status).toBe("reverted");
    // Its own change was undone …
    expect((await get("bm-b"))[0]?.parentId).toBe("1");
    // … and the unrelated snapshot was neither replayed nor popped.
    expect((await peekLatest())?.id).toBe(decoyId);
    await expect(get("bm-c")).rejects.toThrow();
  });

  it("compensates its own snapshot, never a head pushed during a failed status write", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    const decoy = await captureSubtree("bm-b");
    if (decoy === undefined) throw new Error("missing fixture node bm-b");

    // The status/audit write fails, so the apply must compensate its change.
    vi.spyOn(db.audit, "add").mockRejectedValue(new Error("audit write failed"));

    // Same mid-flight gate on the compensate path's `restoreById` read.
    const read = gateFirstUndoGet();

    const approving = approveDecision(d.id);
    await vi.waitFor(() => expect(read.delayed()).toBe(true));
    const decoyId = await pushSnapshot({
      kind: "delete",
      nodes: [decoy.node],
      meta: [],
    });
    await removeTree("bm-b");
    read.release();

    await expectApplyError(() => approving, "api");
    // Its own mutation was compensated …
    expect(await getMeta("bm-a")).toBeUndefined();
    // … and the unrelated snapshot was neither replayed nor popped.
    expect((await peekLatest())?.id).toBe(decoyId);
    await expect(get("bm-b")).rejects.toThrow();
  });

  it("maps an unusable undo lock onto undo_conflict, mutating nothing", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "docs" }),
    );
    await approveDecision(d.id);
    expect((await getMeta("bm-a"))?.category).toBe("docs");
    removeWebLocksFake();

    const error = await expectApplyError(
      () => revertDecision(d.id),
      "undo_conflict",
    );

    expect(error.message).toMatch(/no longer available/);
    // Zero mutations: the change is still applied and the row still says so.
    expect((await getMeta("bm-a"))?.category).toBe("docs");
    expect((await db.decisions.get(d.id))?.status).toBe("applied");
    expect(await peekLatest()).toBeDefined();
  });

  it("reports state_unrecorded when a failed status write cannot be compensated", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    vi.spyOn(db.audit, "add").mockRejectedValue(new Error("audit write failed"));
    // No lock, no compensation: the apply must say so instead of pretending.
    removeWebLocksFake();

    await expectApplyError(() => approveDecision(d.id), "state_unrecorded");

    // The change is applied but unrecorded — reported, never silent.
    expect((await getMeta("bm-a"))?.tags).toEqual(["x"]);
    expect((await db.decisions.get(d.id))?.status).toBe("pending");
    expect((await peekLatest())?.meta.map((meta) => meta.id)).toEqual(["bm-a"]);
  });
});

// ---------------------------------------------------------------------------
// bulk approve
// ---------------------------------------------------------------------------

describe("revertBatch", () => {
  it("reverts each row independently, in reverse order, one failure does not block the rest", async () => {
    const first = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["one"] }),
    );
    const second = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-b"], tags: ["two"] }),
    );
    const pending = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-c"], tags: ["three"] }),
    );
    const applied = await bulkApprove([first.id, second.id]);
    expect(applied.applied).toHaveLength(2);

    const result = await revertBatch([first.id, pending.id, second.id]);
    expect(result.ok).toBe(true);
    // Reverse order: second's row reverts first, then first; the pending
    // row reports illegal_transition without blocking either.
    expect(result.reverted).toEqual([second.id, first.id]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: pending.id, code: "illegal_transition" }),
    ]);
    expect((await getMeta("bm-a"))?.tags ?? []).toEqual([]);
    expect((await getMeta("bm-b"))?.tags ?? []).toEqual([]);
    expect((await db.decisions.get(pending.id))?.status).toBe("pending");
  });

  it("collapses duplicate ids and reports an empty result for no input", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
    const result = await revertBatch([d.id, d.id]);
    expect(result.reverted).toHaveLength(1);
    expect((await revertBatch([])).reverted).toEqual([]);
  });
});

describe("bulkApprove", () => {
  it("applies each row independently — one stale row does not corrupt the rest", async () => {
    const ok = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["bulk"] }),
    );
    const stale = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-ghost"], targetFolderId: "f-target" }),
    );
    const result = await bulkApprove([ok.id, stale.id]);
    expect(result.ok).toBe(true);
    expect(result.applied.map((r) => r.id)).toEqual([ok.id]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: stale.id, code: "stale" }),
    ]);
    expect((await getMeta("bm-a"))?.tags).toEqual(["bulk"]);
    expect((await db.decisions.get(stale.id))?.status).toBe("pending");
    // One audit row per successful transition only.
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.decisionId).toBe(ok.id);
  });

  it("collapses duplicate ids and reports an empty result for no input", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    const result = await bulkApprove([d.id, d.id]);
    expect(result.applied).toHaveLength(1);
    expect((await bulkApprove([])).applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J06 — per-decision mutual exclusion
// ---------------------------------------------------------------------------

describe("mutual exclusion (J06)", () => {
  /** Read a row WITH its additive sidecars — the table's type is the schema doc. */
  const getRow = (id: string): Promise<DecisionRow | undefined> =>
    db.decisions.get(id) as Promise<DecisionRow | undefined>;

  /** Write a `claim` sidecar directly — the update path cannot type sidecars. */
  async function seedClaim(
    id: string,
    claim: { token: string; at: string },
  ): Promise<void> {
    const row = await getRow(id);
    if (row === undefined) throw new Error("no such decision");
    await db.decisions.put({ ...row, claim } as DecisionRow);
  }

  it("serializes a concurrent double approve — one applies, one refuses", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["once"] }),
    );

    const settled = await Promise.allSettled([
      approveDecision(d.id),
      approveDecision(d.id),
    ]);

    const applied = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s) => s.status === "rejected");
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const loser = (refused[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DecisionApplyError);
    // The loser serialized behind the winner, re-read the row, and saw
    // `applied` — or met a live store claim. Either refusal is honest.
    expect(["illegal_transition", "claimed"]).toContain(
      (loser as DecisionApplyError).code,
    );

    // Exactly one mutation, one status write, one audit row.
    expect((await getMeta("bm-a"))?.tags).toEqual(["once"]);
    expect((await db.decisions.get(d.id))?.status).toBe("applied");
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    expect((await db.undo.toArray()).length).toBe(1);
  });

  it("serializes approve-vs-reject — exactly one side lands", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "article" }),
    );

    const settled = await Promise.allSettled([
      approveDecision(d.id),
      rejectDecision(d.id),
    ]);

    const applied = settled.filter((s) => s.status === "fulfilled");
    expect(applied).toHaveLength(1);
    const loser = (settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(DecisionApplyError);
    expect(["illegal_transition", "claimed"]).toContain(
      (loser as DecisionApplyError).code,
    );

    const row = await getRow(d.id);
    expect(["applied", "rejected"]).toContain(row?.status);
    expect(await db.audit.count()).toBe(1);
    // No claim residue on the decided row.
    expect(row?.claim).toBeUndefined();
  });

  it("refuses with `claimed` when a live store claim owns the row", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    // Another context's in-flight op — a fresh claim nobody here holds.
    await seedClaim(d.id, {
      token: "foreign-token",
      at: new Date().toISOString(),
    });

    await expectApplyError(() => approveDecision(d.id), "claimed");
    await expectApplyError(() => rejectDecision(d.id), "claimed");
    const row = await getRow(d.id);
    expect(row?.status).toBe("pending");
    // The foreign claim was never touched.
    expect(row?.claim?.token).toBe("foreign-token");
    expect((await getMeta("bm-a"))?.tags).toBeUndefined();
    expect(await db.audit.count()).toBe(0);
  });

  it("reclaims an expired claim — a crashed context never wedges the row", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await seedClaim(d.id, {
      token: "abandoned",
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const row = await approveDecision(d.id);
    expect(row.status).toBe("applied");
    expect(row.claim).toBeUndefined();
    expect((await getMeta("bm-a"))?.tags).toEqual(["x"]);
  });

  it("releases its claim when the apply is refused stale", async () => {
    // A send-time guard snapshotting the URL the decision was made from.
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
      {
        guard: {
          placements: {},
          snapshots: { "bm-a": { url: "https://a.example/", title: "A" } },
        },
      },
    );
    // Edit the bookmark after the decision — the guard goes stale.
    installBookmarksFake({
      bookmarksBar: [
        { id: "f-target", title: "Target" },
        { id: "bm-a", title: "A", url: "https://edited.example/" },
      ],
    });

    await expectApplyError(() => approveDecision(d.id), "stale");
    const row = await getRow(d.id);
    expect(row?.status).toBe("pending");
    // The failed approve released its claim — the row is clean and a later
    // caller (e.g. reject) is not wedged.
    expect(row?.claim).toBeUndefined();
    await rejectDecision(d.id);
    expect((await getRow(d.id))?.status).toBe("rejected");
  });
});
