import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin, revokeConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { handleRestructureMessage } from "../../src/messages/restructure";
import type { RestructureDeps } from "../../src/messages/restructure";
import { proposeLayout } from "../../src/restructure/propose";
import { LlmGateError } from "../../src/net/llm-send";
import { saveLlmProvider } from "../../src/llm/settings";
import { enqueueJob } from "../../src/jobs/queue";
import type { RestructureProposal } from "../../src/schemas/restructure";

vi.mock("../../src/restructure/propose", () => ({
  proposeLayout: vi.fn(),
}));

/**
 * `handleRestructureMessage` (spec FR8): the sidepanel-facing protocol —
 * START (propose→enqueue→fire the runner), STATUS, PAUSE/RESUME/CANCEL,
 * CONFIRM (guarded apply), UNDO. Every reply resolves to
 * `RestructureMessageResult`; untrusted senders and malformed payloads are
 * refused at the boundary.
 */

const SENDER = { url: "chrome-extension://test-id/sidepanel.html" };
const NOW = "2026-09-28T00:00:00.000Z";
const now = () => NOW;

const PROPOSAL: RestructureProposal = {
  folders: [{ path: "dev", description: "" }],
};

let runJobCalls: string[];
const deps: RestructureDeps = {
  runJob: (jobId) => {
    runJobCalls.push(jobId);
    return Promise.resolve();
  },
};

let api: FakeBookmarksApi;

/**
 * Drive a persisted restructure job to `completed` with the given committed
 * assignments — the state a `RESTRUCTURE_CONFIRM` reply acts on.
 */
async function completedRestructureJob(
  bookmarkIds: string[],
  assignments: Array<{
    bookmarkId: string;
    proposedPath: string;
    confidence: number;
  }>,
  proposal: RestructureProposal = PROPOSAL,
) {
  const job = await enqueueJob({
    kind: "restructure",
    bookmarkIds,
    restructureProposal: proposal,
    now,
  });
  const { setJobStatus, mergeRestructureAssignments } = await import(
    "../../src/jobs/queue"
  );
  await setJobStatus(job.id, "running", {}, now);
  await mergeRestructureAssignments(job.id, assignments);
  return setJobStatus(job.id, "completed", {}, now);
}

