import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { useMemo } from "react";
import { db } from "../../src/db/database";
import {
  cancelJob,
  enqueueJob,
  pauseJob,
  resumeJob,
  setJobStatus,
} from "../../src/jobs/queue";
import { estimateJobCost } from "../../src/jobs/estimate";
import { BulkBar } from "../../src/entrypoints/sidepanel/BulkBar";
import {
  SelectionContext,
  useBookmarkSelection,
} from "../../src/entrypoints/sidepanel/BookmarkList";
import type { BookmarkSelection } from "../../src/entrypoints/sidepanel/BookmarkList";
import { ToastProvider } from "../../src/entrypoints/sidepanel/UndoToast";
import type { ToastState } from "../../src/entrypoints/sidepanel/UndoToast";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import { MAX_JOB_BOOKMARK_IDS } from "../../src/schemas/job";
import type { JobKind } from "../../src/schemas/job";
import type {
  BookmarkItem,
  FlattenedTree,
  FolderNode,
} from "../../src/sync/tree";

/**
 * Phase 6 Task 2 — U02: Bulk Analyze routes through the job queue.
 *
 * Layers under test:
 *  - `BulkBar`   Analyze opens a confirm carrying the analyzable count and
 *                `estimateJobCost`'s lower bound; confirm sends exactly ONE
 *                `JOB_START` (`analyze_selection`, bookmark ids only —
 *                folders never reach the wire) and the bar streams the
 *                started job row live with Pause/Resume/Cancel. Selections
 *                over `MAX_JOB_BOOKMARK_IDS` and folder-only selections are
 *                rejected before any send.
 *  - Dexie       the `jobs` row is the source of truth — the canned worker
 *                performs the REAL queue transitions so the status card
 *                refires through `useLiveQuery`.
 */

/** Every toast the bar emitted, in order. */
const toasts: ToastState[] = [];
const toastController = {
  showToast: (toast: ToastState): void => {
    toasts.push(toast);
  },
};

function makeBookmark(id: string, index: number): BookmarkItem {
  return {
    kind: "bookmark",
    id,
    parentId: "f1",
    index,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    path: ["Folder"],
    isRoot: false,
    isManaged: false,
    depth: 1,
  };
}

function makeFolder(id: string, index: number): FolderNode {
  return {
    kind: "folder",
    id,
    index,
    title: `Folder ${id}`,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 0,
    childIds: [],
  };
}

function makeTree(
  bookmarkIds: readonly string[],
  folderIds: readonly string[] = [],
): FlattenedTree {
  const bookmarks = new Map<string, BookmarkItem>();
  bookmarkIds.forEach((id, index) =>
    bookmarks.set(id, makeBookmark(id, index)),
  );
  const folders = new Map<string, FolderNode>();
  folderIds.forEach((id, index) => folders.set(id, makeFolder(id, index)));
  return { bookmarks, folders };
}

/** A bar wrapped in real selection + toast plumbing. */
function Harness({
  tree,
  select,
  orderedIds: orderedIdsProp,
}: {
  tree?: FlattenedTree;
  select: (selection: BookmarkSelection) => void;
  /**
   * Explicit `orderedIds` — the selection prunes to it, so a >cap test
   * passes the oversized id list here (a real list never exceeds the
   * protocol cap, but nothing upstream bounds its length).
   */
  orderedIds?: readonly string[];
}) {
  const orderedIds = useMemo(
    () =>
      orderedIdsProp ??
      (tree === undefined
        ? []
        : [...tree.folders.keys(), ...tree.bookmarks.keys()]),
    [tree, orderedIdsProp],
  );
  const selection = useBookmarkSelection(orderedIds);
  return (
    <SelectionContext.Provider value={selection}>
      <ToastProvider controller={toastController}>
        <button
          type="button"
          data-testid="select"
          onClick={() => select(selection)}
        >
          select
        </button>
        <BulkBar tree={tree} />
      </ToastProvider>
    </SelectionContext.Provider>
  );
}

/**
 * The canned worker: job intents perform the real queue writes (what the
 * worker's runner/queue actually persist), so the card's `useLiveQuery`
 * refires on real rows. A started job flips `pending → running`, matching
 * the runner before its first batch.
 */
