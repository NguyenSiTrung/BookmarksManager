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
import { db } from "../../src/db/database";
import { DeleteAllData } from "../../src/entrypoints/options/DeleteAllData";
import { PRESETS } from "../../src/net/presets";
import {
  DELETE_ALL_DATABASE_BLOCKED_MESSAGE,
  DELETE_ALL_DONE_MESSAGE,
  DELETE_ALL_ITEMS,
} from "../../src/security/delete-all";
import {
  createFakeBookmarks,
  type FakeBookmarksApi,
} from "../fakes/chrome-bookmarks";

/**
 * jsdom + RTL under Vitest globals-off: the act environment flag and manual
 * cleanup replace the auto-setup RTL only performs when test globals exist.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let bookmarks: FakeBookmarksApi;
let storageStore: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let granted: Set<string>;
let containsSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  bookmarks = createFakeBookmarks({
    bookmarksBar: [
      { title: "Example", url: "https://example.com/" },
      {
        title: "Reading",
        children: [{ title: "Nested", url: "https://nested.example/" }],
      },
    ],
  });
  storageStore = {
    "providerKey:typesafe": { v: 1, iv: "a", ct: "b" },
    typesafe: { model: "jev-latest", keySuffix: "cdef" },
  };
  sessionStore = { scratch: 1 };
  granted = new Set([PRESETS.typesafe.permissionPattern]);
  containsSpy = vi.fn(async ({ origins }: { origins?: string[] }) =>
    (origins ?? []).some((origin) => granted.has(origin)),
  );
  removeSpy = vi.fn(async ({ origins }: { origins?: string[] }) => {
    for (const origin of origins ?? []) granted.delete(origin);
    return true;
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        clear: vi.fn(async () => {
          for (const key of Object.keys(storageStore)) delete storageStore[key];
        }),
      },
      session: {
        clear: vi.fn(async () => {
          for (const key of Object.keys(sessionStore)) delete sessionStore[key];
        }),
      },
    },
    permissions: { contains: containsSpy, remove: removeSpy },
    bookmarks,
  });
  if (!db.isOpen()) {
    await db.open();
  }
  await Promise.all(db.tables.map((table) => table.clear()));
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

function openDialog() {
  fireEvent.click(
    screen.getByRole("button", { name: /delete all extension data/i }),
  );
}

/**
 * Replace `db.delete` with a stub. Dexie types `delete()` as returning a
 * `PromiseExtended` (a Promise carrying extra helpers); the stubs below only
 * need the Promise surface, so the cast is confined to this one helper.
 */
function stubDatabaseDelete(implementation: () => Promise<void>): void {
  vi.spyOn(db, "delete").mockImplementation(
    implementation as unknown as typeof db.delete,
  );
}

describe("DeleteAllData confirm dialog", () => {
  it("lists everything that will be deleted", async () => {
    render(<DeleteAllData />);
    openDialog();
    const dialog = await screen.findByRole("dialog");
    const view = within(dialog);
    for (const item of DELETE_ALL_ITEMS) {
      expect(view.getByText(item)).toBeTruthy();
    }
    // The reassurance is present and unambiguous.
    expect(view.getByText(/native chrome bookmarks are untouched/i)).toBeTruthy();
  });

  it("does nothing until the user confirms", async () => {
    render(<DeleteAllData />);
    openDialog();
    await screen.findByRole("dialog");
    // Cancel closes the dialog without deleting anything.
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(storageStore["typesafe"]).toBeDefined();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
  });
});