beforeEach(async () => {
  api = installBookmarksFake({
    bookmarksBar: [
      { id: "10", title: "Old", children: [
        { id: "11", title: "A", url: "https://a.io/" },
      ]},
    ],
    otherBookmarks: [
      { id: "50", title: "Later", children: [
        { id: "51", title: "B", url: "https://b.io/" },
      ]},
    ],
    mobileBookmarks: [
      { id: "60", title: "Phone", children: [
        { id: "61", title: "C", url: "https://c.io/" },
      ]},
    ],
  });
  // The protocol's sender check needs runtime.getURL — the bookmarks fake
  // installs only `chrome.bookmarks`, so extend the stub.
  vi.stubGlobal("chrome", {
    ...api,
    bookmarks: api,
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      sendMessage: vi.fn(),
    },
  });
  runJobCalls = [];
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

describe("handleRestructureMessage boundary", () => {
  it("returns undefined for messages outside the protocol", async () => {
    expect(
      await handleRestructureMessage({ type: "OTHER" }, SENDER, deps),
    ).toBeUndefined();
    expect(await handleRestructureMessage("nope", SENDER, deps)).toBeUndefined();
  });

  it("refuses untrusted senders and malformed payloads", async () => {
    const bad = await handleRestructureMessage(
      { type: "RESTRUCTURE_UNDO" },
      { url: "https://evil.example/" },
      deps,
    );
    expect(bad).toMatchObject({ ok: false, code: "untrusted_sender" });
    const malformed = await handleRestructureMessage(
      { type: "RESTRUCTURE_PAUSE" },
      SENDER,
      deps,
    );
    expect(malformed).toMatchObject({ ok: false, code: "malformed_message" });
  });
});

describe("RESTRUCTURE_START", () => {
  it("resolves the \"active\" sentinel to the active provider's id", async () => {
    await saveLlmProvider({
      providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234",
      configuredAt: "2026-09-15T00:00:00.000Z",
    });
    await grantConsentAtOrigin("llm_restructure", "https://api.openai.com");
    vi.mocked(proposeLayout).mockResolvedValue({
      proposal: PROPOSAL,
      model: "gpt-4o-mini",
    });

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );

    // The view sends the sentinel "active"; the worker must hand the
    // resolved record's own id to the proposal (and job) layer.
    expect(reply).toMatchObject({ ok: true, code: "job_ok" });
    expect(proposeLayout).toHaveBeenCalledWith(
      "preset:openai",
      expect.anything(),
      expect.anything(),
    );
    expect(runJobCalls).toHaveLength(1);
  });

  it("reports no_provider when \"active\" names no active provider", async () => {
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "no_provider" });
    expect(proposeLayout).not.toHaveBeenCalled();
  });

  it("relays an aborted provider send verbatim", async () => {
    await saveLlmProvider({
      providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234",
      configuredAt: "2026-09-15T00:00:00.000Z",
    });
    await grantConsentAtOrigin("llm_restructure", "https://api.openai.com");
    vi.mocked(proposeLayout).mockRejectedValue(
      new LlmGateError("aborted", "Outbound LLM request was aborted."),
    );
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "aborted" });
  });

  // A07: the start reply carries a pre-run estimate folded over the same
  // leaf rows the job will process (the fake tree has 3 leaf bookmarks).
  it("returns a pre-run estimate covering the resolved leaf rows", async () => {
    await saveLlmProvider({
      providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234",
      configuredAt: "2026-09-15T00:00:00.000Z",
    });
    await grantConsentAtOrigin("llm_restructure", "https://api.openai.com");
    vi.mocked(proposeLayout).mockResolvedValue({
      proposal: PROPOSAL,
      model: "gpt-4o-mini",
    });

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );

    expect(reply).toMatchObject({
      ok: true,
      code: "job_ok",
      estimate: {
        requests: 3, // one assignment request per leaf bookmark
        pairs: 0,
        totalBatches: 1,
        truncated: false,
      },
    });
  });

  // A07: a second START while the first restructure job is non-terminal is a
  // typed rejection — the enqueue guard is an atomic row check.
  it("rejects a second start while a restructure job is non-terminal", async () => {
    await saveLlmProvider({
      providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234",
      configuredAt: "2026-09-15T00:00:00.000Z",
    });
    await grantConsentAtOrigin("llm_restructure", "https://api.openai.com");
    vi.mocked(proposeLayout).mockResolvedValue({
      proposal: PROPOSAL,
      model: "gpt-4o-mini",
    });

    const first = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );
    expect(first).toMatchObject({ ok: true, code: "job_ok" });

    const second = await handleRestructureMessage(
      { type: "RESTRUCTURE_START", providerId: "active" },
      SENDER,
      deps,
    );
    expect(second).toMatchObject({ ok: false, code: "job_in_progress" });
    // The preflight refused before the proposal send — no wasted egress, no
    // second job row, no second runner.
    expect(proposeLayout).toHaveBeenCalledTimes(1);
    expect(runJobCalls).toHaveLength(1);
  });
});

