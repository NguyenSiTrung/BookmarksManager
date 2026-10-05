import "fake-indexeddb/auto";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { db } from "../../src/db/database";
import type { DecisionRow } from "../../src/decisions/store";
import type { UndoNode, UndoSnapshot } from "../../src/schemas/undo";
import {
  listSnapshots,
  peekLatest,
  pushSnapshot,
  UNDO_NODE_BUDGET,
  UNDO_STACK_LIMIT,
} from "../../src/undo/snapshot";

/**
 * D05/D06 — undo retention and head reads.
 *
 * D05: retention is PER ORIGIN (`user` UI pushes vs `decision` applies), so a
 * burst of decision approvals can never evict the snapshot a user just took;
 * a row a live decision still references is never evicted; and each origin
 * carries a total-node bound on top of the row cap.
 *
 * D06: `peekLatest` walks a reverse cursor one row at a time — the newest
 * VALID row — instead of loading and validating the whole stack.
 */

function leaf(id: string): UndoNode {
  return {
    id,
    parentId: "1",
    index: 0,
    title: `T ${id}`,
    url: `https://${id}.example/`,
  };
}

async function push(kind: "user" | "decision", nodeId: string) {
  return pushSnapshot({
    kind: "delete",
    nodes: [leaf(nodeId)],
    meta: [],
    origin: kind,
  });
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.undo.clear();
  await db.decisions.clear();
});

describe("D05 — per-origin retention", () => {
  it("25 decision pushes do not evict a user snapshot (each origin caps itself)", async () => {
    const userId = await push("user", "user-keep");
    for (let i = 0; i < UNDO_STACK_LIMIT + 5; i++) {
      await push("decision", `dec-${i}`);
    }

    // The user bucket is untouched by the decision burst.
    expect(await db.undo.get(userId)).toMatchObject({
      id: userId,
      origin: "user",
    });
    // Both buckets coexist; the decision bucket is capped on its own.
    const rows = await db.undo.toArray();
    expect(rows.length).toBe(UNDO_STACK_LIMIT + 1);
    expect(rows.filter((r) => r.origin === "decision")).toHaveLength(
      UNDO_STACK_LIMIT,
    );
    expect(rows.filter((r) => (r.origin ?? "user") === "user")).toHaveLength(
      1,
    );
  });

  it("a row referenced by a live decision is never evicted, even past the cap", async () => {
    const protectedId = await push("user", "protected");
    // A second user row that is NOT referenced — the eviction order should
    // pick it over the protected one even though both are equally old.
    await push("user", "unprotected");

    const decision = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "move",
      targetFolderId: "folder-x",
      bookmarkIds: ["bm-x"],
      confidence: 0.9,
      status: "applied",
      source: {
        engine: "rule",
        providerId: "test",
        model: "test-1",
        questionSetVersion: "1",
      },
      undoSnapshotId: protectedId,
      createdAt: new Date().toISOString(),
    } as DecisionRow;
    await db.decisions.put(decision);

    // Fill the user bucket past its cap: the protected row must survive
    // while every other old row evicts.
    for (let i = 0; i < UNDO_STACK_LIMIT + 3; i++) {
      await push("user", `fill-${i}`);
    }

    expect(await db.undo.get(protectedId)).toBeDefined();
    const userRows = (await db.undo.toArray()).filter(
      (r) => (r.origin ?? "user") === "user",
    );
    // The protected row survives INSIDE the cap — protection means "never
    // evicted", not "exempt from the count".
    expect(userRows).toHaveLength(UNDO_STACK_LIMIT);
    expect(userRows.some((r) => r.id === protectedId)).toBe(true);
    // The oldest unprotected row was evicted to make room.
    expect(
      userRows.some(
        (r) => (r.nodes[0] as UndoNode | undefined)?.id === "unprotected",
      ),
    ).toBe(false);
  });

  it("a row referenced only by a TERMINAL decision (reverted) is evictable again", async () => {
    const staleRef = await push("user", "was-protected");
    await db.decisions.put({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "move",
      targetFolderId: "folder-x",
      bookmarkIds: ["bm-x"],
      confidence: 0.9,
      status: "reverted",
      source: {
        engine: "rule",
        providerId: "test",
        model: "test-1",
        questionSetVersion: "1",
      },
      undoSnapshotId: staleRef,
      createdAt: new Date().toISOString(),
    } as DecisionRow);

    for (let i = 0; i < UNDO_STACK_LIMIT + 1; i++) {
      await push("user", `new-${i}`);
    }
    expect(await db.undo.get(staleRef)).toBeUndefined();
  });

  it(`each origin is bounded to ${UNDO_NODE_BUDGET} captured nodes, oldest out`, async () => {
    // Two fat snapshots whose combined nodes exceed the per-origin budget.
    const fat1 = await pushSnapshot({
      kind: "delete",
      nodes: Array.from({ length: UNDO_NODE_BUDGET }, (_, i) =>
        leaf(`f1-${i}`),
      ),
      meta: [],
    });
    const fat2 = await pushSnapshot({
      kind: "delete",
      nodes: [leaf("f2-only")],
      meta: [],
    });
    expect(fat2).not.toBe(fat1);
    // fat1 alone filled the budget; pushing fat2 must evict fat1 even
    // though the row cap was not hit.
    expect(await db.undo.get(fat1)).toBeUndefined();
    expect(await db.undo.get(fat2)).toBeDefined();
  });
});

describe("D06 — peekLatest reverse cursor", () => {
  it("returns the newest valid row, walking past corrupt heads", async () => {
    await pushSnapshot({
      kind: "delete",
      nodes: [leaf("oldest-valid")],
      meta: [],
    });
    await pushSnapshot({
      kind: "delete",
      nodes: [leaf("mid-valid")],
      meta: [],
    });
    // Two corrupt rows stacked on top — the cursor must step back twice.
    await db.undo.add({ bogus: true } as unknown as UndoSnapshot);
    await db.undo.add({ alsoBogus: 1 } as unknown as UndoSnapshot);

    const head = await peekLatest();
    expect(head?.nodes[0]?.id).toBe("mid-valid");
    // The stack itself is unchanged — peeking is a read.
    expect(await db.undo.count()).toBe(4);
  });

  it("returns undefined when every row is corrupt", async () => {
    await db.undo.add({ bogus: 1 } as unknown as UndoSnapshot);
    await db.undo.add({ bogus: 2 } as unknown as UndoSnapshot);
    expect(await peekLatest()).toBeUndefined();
  });

  it("matches listSnapshots' newest row when the stack is clean", async () => {
    await push("user", "a");
    await push("user", "b");
    const [head] = await listSnapshots();
    expect(head).toBeDefined();
    expect(await peekLatest()).toMatchObject({ id: head?.id });
  });
});
