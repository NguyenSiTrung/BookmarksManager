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
  revertDecision,
} from "../../src/decisions/apply";
import { persistDecision } from "../../src/decisions/store";
import { getMeta, putMeta } from "../../src/db/meta";
import { Decision } from "../../src/schemas/decision";
import { get } from "../../src/sync/chrome-bookmarks";
import { moveNode } from "../../src/sync/mutations";
import { peekLatest } from "../../src/undo/snapshot";
import { decisionBase } from "../fixtures/base-records";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

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

  it("pushes a meta undo snapshot capturing the pre-change rows", async () => {
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
  });

  it("writes exactly one audit row for the transition", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
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

  it("refuses to reject an already-applied row", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
    await expectApplyError(() => rejectDecision(d.id), "illegal_transition");
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

  it("deletes the row's meta entirely when there was no prior meta", async () => {
    const d = await persistDecision(
      decision({ kind: "set_category", bookmarkIds: ["bm-a"], category: "docs" }),
    );
    await approveDecision(d.id);
    await revertDecision(d.id);
    expect(await getMeta("bm-a")).toBeUndefined();
  });

  it("refuses to revert a decision that was never applied", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await expectApplyError(() => revertDecision(d.id), "illegal_transition");
  });

  it("writes an audit row for the revert transition", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
    await revertDecision(d.id);
    const audit = await db.audit.toArray();
    expect(audit.map((a) => a.to)).toEqual(["applied", "reverted"]);
  });
});

// ---------------------------------------------------------------------------
// illegal transitions
// ---------------------------------------------------------------------------

describe("illegal transitions", () => {
  it("refuses to approve an already-reverted row", async () => {
    const d = await persistDecision(
      decision({ kind: "add_tags", bookmarkIds: ["bm-a"], tags: ["x"] }),
    );
    await approveDecision(d.id);
    await revertDecision(d.id);
    const err = await expectApplyError(() => approveDecision(d.id), "illegal_transition");
    expect(err.message).toMatch(/reverted/);
  });

  it("refuses to approve an unsupported decision kind", async () => {
    const d = await persistDecision(
      decision({ kind: "rename", bookmarkIds: ["bm-a"], newTitle: "Renamed" }),
    );
    await expectApplyError(() => approveDecision(d.id), "unsupported");
    expect((await get("bm-a"))[0]?.title).toBe("A");
  });

  it("refuses an unknown decision id", async () => {
    await expectApplyError(() => approveDecision(uuid()), "not_found");
  });
});

// ---------------------------------------------------------------------------
// stale decisions
// ---------------------------------------------------------------------------

describe("stale decisions", () => {
  it("refuses when the bookmark no longer exists", async () => {
    const d = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-ghost"], targetFolderId: "f-target" }),
    );
    const err = await expectApplyError(() => approveDecision(d.id), "stale");
    expect(err.staleReason).toBe("bookmark_gone");
    expect((await db.decisions.get(d.id))?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("refuses when the bookmark moved since the decision was made", async () => {
    const d = await persistDecision(
      decision({ kind: "move", bookmarkIds: ["bm-b"], targetFolderId: "f-target" }),
    );
    // The user moves the bookmark elsewhere between decision and review.
    await moveNode("bm-b", { parentId: "2" });
    const err = await expectApplyError(() => approveDecision(d.id), "stale");
    expect(err.staleReason).toBe("bookmark_moved");
    expect((await get("bm-b"))[0]?.parentId).toBe("2"); // not applied blindly
  });
});

// ---------------------------------------------------------------------------
// bulk approve
// ---------------------------------------------------------------------------

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