describe("RESTRUCTURE_START consent admission", () => {
  const approval = { providerId: "preset:openai", origin: "https://api.openai.com",
    model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions", consentVersion: 5 };
  async function seed() {
    await saveLlmProvider({ providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234", configuredAt: NOW });
    vi.mocked(proposeLayout).mockResolvedValue({ proposal: PROPOSAL, model: "gpt-4o-mini" });
  }
  it.each(["missing", "stale", "foreign"] as const)("rejects %s before sensitive reads and job writes", async (mode) => {
    await seed();
    if (mode !== "missing") await db.consents.put({ scope: "llm_restructure",
      origin: mode === "foreign" ? "https://foreign.dev" : approval.origin,
      consentVersion: mode === "foreign" ? 5 : 4, acceptedAt: NOW });
    const before = await db.consents.toArray();
    const tree = vi.spyOn(api, "getTree");
    const metas = vi.spyOn(db.bookmarkMeta, "toArray");
    const metadataGet = vi.spyOn(db.metadata, "get");
    const reply = await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active" }, SENDER, deps);
    expect(reply).toMatchObject({ ok: false, code: "consent_required",
      consent: { scope: "llm_restructure", recipient: "OpenAI", approval } });
    expect(tree).not.toHaveBeenCalled();
    expect(metas).not.toHaveBeenCalled();
    expect(metadataGet.mock.calls.flat()).not.toContain("decisions:blocklist");
    expect(proposeLayout).not.toHaveBeenCalled();
    expect(runJobCalls).toEqual([]);
    expect(await db.jobs.count()).toBe(0);
    expect(await db.consents.toArray()).toEqual(before);
  });
  it("starts after exact grant and binding without refreshing acceptedAt", async () => {
    await seed();
    await grantConsentAtOrigin("llm_restructure", approval.origin);
    const before = await db.consents.toArray();
    expect(await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active",
      consentApproval: approval }, SENDER, deps)).toMatchObject({ ok: true, code: "job_ok" });
    expect(await db.consents.toArray()).toEqual(before);
    expect(runJobCalls).toHaveLength(1);
  });
  it.each(["revoked", "model", "endpoint", "provider", "version"] as const)("rejects a cost retry after %s changed", async (change) => {
    await seed();
    await grantConsentAtOrigin("llm_restructure", approval.origin);
    if (change === "revoked") await revokeConsentAtOrigin("llm_restructure", approval.origin);
    const bound = { ...approval };
    if (change === "model") bound.model = "other-model";
    if (change === "endpoint") bound.endpoint = "https://api.openai.com/other/chat/completions";
    if (change === "provider") bound.providerId = "preset:openrouter";
    if (change === "version") bound.consentVersion = 4;
    expect(await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active",
      unknownCostConfirmed: true, consentApproval: bound }, SENDER, deps))
      .toMatchObject({ ok: false, code: "consent_required" });
    expect(proposeLayout).not.toHaveBeenCalled();
    expect(await db.jobs.count()).toBe(0);
  });
  it.each(["switch", "reconfigure"] as const)("refuses the old accepted binding after a real provider %s even with current consent", async (change) => {
    await seed();
    await grantConsentAtOrigin("llm_restructure", approval.origin);
    if (change === "switch") {
      await saveLlmProvider({ providerId: "preset:openrouter",
        provider: { kind: "preset", preset: "openrouter", model: "openai/gpt-4o-mini" },
        keySuffix: "1234", configuredAt: NOW });
      await grantConsentAtOrigin("llm_restructure", "https://openrouter.ai");
    } else {
      await saveLlmProvider({ providerId: approval.providerId,
        provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini-2024-07-18" },
        keySuffix: "1234", configuredAt: NOW });
    }
    const before = await db.consents.toArray();
    expect(await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active",
      unknownCostConfirmed: true, consentApproval: approval }, SENDER, deps))
      .toMatchObject({ ok: false, code: "consent_required" });
    expect(await db.consents.toArray()).toEqual(before);
    expect(proposeLayout).not.toHaveBeenCalled();
    expect(await db.jobs.count()).toBe(0);
  });
  it("cost approval alone is not consent or an accepted destination binding", async () => {
    await seed();
    await grantConsentAtOrigin("llm_restructure", approval.origin);
    expect(await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active",
      unknownCostConfirmed: true }, SENDER, deps))
      .toMatchObject({ ok: false, code: "consent_required" });
    expect(proposeLayout).not.toHaveBeenCalled();
  });
  it("rejects content added to the closed approval", async () => {
    await seed();
    expect(await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active",
      consentApproval: { ...approval, notes: "private-notes" } }, SENDER, deps))
      .toMatchObject({ ok: false, code: "malformed_message" });
    expect(proposeLayout).not.toHaveBeenCalled();
  });
});

describe("RESTRUCTURE_STATUS", () => {
  it("reports not_found when no restructure job exists", async () => {
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "not_found" });
  });

  it("returns the latest restructure job's state", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
  });

  it("finds the latest restructure job through the [kind+createdAt] index (J13)", async () => {
    // The compound index is what makes this an index read, not a table scan.
    expect(
      db.jobs.schema.indexes.some(
        (spec) =>
          Array.isArray(spec.keyPath) &&
          spec.keyPath[0] === "kind" &&
          spec.keyPath[1] === "createdAt",
      ),
    ).toBe(true);
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    // A NEWER non-restructure job must not shadow the restructure row.
    await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["11"],
      now: () => "2026-09-28T01:00:00.000Z",
    });
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
    expect((reply as { result: { job: { id: string } } }).result.job.id).toBe(job.id);
  });

  it("attaches the live diff once the job completes", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus, mergeRestructureAssignments } = await import(
      "../../src/jobs/queue"
    );
    await setJobStatus(job.id, "running", {}, now);
    await mergeRestructureAssignments(job.id, [
      { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
    ]);
    await setJobStatus(job.id, "completed", {}, now);
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
    const result = (reply as { result: { diff?: { resolved: number } } })
      .result;
    expect(result.diff?.resolved).toBe(1);
  });

  it("resolves bar, Other, and Mobile assignments in the preview diff", async () => {
    // The production preview path (`statusReply` → `getSubTree(ROOT_NODE_ID)`)
    // must flatten to the same reviewed scope apply revalidates: a narrowing
    // back to the bookmarks bar alone would drop the two non-bar rows.
    const job = await completedRestructureJob(
      ["11", "51", "61"],
      [
        { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
        { bookmarkId: "51", proposedPath: "dev", confidence: 0.85 },
        { bookmarkId: "61", proposedPath: "dev", confidence: 0.8 },
      ],
    );

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
    const diff = (
      reply as {
        result: {
          diff?: {
            resolved: number;
            stale: number;
            rows: Array<{ bookmarkId: string; fromPath: string }>;
          };
        };
      }
    ).result.diff;
    expect(diff?.resolved).toBe(3);
    expect(diff?.stale).toBe(0);
    expect(diff?.rows.map((r) => r.bookmarkId)).toEqual(["11", "51", "61"]);
    expect(
      Object.fromEntries(diff!.rows.map((r) => [r.bookmarkId, r.fromPath])),
    ).toEqual({
      "11": "Bookmarks bar/Old",
      "51": "Other bookmarks/Later",
      "61": "Mobile bookmarks/Phone",
    });
  });
});