describe("DeleteAllData confirm flow", () => {
  it("deletes the database, clears storage, removes granted permissions, and shows the first-run state", async () => {
    await db.bookmarkMeta.put({
      id: "b1",
      tags: ["reading"],
      updatedAt: "2026-09-26T10:00:00.000Z",
    });
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );

    await screen.findByText(DELETE_ALL_DONE_MESSAGE);

    // Storage wiped (local + session).
    expect(storageStore).toEqual({});
    expect(sessionStore).toEqual({});
    // Only the granted origin removed.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith({
      origins: [PRESETS.typesafe.permissionPattern],
    });
    // First-run state: the confirm dialog is gone and the delete button is
    // replaced by the completed message.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /delete all extension data/i }),
    ).toBeNull();
  });

  it("leaves native Chrome bookmarks untouched", async () => {
    const before = JSON.stringify(await bookmarks.getTree());
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );
    await screen.findByText(DELETE_ALL_DONE_MESSAGE);
    expect(JSON.stringify(await bookmarks.getTree())).toBe(before);
  });

  it("surfaces an error and keeps the dialog usable when deletion fails", async () => {
    // A broken storage clear must not silently claim success.
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          clear: vi.fn(async () => {
            throw new Error("storage unavailable");
          }),
        },
      },
      permissions: { contains: containsSpy, remove: removeSpy },
      bookmarks,
    });
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );
    // The dialog stays open with an error; the first-run message is absent.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/went wrong/i);
    expect(screen.queryByText(DELETE_ALL_DONE_MESSAGE)).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps a failure visible when the dialog was dismissed mid-operation", async () => {
    let rejectStorage: ((error: Error) => void) | undefined;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          clear: vi.fn(
            () =>
              new Promise<void>((_, reject) => {
                rejectStorage = reject;
              }),
          ),
        },
      },
      permissions: { contains: containsSpy, remove: removeSpy },
      bookmarks,
    });
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );
    await waitFor(() => expect(rejectStorage).toBeDefined());
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rejectStorage!(new Error("storage unavailable"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/went wrong/i);
  });

  it("preserves an already-visible failure after Cancel until an explicit retry", async () => {
    let rejectRetry: ((error: Error) => void) | undefined;
    let firstAttempt = true;
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          clear: vi.fn(async () => {
            if (firstAttempt) {
              firstAttempt = false;
              throw new Error("storage unavailable");
            }
            return new Promise<void>((_, reject) => {
              rejectRetry = reject;
            });
          }),
        },
      },
      permissions: { contains: containsSpy, remove: removeSpy },
      bookmarks,
    });
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/went wrong/i);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", {
          name: /delete everything/i,
        }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("alert").textContent).toMatch(/went wrong/i);

    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );
    await waitFor(() => expect(rejectRetry).toBeDefined());
    expect(screen.queryByRole("alert")).toBeNull();
    rejectRetry!(new Error("storage still unavailable"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/went wrong/i);
  });
});

// ---------------------------------------------------------------------------
// Robustness of the reset (review fix P5-FIX #1 and #2)
// ---------------------------------------------------------------------------

describe("DeleteAllData partial failures", () => {
  it("stays dismissible while the reset is running, then reports the result", async () => {
    const pending = { called: false, resolve: (): void => {} };
    stubDatabaseDelete(
      () =>
        new Promise<void>((resolve) => {
          pending.called = true;
          pending.resolve = resolve;
        }),
    );
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );

    // Mid-flight: Cancel is NOT disabled (the operation is idempotent and safe
    // to leave running) and dismissing the dialog actually closes it.
    const cancel = await screen.findByRole("button", { name: /cancel/i });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The reset is not tied to the dialog: it is still running here, and the
    // section reports the result once it lands.
    await waitFor(() => expect(pending.called).toBe(true));
    pending.resolve();
    await screen.findByText(DELETE_ALL_DONE_MESSAGE);
  });

  it("reports a database that could not be dropped instead of claiming a clean wipe", async () => {
    // A blocked `indexedDB.deleteDatabase` never settles; the module's timeout
    // turns that into `databaseDeleted: false` and the UI must say so.
    stubDatabaseDelete(() => new Promise<void>(() => {}));
    render(
      <DeleteAllData
        deleteOptions={{ databaseTimeoutMs: 30, releaseGraceMs: 5 }}
      />,
    );
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );

    const alert = await screen.findByRole(
      "alert",
      {},
      { timeout: 1_000 },
    );
    expect(alert.textContent).toContain(DELETE_ALL_DATABASE_BLOCKED_MESSAGE);
    expect(screen.queryByText(DELETE_ALL_DONE_MESSAGE)).toBeNull();
  });

  it("names the host origins it could not release", async () => {
    // `remove` reports false AND the grant survives the follow-up check, so the
    // origin lands in `permissionsFailed`.
    removeSpy.mockImplementation(async () => false);
    render(<DeleteAllData />);
    openDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /delete everything/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be released/i);
    expect(alert.textContent).toContain(PRESETS.typesafe.permissionPattern);
    expect(alert.textContent).toMatch(/chrome:\/\/extensions/);
  });
});
