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
  getDecision,
  isLegalTransition,
  listByStatus,
  listDecisions,
  listPending,
  persistDecision,
  persistDecisionRationale,
  transitionStatus,
} from "../../src/decisions/store";
import type { DecisionRow, DecisionStoreErrorCode } from "../../src/decisions/store";
import { AuditEvent } from "../../src/schemas/audit";
import { Decision } from "../../src/schemas/decision";
import { decisionBase } from "../fixtures/base-records";
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

  it("does not call Jev and keeps source.model / questionSetVersion verbatim", async () => {
    const stored = await persistDecision(
      decision({
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
  });

  it("captures a decision-time placement guard for every bookmark id", async () => {
    const stored = await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
    expect(stored.guard?.placements).toEqual({ "bm-001": "1", "bm-002": "1" });
  });

  it("records no placement for a bookmark that is already gone", async () => {
    const stored = await persistDecision(decision({ bookmarkIds: ["bm-ghost"] }));
    expect(stored.guard?.placements).toEqual({});
  });

  it("refuses a document that violates the Decision schema", async () => {
    const bad = { ...decision(), confidence: 2 } as unknown as Decision;
    await expectStoreError(() => persistDecision(bad), "invalid");
    expect(await listDecisions()).toEqual([]);
  });

  it("overwrites a previous row with the same id (idempotent upsert)", async () => {
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

  it("listPending returns only status === 'pending'", async () => {
    await persistDecision(decision({ id: UUID, status: "pending" }));
    await persistDecision(
      decision({ id: UUID2, status: "rejected", createdAt: "2026-09-25T11:00:00.000Z" }),
    );
    const rows = await listPending();
    expect(rows.map((r) => r.id)).toEqual([UUID]);
  });

  it("listByStatus filters on the status index", async () => {
    await persistDecision(decision({ id: UUID, status: "unsure" }));
    await persistDecision(
      decision({ id: UUID2, status: "applied", createdAt: "2026-09-25T11:00:00.000Z" }),
    );
    expect((await listByStatus("unsure")).map((r) => r.id)).toEqual([UUID]);
    expect((await listByStatus("applied")).map((r) => r.id)).toEqual([UUID2]);
    expect(await listByStatus("reverted")).toEqual([]);
  });

  it("getDecision returns undefined for an unknown id", async () => {
    expect(await getDecision("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isLegalTransition
// ---------------------------------------------------------------------------

describe("isLegalTransition", () => {
  it("allows approve/reject from the reviewable states", () => {
    for (const from of ["pending", "unsure", "approved", "auto_applied"] as const) {
      expect(isLegalTransition(from, "applied")).toBe(true);
      expect(isLegalTransition(from, "rejected")).toBe(true);
    }
  });

  it("allows the policy auto-apply transition from a reviewable state", () => {
    for (const from of ["pending", "unsure", "approved"] as const) {
      expect(isLegalTransition(from, "auto_applied")).toBe(true);
    }
    expect(isLegalTransition("applied", "auto_applied")).toBe(false);
  });

  it("allows revert only from an applied state", () => {
    expect(isLegalTransition("applied", "reverted")).toBe(true);
    expect(isLegalTransition("auto_applied", "reverted")).toBe(true);
    expect(isLegalTransition("pending", "reverted")).toBe(false);
    expect(isLegalTransition("rejected", "reverted")).toBe(false);
  });

  it("treats rejected and reverted as terminal", () => {
    for (const to of ["applied", "rejected", "reverted", "pending"] as const) {
      expect(isLegalTransition("rejected", to)).toBe(false);
      expect(isLegalTransition("reverted", to)).toBe(false);
    }
  });

  it("never allows a self-transition", () => {
    for (const s of [
      "pending",
      "unsure",
      "approved",
      "auto_applied",
      "applied",
      "rejected",
      "reverted",
    ] as const) {
      expect(isLegalTransition(s, s)).toBe(false);
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

  it("stamps a parseable AuditEvent with an IndexedDB-assigned id", async () => {
    await persistDecision(decision({ status: "pending" }));
    await transitionStatus(UUID, "rejected", "user");
    const raw = await db.audit.toArray();
    const parsed = AuditEvent.parse(raw[0]);
    expect(parsed.id).toBeGreaterThan(0);
    expect(parsed.to).toBe("rejected");
  });

  it("records the policy actor for an auto-apply transition", async () => {
    await persistDecision(decision({ status: "pending" }));
    await transitionStatus(UUID, "auto_applied", "policy");
    const rows = await db.audit.toArray();
    expect(rows[0]?.actor).toBe("policy");
    expect(rows[0]?.to).toBe("auto_applied");
  });

  it("stores no bookmark content in the audit row", async () => {
    await persistDecision(decision({ bookmarkIds: ["bm-001"] }));
    await transitionStatus(UUID, "rejected", "user");
    const raw = (await db.audit.toArray())[0] as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ["actor", "changedAt", "decisionId", "from", "id", "to"].sort(),
    );
    // No title/url/folder/tag fields leaked in.
    expect(JSON.stringify(raw)).not.toContain("https://a.example/");
  });

  it("refuses an illegal transition and writes nothing", async () => {
    await persistDecision(decision({ status: "reverted" }));
    await expectStoreError(
      () => transitionStatus(UUID, "applied", "user"),
      "illegal_transition",
    );
    expect((await getDecision(UUID))?.status).toBe("reverted");
    expect(await db.audit.toArray()).toEqual([]);
  });

  it("refuses an unknown decision id", async () => {
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

  it("writes only the rationale — status, payload, and sidecars untouched", async () => {
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
  });

  it("writes no audit row and touches no undo/apply bookkeeping", async () => {
    await persistDecision(decision());
    await persistDecisionRationale(UUID, "A concise rationale.");
    expect(await db.audit.toArray()).toEqual([]);
    expect(await db.undo.toArray()).toEqual([]);
    expect((await getDecision(UUID))?.undoSnapshotId).toBeUndefined();
  });

  it("overwrites an existing rationale", async () => {
    await persistDecision(decision({ rationale: "old" }));
    await persistDecisionRationale(UUID, "new");
    expect((await getDecision(UUID))?.rationale).toBe("new");
  });

  it("rejects a rationale over the 1,000-character §7 bound", async () => {
    await persistDecision(decision());
    await expectRationaleError(
      () => persistDecisionRationale(UUID, "x".repeat(1_001)),
      "invalid",
    );
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("rejects an empty rationale", async () => {
    await persistDecision(decision());
    await expectRationaleError(
      () => persistDecisionRationale(UUID, ""),
      "invalid",
    );
  });

  it("rejects an unknown decision id", async () => {
    await expectRationaleError(
      () => persistDecisionRationale(UUID2, "no row"),
      "not_found",
    );
  });
});