describe("RESTRUCTURE_PAUSE/RESUME/CANCEL", () => {
  it("pauses, resumes (re-driving the runner), and cancels", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus } = await import("../../src/jobs/queue");
    await setJobStatus(job.id, "running", {}, now);

    const paused = await handleRestructureMessage(
      { type: "RESTRUCTURE_PAUSE", jobId: job.id },
      SENDER,
      deps,
    );
    expect(paused).toMatchObject({ ok: true });
    expect((paused as { job: { status: string } }).job.status).toBe("paused");

    const resumed = await handleRestructureMessage(
      { type: "RESTRUCTURE_RESUME", jobId: job.id },
      SENDER,
      deps,
    );
    expect(resumed).toMatchObject({ ok: true });
    expect(runJobCalls).toEqual([job.id]);

    const canceled = await handleRestructureMessage(
      { type: "RESTRUCTURE_CANCEL", jobId: job.id },
      SENDER,
      deps,
    );
    expect((canceled as { job: { status: string } }).job.status).toBe(
      "canceled",
    );
  });
});

describe("RESTRUCTURE_CONFIRM", () => {
  it("applies a completed job's plan as one batch", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus, mergeRestructureAssignments } = await import(
      "../../src/jobs/queue"
    );
    await setJobStatus(job.id, "running", {}, now);
    await mergeRestructureAssignments(job.id, [
      { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
    ]);
    await setJobStatus(job.id, "completed", {}, now);

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_CONFIRM", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "applied", moved: 1 });
    const { getSubTree } = await import("../../src/sync/chrome-bookmarks");
    const bar = await getSubTree("1");
    const dev = bar[0]!.children!.find((c: { title: string }) => c.title === "dev");
    expect(dev).toBeDefined();
    expect(
      dev!.children!.map((c: { id: string }) => c.id),
    ).toEqual(["11"]);
  });

  it("applies accepted IDs from the bar, Other, and Mobile roots as one batch", async () => {
    const job = await completedRestructureJob(
      ["11", "51", "61"],
      [
        { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
        { bookmarkId: "51", proposedPath: "dev", confidence: 0.9 },
        { bookmarkId: "61", proposedPath: "dev", confidence: 0.9 },
      ],
    );

    const reply = await handleRestructureMessage(
      {
        type: "RESTRUCTURE_CONFIRM",
        jobId: job.id,
        bookmarkIds: ["11", "51", "61"],
      },
      SENDER,
      deps,
    );

    expect(reply).toMatchObject({ ok: true, code: "applied", moved: 3 });
    const { getSubTree, getChildren } = await import(
      "../../src/sync/chrome-bookmarks"
    );
    const bar = await getSubTree("1");
    const dev = bar[0]!.children!.find(
      (c: { title: string }) => c.title === "dev",
    );
    expect(dev).toBeDefined();
    expect((await getChildren(dev!.id)).map((c) => c.id)).toEqual([
      "11",
      "51",
      "61",
    ]);
  });

  it("refuses a failed tree read with the typed read_failed code", async () => {
    const job = await completedRestructureJob(
      ["11"],
      [{ bookmarkId: "11", proposedPath: "dev", confidence: 0.9 }],
    );
    const before = JSON.stringify(await api.getTree());
    const treeSpy = vi
      .spyOn(api, "getTree")
      .mockRejectedValue(new Error("bookmarks api unavailable"));

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_CONFIRM", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "read_failed" });

    treeSpy.mockRestore();
    expect(JSON.stringify(await api.getTree())).toEqual(before);
  });

  it("refuses a still-running job (never applies early)", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_CONFIRM", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "not_ready" });
  });
});

describe("RESTRUCTURE_UNDO", () => {
  it("requires a snapshotId in the wire payload", async () => {
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_UNDO" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "malformed_message" });
  });

  it("refuses a snapshotId that is not the undo-stack head", async () => {
    // An id on an empty stack (or a stale id after a later push) resolves
    // to `conflict` in undoExpected — surfaced as `stale` to the page.
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_UNDO", snapshotId: 1 },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "stale" });
  });
});