async function defaultWorker(raw: unknown): Promise<DecisionMessageResult> {
  const message = raw as {
    type?: string;
    kind?: JobKind;
    bookmarkIds?: string[];
    jobId?: string;
  };
  switch (message.type) {
    case "JOB_START": {
      const enqueued = await enqueueJob({
        kind:
          message.kind === "analyze_selection"
            ? "analyze_selection"
            : "library_scan",
        bookmarkIds: message.bookmarkIds ?? [],
      });
      const job = await setJobStatus(enqueued.id, "running");
      return { ok: true, code: "job_ok", job };
    }
    case "JOB_PAUSE":
      return {
        ok: true,
        code: "job_ok",
        job: await pauseJob(message.jobId ?? ""),
      };
    case "JOB_RESUME":
      return {
        ok: true,
        code: "job_ok",
        job: await resumeJob(message.jobId ?? ""),
      };
    case "JOB_CANCEL":
      return {
        ok: true,
        code: "job_ok",
        job: await cancelJob(message.jobId ?? ""),
      };
    default:
      return {
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      };
  }
}

const sendMessage = vi.fn(defaultWorker);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  toasts.length = 0;
  await db.open();
  await db.jobs.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(defaultWorker);
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
      sendMessage,
    },
  });
});

const FORMAT = new Intl.NumberFormat("en-US");

