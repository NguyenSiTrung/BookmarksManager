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
  decisionIdFor,
  getDecision,
  listDecisions,
  persistDecision,
  transitionStatus,
} from "../../src/decisions/store";
import {
  DecisionApplyError,
  approveDecision,
} from "../../src/decisions/apply";
import { getMeta } from "../../src/db/meta";
import { Decision } from "../../src/schemas/decision";
import { moveNode } from "../../src/sync/mutations";
import { decisionBase } from "../fixtures/base-records";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * J04 + J05 — decision persistence hardening (track
 * deep_audit_fixes_20261005, Phase 3 Task 3):
 *
 *  - J04: persistence is idempotent per `(jobId, bookmarkIds, kind)` — a
 *    deterministic id makes a replayed batch upsert instead of duplicating —
 *    and a re-analysis supersedes the older undecided rows for the same
 *    bookmark set + kind, whatever job produced them. A row somebody already
 *    decided is final and is never overwritten by a replay.
 *  - J05: the freshness guard is the snapshot the request was SENT from —
 *    the raw parent/url/title at send time, not a later persist-time read —
 *    and `assertFresh` covers url/title for add_tags, set_category and
 *    merge_duplicates (a mid-scan edit is `stale`/`bookmark_edited`).
 *
 * Seeded tree:
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ f-target            (folder "Target")
 * │  ├─ bm-a   https://a.example/    "A"
 * │  ├─ bm-b   https://b.example/    "B"
 * │  ├─ bm-c   https://dup.example/  "C"
 * │  └─ bm-d   https://dup.example/  "D"
 * └─ 2 Other bookmarks
 * ```
 */

const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";
const UUID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const UUID3 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const UUID4 = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";

let fake: FakeBookmarksApi;

function decision(over: Partial<Decision> = {}): Decision {
  return Decision.parse({
    ...decisionBase,
    id: UUID,
    kind: "set_category",
    category: "article",
    bookmarkIds: ["bm-a"],
    ...over,
  });
}

/** Reject with the thrown DecisionApplyError; throws when `fn` resolves. */
async function expectStale(fn: () => Promise<unknown>): Promise<DecisionApplyError> {
  try {
    await fn();
  } catch (cause) {
    expect(cause).toBeInstanceOf(DecisionApplyError);
    expect((cause as DecisionApplyError).code).toBe("stale");
    return cause as DecisionApplyError;
  }
  throw new Error("expected a stale refusal");
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
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
  await db.undo.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// decisionIdFor — the deterministic tuple key (J04)
// ---------------------------------------------------------------------------

describe("decisionIdFor", () => {
  it("is deterministic per (jobId, bookmarkIds, kind) and schema-valid", async () => {
    const first = await decisionIdFor({
      jobId: "job-1",
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    const second = await decisionIdFor({
      jobId: "job-1",
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    expect(first).toBe(second);
    expect(
      Decision.options[0].shape.id.safeParse(first).success,
    ).toBe(true);
  });

  it("changes with every tuple member and is order-free for pairs", async () => {
    const base = await decisionIdFor({
      jobId: "job-1",
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    expect(
      await decisionIdFor({
        jobId: "job-2",
        bookmarkIds: ["bm-a"],
        kind: "set_category",
      }),
    ).not.toBe(base);
    expect(
      await decisionIdFor({
        jobId: "job-1",
        bookmarkIds: ["bm-b"],
        kind: "set_category",
      }),
    ).not.toBe(base);
    expect(
      await decisionIdFor({
        jobId: "job-1",
        bookmarkIds: ["bm-a"],
        kind: "add_tags",
      }),
    ).not.toBe(base);
    // A merge pair is orientation-free: [a,b] and [b,a] are one slot.
    expect(
      await decisionIdFor({
        jobId: "job-1",
        bookmarkIds: ["bm-c", "bm-d"],
        kind: "merge_duplicates",
      }),
    ).toBe(
      await decisionIdFor({
        jobId: "job-1",
        bookmarkIds: ["bm-d", "bm-c"],
        kind: "merge_duplicates",
      }),
    );
    // An interactive analysis (no job) is a stable slot of its own.
    const interactive = await decisionIdFor({
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    expect(interactive).toBe(
      await decisionIdFor({ bookmarkIds: ["bm-a"], kind: "set_category" }),
    );
    expect(interactive).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// persistDecision — idempotent upsert + supersession (J04)
// ---------------------------------------------------------------------------

describe("persistDecision idempotency (J04)", () => {
  it("re-persisting the same tuple rewrites one row, not two", async () => {
    // A replayed batch rebuilds the same deterministic id.
    const id = await decisionIdFor({
      jobId: "job-1",
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    await persistDecision(decision({ id }));
    await persistDecision(decision({ id, confidence: 0.5 }));
    const rows = await listDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBe(0.5);
  });

  it("supersedes older pending rows for the same bookmark and kind", async () => {
    await persistDecision(decision({ confidence: 0.3 }));
    // A re-analysis (a different job → a different deterministic id) of the
    // same bookmark+kind replaces the still-pending row.
    await persistDecision(decision({ id: UUID2, confidence: 0.9 }));
    const rows = await listDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(UUID2);
    expect(await getDecision(UUID)).toBeUndefined();
  });

  it("supersedes an unsure row too, but keeps decided rows and other slots", async () => {
    await persistDecision(decision({ status: "unsure" })); // UUID, bm-a
    // A decided row is NOT superseded — it is the audit record of a decision
    // somebody already made.
    const applied = await persistDecision(
      decision({ id: UUID2, bookmarkIds: ["bm-b"] }),
    );
    await transitionStatus(applied.id, "applied", "user");
    // A different kind on the same bookmark is a different slot.
    await persistDecision(
      decision({ id: UUID3, kind: "add_tags", tags: ["x"] }),
    );
    // The re-analysis supersedes ONLY the unsure bm-a/set_category row.
    await persistDecision(decision({ id: UUID4, confidence: 0.9 }));
    expect(await listDecisions().then((rows) => rows.map((r) => r.id).sort()))
      .toEqual([UUID2, UUID3, UUID4].sort());
    expect(await getDecision(UUID)).toBeUndefined(); // unsure superseded
    expect((await getDecision(UUID2))?.status).toBe("applied"); // kept
  });

  it("a replay never overwrites a decided row: status and undo pointer survive", async () => {
    const id = await decisionIdFor({
      jobId: "job-1",
      bookmarkIds: ["bm-a"],
      kind: "set_category",
    });
    const first = await persistDecision(decision({ id }));
    await transitionStatus(id, "applied", "user", { undoSnapshotId: 7 });
    const replay = await persistDecision(
      decision({ id, confidence: 0.1, status: "pending" }),
    );
    expect(replay.status).toBe("applied");
    expect(replay.undoSnapshotId).toBe(7);
    expect(replay.confidence).toBe(first.confidence); // not clobbered
    expect(await listDecisions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// assertFresh — the sent snapshot covers url/title (J05)
// ---------------------------------------------------------------------------

describe("assertFresh covers the sent url/title (J05)", () => {
  const bmAGuard = {
    placements: { "bm-a": "1" },
    snapshots: { "bm-a": { url: "https://a.example/", title: "A" } },
  };

  it("refuses a retitled bookmark for set_category and add_tags", async () => {
    const category = await persistDecision(decision(), { guard: bmAGuard });
    const tags = await persistDecision(
      decision({ id: UUID2, kind: "add_tags", tags: ["x"] }),
      { guard: bmAGuard },
    );
    // The user edits the bookmark between the analysis and the review.
    await fake.update("bm-a", { title: "A (renamed)" });
    for (const row of [category, tags]) {
      const error = await expectStale(() => approveDecision(row.id));
      expect(error.staleReason).toBe("bookmark_edited");
      expect((await getDecision(row.id))?.status).toBe("pending");
    }
    // Nothing was applied for the skipped rows.
    expect((await getMeta("bm-a"))?.tags ?? []).toEqual([]);
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("refuses a merge side that changed after the scan", async () => {
    const row = await persistDecision(
      Decision.parse({
        ...decisionBase,
        id: UUID,
        kind: "merge_duplicates",
        bookmarkIds: ["bm-c", "bm-d"],
        keepId: "bm-c",
      }),
      {
        guard: {
          placements: {},
          snapshots: {
            "bm-c": { url: "https://dup.example/", title: "C" },
            "bm-d": { url: "https://dup.example/", title: "D" },
          },
        },
      },
    );
    await fake.update("bm-d", { url: "https://other.example/" });
    const error = await expectStale(() => approveDecision(row.id));
    expect(error.staleReason).toBe("bookmark_edited");
    expect((await getDecision(row.id))?.status).toBe("pending");
  });

  it("applies an unchanged bookmark and a row with no sent snapshot", async () => {
    const applied = await approveDecision(
      (await persistDecision(decision(), { guard: bmAGuard })).id,
    );
    expect(applied.status).toBe("applied");
    // A row with placements only (no `snapshots`) keeps the old checks: a
    // move of its bookmark does NOT stale a set_category — it applies.
    const legacy = await persistDecision(decision({ id: UUID2, bookmarkIds: ["bm-b"] }), {
      guard: { placements: { "bm-b": "1" } },
    });
    await moveNode("bm-b", { parentId: "2" });
    expect((await approveDecision(legacy.id)).status).toBe("applied");
    // ... while a `move` row still fails on the placement it recorded.
    const move = await persistDecision(
      decision({ id: UUID3, kind: "move", bookmarkIds: ["bm-c"], targetFolderId: "f-target" }),
      { guard: { placements: { "bm-c": "1" } } },
    );
    await moveNode("bm-c", { parentId: "2" });
    const error = await expectStale(() => approveDecision(move.id));
    expect(error.staleReason).toBe("bookmark_moved");
  });
});
