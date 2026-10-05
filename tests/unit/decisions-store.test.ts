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
  DecisionStoreError,
  POPUP_DECISION_LIMIT,
  getDecision,
  isLegalTransition,
  listByStatus,
  listDecisions,
  listPending,
  persistDecision,
  persistDecisionRationale,
  prunePopupDecisions,
  transitionStatus,
} from "../../src/decisions/store";
import type { DecisionRow, DecisionStoreErrorCode } from "../../src/decisions/store";
import { AuditEvent } from "../../src/schemas/audit";
import { Decision } from "../../src/schemas/decision";
import { UndoSnapshot } from "../../src/schemas/undo";
import { decisionBase } from "../fixtures/base-records";
import { validUndoSnapshot } from "../fixtures/undo";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Coverage for `src/decisions/store.ts` — persistence of the §7 `Decision`
 * rows, the review-queue queries, and the transactional status transition
 * that also appends the content-free `audit` row (spec FR6). The apply /
 * mutation half lives in `decisions-apply.test.ts`.
 *
 * Seeded tree:
 * ```
 * 0 root
 * └─ 1 Bookmarks bar
 *    ├─ bm-001   https://a.example/   (under "1")
 *    └─ bm-002   https://b.example/   (under "1")
 * ```
 */

const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";
const UUID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function decision(over: Partial<Decision> = {}): Decision {
  return Decision.parse({
    ...decisionBase,
    kind: "set_category",
    category: "article",
    bookmarkIds: ["bm-001"],
    ...over,
  });
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  installBookmarksFake({
    bookmarksBar: [
      { id: "bm-001", title: "A", url: "https://a.example/" },
      { id: "bm-002", title: "B", url: "https://b.example/" },
    ],
  });
  await db.decisions.clear();
  await db.audit.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** Run `fn`, expect it to reject with a DecisionStoreError of `code`. */
async function expectStoreError(
  fn: () => Promise<unknown>,
  code: DecisionStoreErrorCode,
): Promise<DecisionStoreError> {
  try {
    await fn();
  } catch (cause) {
    expect(cause).toBeInstanceOf(DecisionStoreError);
    expect((cause as DecisionStoreError).code).toBe(code);
    return cause as DecisionStoreError;
  }
  throw new Error(`expected a DecisionStoreError(${code}), but it resolved`);
}

// ---------------------------------------------------------------------------
// persistDecision
// ---------------------------------------------------------------------------

describe("persistDecision", () => {
  it("stores the §7 Decision row keyed by id and returns it", async () => {
    const input = decision();
    const stored = await persistDecision(input);
    expect(stored).toMatchObject(input);
    const read = await getDecision(UUID);
    expect(read).toMatchObject(input);
    expect(read?.kind).toBe("set_category");
  });

  it("stores the document verbatim and captures decision-time placement guards", async () => {
    const stored = await persistDecision(
      decision({
        bookmarkIds: ["bm-001", "bm-002"],
        source: {
          engine: "jev",
          providerId: "typesafe",
          model: "jev-1.13.0",
          questionSetVersion: "qs-7",
        },
      }),
    );
    expect(stored.source.model).toBe("jev-1.13.0");
    expect(stored.source.questionSetVersion).toBe("qs-7");
    expect(stored.guard?.placements).toEqual({ "bm-001": "1", "bm-002": "1" });
    // A bookmark already gone from the tree gets no placement entry.
    const ghost = await persistDecision(decision({ bookmarkIds: ["bm-ghost"] }));
    expect(ghost.guard?.placements).toEqual({});
  });

  it("refuses a schema-violating document and upserts idempotently", async () => {
    const bad = { ...decision(), confidence: 2 } as unknown as Decision;
    await expectStoreError(() => persistDecision(bad), "invalid");
    expect(await listDecisions()).toEqual([]);
    await persistDecision(decision());
    await persistDecision(decision({ confidence: 0.5 }));
    const rows = await listDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

describe("queries", () => {
  it("listDecisions returns rows oldest-first by createdAt", async () => {
    await persistDecision(
      decision({ id: UUID2, createdAt: "2026-09-25T11:00:00.000Z" }),
    );
    await persistDecision(decision({ createdAt: "2026-09-25T10:00:00.000Z" }));
    const rows = await listDecisions();
    expect(rows.map((r) => r.id)).toEqual([UUID, UUID2]);
  });

  it("listPending/listByStatus filter on status; unknown ids miss", async () => {
    await persistDecision(decision({ id: UUID, status: "pending" }));
    await persistDecision(
      decision({ id: UUID2, status: "rejected", createdAt: "2026-09-25T11:00:00.000Z" }),
    );
    expect((await listPending()).map((r) => r.id)).toEqual([UUID]);
    expect((await listByStatus("rejected")).map((r) => r.id)).toEqual([UUID2]);
    expect((await listByStatus("pending")).map((r) => r.id)).toEqual([UUID]);
    expect(await listByStatus("reverted")).toEqual([]);
    expect(await getDecision("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isLegalTransition
// ---------------------------------------------------------------------------

describe("isLegalTransition", () => {
  it("models the §7 status state machine", () => {
    // Approve/reject is open from every reviewable state.
    for (const from of ["pending", "unsure", "approved", "auto_applied"] as const) {
      expect(isLegalTransition(from, "applied"), from).toBe(true);
      expect(isLegalTransition(from, "rejected"), from).toBe(true);
    }
    // The policy auto-apply edge is open from reviewable states only.
    for (const from of ["pending", "unsure", "approved"] as const) {
      expect(isLegalTransition(from, "auto_applied"), from).toBe(true);
    }
    expect(isLegalTransition("applied", "auto_applied")).toBe(false);
    // Revert is open from applied states only.
    expect(isLegalTransition("applied", "reverted")).toBe(true);
    expect(isLegalTransition("auto_applied", "reverted")).toBe(true);
    expect(isLegalTransition("pending", "reverted")).toBe(false);
    expect(isLegalTransition("rejected", "reverted")).toBe(false);
    // Rejected and reverted are terminal.
    for (const to of ["applied", "rejected", "reverted", "pending"] as const) {
      expect(isLegalTransition("rejected", to), to).toBe(false);
      expect(isLegalTransition("reverted", to), to).toBe(false);
    }
    // No self-transitions.
    for (const s of [
      "pending",
      "unsure",
      "approved",
      "auto_applied",
      "applied",
      "rejected",
      "reverted",
    ] as const) {
      expect(isLegalTransition(s, s), s).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// transitionStatus + audit
// ---------------------------------------------------------------------------

describe("transitionStatus", () => {
  it("moves the row and appends exactly one audit row", async () => {
    await persistDecision(decision({ status: "pending" }));
    const { row, audit } = await transitionStatus(UUID, "applied", "user");
    expect(row.status).toBe("applied");
    expect((await getDecision(UUID))?.status).toBe("applied");
    const auditRows = await db.audit.toArray();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      decisionId: UUID,
      from: "pending",
      to: "applied",
      actor: "user",
    });
    expect(audit.from).toBe("pending");
  });

  it("writes a complete audit row: parsed, actor-stamped, content-free", async () => {
    await persistDecision(decision({ status: "pending", bookmarkIds: ["bm-001"] }));
    await transitionStatus(UUID, "rejected", "user");
    const raw = (await db.audit.toArray())[0] as Record<string, unknown>;
    const parsed = AuditEvent.parse(raw);
    expect(parsed.id).toBeGreaterThan(0);
    expect(parsed.to).toBe("rejected");
    expect(Object.keys(raw).sort()).toEqual(
      ["actor", "changedAt", "decisionId", "from", "id", "to"].sort(),
    );
    // No title/url/folder/tag fields leaked in.
    expect(JSON.stringify(raw)).not.toContain("https://a.example/");
    await transitionStatus(UUID, "auto_applied", "policy").catch(() => {});
    await persistDecision(decision({ id: UUID2, status: "pending" }));
    await transitionStatus(UUID2, "auto_applied", "policy");
    const policyRow = (await db.audit.toArray()).find(
      (r) => r.decisionId === UUID2,
    );
    expect(policyRow?.actor).toBe("policy");
    expect(policyRow?.to).toBe("auto_applied");
  });

  it("refuses illegal transitions and unknown ids without writing", async () => {
    await persistDecision(decision({ status: "reverted" }));
    await expectStoreError(
      () => transitionStatus(UUID, "applied", "user"),
      "illegal_transition",
    );
    expect((await getDecision(UUID))?.status).toBe("reverted");
    expect(await db.audit.toArray()).toEqual([]);
    await expectStoreError(
      () => transitionStatus(UUID2, "applied", "user"),
      "not_found",
    );
  });

  it("carries an undo snapshot id through onto the row when supplied", async () => {
    await persistDecision(decision({ status: "pending" }));
    const { row } = await transitionStatus(UUID, "applied", "user", {
      undoSnapshotId: 42,
    });
    expect(row.undoSnapshotId).toBe(42);
    expect((await getDecision(UUID))?.undoSnapshotId).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// DecisionRow shape
// ---------------------------------------------------------------------------

describe("DecisionRow", () => {
  it("keeps the §7 fields intact alongside the additive guard sidecar", async () => {
    await persistDecision(decision());
    const row = (await getDecision(UUID)) as DecisionRow;
    // The persisted core re-validates against the §7 schema.
    expect(Decision.safeParse({ ...row, guard: undefined }).success).toBe(true);
    expect(row.guard?.placements).toBeTypeOf("object");
  });
});

// ---------------------------------------------------------------------------
// persistDecisionRationale (spec FR5.4 — the §7 `rationale` field is the one
// field a decision may gain after persistence, and only through this write)
// ---------------------------------------------------------------------------

describe("persistDecisionRationale", () => {
  async function expectRationaleError(
    fn: () => Promise<unknown>,
    code: DecisionStoreErrorCode,
  ) {
    try {
      await fn();
    } catch (caught) {
      expect(caught).toBeInstanceOf(DecisionStoreError);
      expect((caught as DecisionStoreError).code).toBe(code);
      return;
    }
    throw new Error(`expected a DecisionStoreError ${code}`);
  }

  it("writes only the rationale, overwrites it, and leaves audit/undo untouched", async () => {
    await persistDecision(
      decision({ status: "pending", probabilities: { article: 0.9 } }),
    );
    const before = (await getDecision(UUID)) as DecisionRow;
    const row = await persistDecisionRationale(UUID, "Jev picked 'article'.");
    expect(row.rationale).toBe("Jev picked 'article'.");
    expect(row.status).toBe("pending");
    expect(row.probabilities).toEqual({ article: 0.9 });
    expect(row.guard).toEqual(before.guard);
    const after = (await getDecision(UUID)) as DecisionRow;
    expect(after.rationale).toBe("Jev picked 'article'.");
    expect(after.status).toBe("pending");
    await persistDecisionRationale(UUID, "new");
    expect((await getDecision(UUID))?.rationale).toBe("new");
    expect(await db.audit.toArray()).toEqual([]);
    expect(await db.undo.toArray()).toEqual([]);
    expect((await getDecision(UUID))?.undoSnapshotId).toBeUndefined();
  });

  it("rejects oversized or empty rationales and unknown ids", async () => {
    await persistDecision(decision());
    await expectRationaleError(
      () => persistDecisionRationale(UUID, "x".repeat(1_001)),
      "invalid",
    );
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
    await expectRationaleError(
      () => persistDecisionRationale(UUID, ""),
      "invalid",
    );
    await expectRationaleError(
      () => persistDecisionRationale(UUID2, "no row"),
      "not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// prunePopupDecisions (I05 — bound the synthetic popup save-suggest backlog)
//
// The popup persists each SAVE_SUGGEST round-trip as `popup:<uuid>` decision
// rows. Nothing ever applied them (the apply path refuses a synthetic id), so
// without a bound they accumulate forever. `prunePopupDecisions` keeps the
// newest POPUP_DECISION_LIMIT eligible rows and only ever drops synthetic
// rows in a safe-to-prune status; real, mixed, applied/auto-applied/approved/
// rejected rows and the audit/undo tables are never touched.
// ---------------------------------------------------------------------------

/** Epoch (ms) that popup rows sort from — newest rows have larger `n`. */
const POPUP_EPOCH = 1_700_000_000_000;

/** A stable, valid, lexicographically ordered uuid for synthetic row `n`. */
function syntheticUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * A valid UUID whose DECISION-ID order is the exact REVERSE of its KEY order.
 * The id carries the complement of `n` in its last group while the leading
 * group varies with `n`, so as `n` grows the id sorts DOWN but the primary
 * key sorts UP. Retention must follow the id: a sweep that leans on Dexie's
 * primary-key scan order would drop the opposite rows.
 */
function mirrorUuid(n: number): string {
  const head = n.toString(16).padStart(8, "0");
  const tail = (16 ** 12 - 1 - n).toString(16).padStart(12, "0");
  return `${head}-0000-4000-8000-${tail}`;
}

/** One synthetic `popup:` decision row; `n` drives both ids and sort order. */
function popupRow(n: number, over: Partial<Decision> = {}): Decision {
  return decision({
    id: syntheticUuid(n),
    bookmarkIds: [`popup:${syntheticUuid(n)}`],
    createdAt: new Date(POPUP_EPOCH + n * 1_000).toISOString(),
    ...over,
  });
}

/** Resolve `value` as the Dexie `PromiseExtended` the table methods return. */
function dexiePromise<T>(value: T): Promise<T> & {
  timeout(ms: number, msg?: string): Promise<T>;
} {
  const promise = Promise.resolve(value) as Promise<T> & {
    timeout(ms: number, msg?: string): Promise<T>;
  };
  promise.timeout = () => Promise.resolve(value);
  return promise;
}

/**
 * `db.decisions` viewed as a plain callable surface. The real Dexie `Table`
 * overloads (including `toArray(thenShortcut)`) cannot be satisfied by a spy
 * implementation, so the spies below target this narrow view instead.
 */
interface DecisionsTableSeam {
  toArray(): Promise<unknown[]>;
  bulkDelete(keys: readonly string[]): Promise<void>;
  where(index: string): unknown;
}

function decisionsSeam(): DecisionsTableSeam {
  return db.decisions as unknown as DecisionsTableSeam;
}

describe("prunePopupDecisions", () => {
  it("caps eligible synthetic popup rows at POPUP_DECISION_LIMIT, oldest first", async () => {
    await db.decisions.bulkPut(
      Array.from({ length: POPUP_DECISION_LIMIT + 5 }, (_, n) => popupRow(n)),
    );

    expect(await prunePopupDecisions()).toBe(5);

    const remaining = await db.decisions.toArray();
    expect(remaining).toHaveLength(POPUP_DECISION_LIMIT);
    for (let n = 0; n < 5; n += 1) {
      expect(await getDecision(syntheticUuid(n))).toBeUndefined();
    }
    for (const n of [5, POPUP_DECISION_LIMIT - 1, POPUP_DECISION_LIMIT + 4]) {
      expect(await getDecision(syntheticUuid(n))).toBeDefined();
    }
  });

  it("counts pending and unsure synthetic rows against the same limit", async () => {
    await db.decisions.bulkPut(
      Array.from({ length: POPUP_DECISION_LIMIT + 3 }, (_, n) =>
        popupRow(n, { status: n % 2 === 0 ? "pending" : "unsure" }),
      ),
    );
    expect(await prunePopupDecisions()).toBe(3);
    const rows = await db.decisions.toArray();
    expect(rows).toHaveLength(POPUP_DECISION_LIMIT);
    expect(rows.every((row) => row.bookmarkIds[0]?.startsWith("popup:"))).toBe(
      true,
    );
  });

  it("preserves real, mixed, non-prunable, audit, and undo rows", async () => {
    await db.decisions.bulkPut(
      Array.from({ length: POPUP_DECISION_LIMIT + 5 }, (_, n) => popupRow(n)),
    );

    const preserved: Decision[] = [
      popupRow(600, { status: "applied" }),
      popupRow(601, { status: "auto_applied" }),
      popupRow(602, { status: "approved" }),
      popupRow(603, { status: "rejected" }),
      popupRow(604, { status: "reverted" }),
      // Mixed references (synthetic + real) are never synthetic-only.
      decision({
        id: syntheticUuid(610),
        bookmarkIds: [`popup:${syntheticUuid(610)}`, "bm-001"],
        createdAt: new Date(POPUP_EPOCH + 610_000).toISOString(),
      }),
      decision({
        id: syntheticUuid(611),
        bookmarkIds: ["bm-001"],
        createdAt: new Date(POPUP_EPOCH + 611_000).toISOString(),
      }),
      decision({
        id: syntheticUuid(612),
        bookmarkIds: ["bm-001"],
        status: "applied",
        createdAt: new Date(POPUP_EPOCH + 612_000).toISOString(),
      }),
    ];
    await db.decisions.bulkPut(preserved);

    await db.audit.add(
      AuditEvent.parse({
        decisionId: syntheticUuid(600),
        from: "pending",
        to: "applied",
        actor: "user",
        changedAt: new Date(POPUP_EPOCH).toISOString(),
      }),
    );
    await db.undo.add(UndoSnapshot.parse(validUndoSnapshot));

    expect(await prunePopupDecisions()).toBe(5);
    for (const row of preserved) {
      expect(await getDecision(row.id)).toBeDefined();
    }
    expect(await db.audit.count()).toBe(1);
    expect(await db.undo.count()).toBe(1);
  });

  it("is a no-op at or below the limit and on an empty table", async () => {
    expect(await prunePopupDecisions()).toBe(0);
    expect(await db.decisions.count()).toBe(0);
    await db.decisions.bulkPut(
      Array.from({ length: POPUP_DECISION_LIMIT }, (_, n) => popupRow(n)),
    );
    expect(await prunePopupDecisions()).toBe(0);
    expect(await db.decisions.count()).toBe(POPUP_DECISION_LIMIT);
  });

  it("orders equal-createdAt rows by decision id, not by Dexie key order", async () => {
    const createdAt = new Date(POPUP_EPOCH).toISOString();
    const limit = POPUP_DECISION_LIMIT;
    // `limit + 2` eligible rows all sharing ONE createdAt, so retention is
    // decided ENTIRELY by the id tie-break: the sweep keeps the newest
    // POPUP_DECISION_LIMIT rows, i.e. it drops the two LOWEST decision ids.
    // The ids are assigned in DESCENDING order as the rows are built, and the
    // scan is frozen to that build order, so the two rows a scan-order sweep
    // would delete are the TWO HIGHEST ids — the exact opposite pair.
    const rows = Array.from({ length: limit + 2 }, (_, n) =>
      popupRow(n, { createdAt, id: mirrorUuid(limit + 1 - n) }),
    );
    const sortedById = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    // Oldest by id => pruned; everything else survives.
    const pruned = sortedById.slice(0, 2).map((r) => r.id);
    const kept = sortedById.slice(2).map((r) => r.id);
    // The pair a scan-order (no-tie-break) sweep would drop instead.
    const wrongVictims = rows.slice(0, 2).map((r) => r.id);
    expect(wrongVictims).not.toEqual(pruned);

    await db.decisions.bulkPut(rows);
    const toArraySpy = vi
      .spyOn(decisionsSeam(), "toArray")
      .mockImplementation(() => dexiePromise([...rows]));

    expect(await prunePopupDecisions()).toBe(2);
    toArraySpy.mockRestore();

    const survivors = new Set((await db.decisions.toArray()).map((r) => r.id));
    expect([...survivors].length).toBe(kept.length);
    // The two LOWEST decision ids were dropped...
    for (const id of pruned) expect(survivors.has(id)).toBe(false);
    // ...while every higher-id row survived — including the two rows the scan
    // lists FIRST, which a key/scan-order sweep would have deleted instead.
    for (const id of kept) expect(survivors.has(id)).toBe(true);
    for (const id of wrongVictims) expect(survivors.has(id)).toBe(true);
  });

  it("rolls back the whole sweep when a deletion fails mid-transaction", async () => {
    const backlog = Array.from({ length: POPUP_DECISION_LIMIT + 5 }, (_, n) =>
      popupRow(n),
    );
    await db.decisions.bulkPut(backlog);

    // The REAL bulkDelete runs first (so rows genuinely leave the store),
    // then the sweep's own delete step is failed. A non-transactional sweep
    // would leave that partial deletion committed; only the surrounding `rw`
    // transaction rolls it back.
    const realBulkDelete = db.decisions.bulkDelete.bind(db.decisions);
    const bulkDelete = vi
      .spyOn(decisionsSeam(), "bulkDelete")
      .mockImplementationOnce(async (ids: readonly string[]) => {
        await realBulkDelete([...ids] as string[]);
        throw new Error("bulkDelete exploded mid-sweep");
      });

    // The error surfaces instead of being swallowed...
    await expect(prunePopupDecisions()).rejects.toThrow(
      "bulkDelete exploded mid-sweep",
    );
    bulkDelete.mockRestore();

    // ...and the partial deletion was rolled back: NO row was removed.
    expect(await db.decisions.count()).toBe(POPUP_DECISION_LIMIT + 5);
    expect(await getDecision(syntheticUuid(0))).toBeDefined();
    expect(await getDecision(syntheticUuid(POPUP_DECISION_LIMIT + 4))).toBeDefined();
  });

  it("issues every read and write of one sweep inside a single rw transaction", async () => {
    await db.decisions.bulkPut(
      Array.from({ length: POPUP_DECISION_LIMIT + 5 }, (_, n) => popupRow(n)),
    );

    // Dexie exposes the ambient transaction on the Dexie constructor while
    // one is open: a sweep that dropped `db.transaction(...)` would observe
    // `undefined` here and could not roll anything back. A08: the sweep reads
    // through the `status` index, so the spy wraps `where` — it delegates to
    // the real index read while recording the transaction mode it ran under.
    const ambient: (string | undefined)[] = [];
    const realWhere = db.decisions.where.bind(db.decisions);
    const where = vi
      .spyOn(decisionsSeam(), "where")
      .mockImplementation((index: string) => {
        const current = (
          db.constructor as { currentTransaction?: { mode?: string } }
        ).currentTransaction;
        ambient.push(current?.mode);
        return realWhere(index);
      });

    expect(await prunePopupDecisions()).toBe(5);
    where.mockRestore();

    expect(ambient.length).toBeGreaterThan(0);
    expect(ambient).toEqual(ambient.map(() => "readwrite"));
  });
});