async function selectAndOpenAnalyze(
  tree: FlattenedTree,
  ids: readonly string[],
): Promise<void> {
  render(
    <Harness
      tree={tree}
      select={(selection) => selection.setSelected(new Set(ids))}
    />,
  );
  fireEvent.click(screen.getByTestId("select"));
  const analyze = await screen.findByRole("button", { name: "Analyze" });
  // The button waits out the first job-row read before enabling.
  await waitFor(() =>
    expect((analyze as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(analyze);
}

describe("BulkBar Analyze (U02)", () => {
  it("opens a confirm showing the count and the estimate; cancel sends nothing", async () => {
    const tree = makeTree(["b1", "b2", "b3", "b4"], ["f9"]);
    const estimate = estimateJobCost({
      bookmarks: ["b1", "b2", "b3", "b4"].map(
        (id) => tree.bookmarks.get(id) as BookmarkItem,
      ),
      kind: "analyze_selection",
    });
    await selectAndOpenAnalyze(tree, ["b1", "b2", "b3", "b4", "f9"]);

    // Folders are filtered out of both the count and the estimate.
    expect(
      await screen.findByRole("dialog", { name: "Analyze 4 bookmarks?" }),
    ).toBeTruthy();
    const estimateText = screen.getByTestId("analyze-estimate").textContent;
    expect(estimateText).toContain(
      `${estimate.requests} AI request${estimate.requests === 1 ? "" : "s"}`,
    );
    expect(estimateText).toContain(
      `~${FORMAT.format(estimate.inputTokens)} tokens`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.jobs === undefined).toBe(false);
    expect(await db.jobs.count()).toBe(0);
  });

  it("Esc closes the confirm and sends nothing", async () => {
    const tree = makeTree(["b1"]);
    await selectAndOpenAnalyze(tree, ["b1"]);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("confirming starts one analyze_selection job and exposes Pause/Cancel", async () => {
    const tree = makeTree(["b1", "b2", "b3"], ["f9"]);
    await selectAndOpenAnalyze(tree, ["b1", "b2", "b3", "f9"]);
    const dialog = await screen.findByRole("dialog", {
      name: "Analyze 3 bookmarks?",
    });
    fireEvent.click(
      within(dialog as HTMLElement).getByRole("button", { name: "Analyze" }),
    );
    // The dialog closes before dispatch.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const start = sendMessage.mock.calls[0] as unknown[];
    const message = start[0] as {
      type: string;
      kind: string;
      bookmarkIds: string[];
    };
    expect(message.type).toBe("JOB_START");
    expect(message.kind).toBe("analyze_selection");
    expect([...message.bookmarkIds].sort()).toEqual(["b1", "b2", "b3"]);

    // The started row streams into the card with live controls.
    const card = await screen.findByRole("status", {
      name: "Selection analysis",
    });
    // The row lands `pending` first, then flips `running` — wait for it.
    await waitFor(() =>
      expect(card.textContent).toContain("Analysis: Running"),
    );
    const pause = screen.getByRole("button", { name: "Pause" });
    const cancel = screen.getByRole("button", { name: "Cancel" });

    fireEvent.click(pause);
    await waitFor(() =>
      expect(card.textContent).toContain("Analysis: Paused"),
    );
    const job = await db.jobs.toCollection().first();
    expect(job?.status).toBe("paused");

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(card.textContent).toContain("Analysis: Canceled"),
    );
    expect((await db.jobs.toCollection().first())?.status).toBe("canceled");

    // Terminal state trades the controls for a dismiss.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Selection analysis" }),
      ).toBeNull(),
    );
  });

  it("a remounted bar re-attaches to a job still running", async () => {
    const tree = makeTree(["b1", "b2"]);
    const selectBoth = (selection: BookmarkSelection): void =>
      selection.setSelected(new Set(["b1", "b2"]));
    const first = render(<Harness tree={tree} select={selectBoth} />);
    fireEvent.click(screen.getByTestId("select"));
    const analyze = (await screen.findByRole("button", {
      name: "Analyze",
    })) as HTMLButtonElement;
    await waitFor(() => expect(analyze.disabled).toBe(false));
    fireEvent.click(analyze);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog as HTMLElement).getByRole("button", { name: "Analyze" }),
    );
    const card = await screen.findByRole("status", {
      name: "Selection analysis",
    });
    await waitFor(() =>
      expect(card.textContent).toContain("Analysis: Running"),
    );
    first.unmount();

    // A fresh mount: the live query re-reads the persisted row, so the
    // controls re-attach — no orphaned job.
    render(<Harness tree={tree} select={selectBoth} />);
    fireEvent.click(screen.getByTestId("select"));
    const remountCard = await screen.findByRole("status", {
      name: "Selection analysis",
    });
    await waitFor(() =>
      expect(remountCard.textContent).toContain("Analysis: Running"),
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("rejects a selection over the protocol cap before any send", async () => {
    // No tree: every selected id counts toward the cap — 50,001 is one over.
    const ids = Array.from(
      { length: MAX_JOB_BOOKMARK_IDS + 1 },
      (_, index) => `b${index}`,
    );
    render(
      <Harness
        orderedIds={ids}
        select={(selection) => selection.setSelected(new Set(ids))}
      />,
    );
    fireEvent.click(screen.getByTestId("select"));
    const analyze = (await screen.findByRole("button", {
      name: "Analyze",
    })) as HTMLButtonElement;
    await waitFor(() => expect(analyze.disabled).toBe(false));
    fireEvent.click(analyze);
    await waitFor(() =>
      expect(
        toasts.some(
          (toast) => toast.error === true && toast.message.includes("50,000"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a folder-only selection without sending", async () => {
    const tree = makeTree(["b1"], ["f9"]);
    render(
      <Harness
        tree={tree}
        select={(selection) => selection.setSelected(new Set(["f9"]))}
      />,
    );
    fireEvent.click(screen.getByTestId("select"));
    const analyze = (await screen.findByRole("button", {
      name: "Analyze",
    })) as HTMLButtonElement;
    await waitFor(() => expect(analyze.disabled).toBe(false));
    fireEvent.click(analyze);
    await waitFor(() =>
      expect(
        toasts.some(
          (toast) =>
            toast.error === true &&
            toast.message.includes("folders have no page"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("double-confirming dispatches only one JOB_START", async () => {
    const tree = makeTree(["b1", "b2"]);
    await selectAndOpenAnalyze(tree, ["b1", "b2"]);
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog as HTMLElement).getByRole("button", {
      name: "Analyze",
    }) as HTMLButtonElement;
    // Two raw clicks in the same tick — React state cannot have flushed the
    // disabled prop; only the ref guard keeps the second click from sending.
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() =>
      expect(
        sendMessage.mock.calls.filter(
          ([m]) => (m as { type?: string }).type === "JOB_START",
        ).length,
      ).toBe(1),
    );
    await screen.findByRole("status", { name: "Selection analysis" });
  });
});
