import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as restore from "../../src/undo/restore";
import type { UndoResult } from "../../src/undo/restore";
import {
  UndoToast,
  useUndoToastController,
} from "../../src/entrypoints/sidepanel/UndoToast";

/**
 * P4 review fix #1 — the Undo toast's re-entry guard.
 *
 * `undoLatest` is serialized internally, but a double-click (or a click that
 * lands while a slow restore is still outstanding) would otherwise queue a
 * SECOND undo and pop two snapshots. `useUndoToastController().undo` gates on
 * an in-flight ref: a second call while one is outstanding is ignored, so
 * `undoLatest` runs exactly once.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness() {
  const controller = useUndoToastController();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          controller.showToast({ message: "Did a thing", undoable: true })
        }
      >
        show
      </button>
      <button
        type="button"
        onClick={() => {
          // Two rapid clicks with no await between them — the second must be
          // ignored while the first is outstanding.
          void controller.undo();
          void controller.undo();
        }}
      >
        undo-twice
      </button>
      <UndoToast
        toast={controller.toast}
        onUndo={() => void controller.undo()}
        onDismiss={controller.dismiss}
      />
    </>
  );
}

describe("Undo re-entry guard", () => {
  it("runs undoLatest once for two rapid undo() calls", async () => {
    let release!: (result: UndoResult) => void;
    const spy = vi.spyOn(restore, "undoLatest").mockImplementation(
      () =>
        new Promise<UndoResult>((resolve) => {
          release = resolve;
        }),
    );

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));

    // The second call was gated before reaching undoLatest.
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        ok: true,
        restoredIds: [],
        idMap: {},
        fellBackToOther: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId("undo-toast").textContent).toContain("Undone"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("allows a later undo() once the outstanding one has settled", async () => {
    const spy = vi
      .spyOn(restore, "undoLatest")
      .mockResolvedValue({
        ok: true,
        restoredIds: [],
        idMap: {},
        fellBackToOther: false,
      });

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));
    await waitFor(() =>
      expect(screen.getByTestId("undo-toast").textContent).toContain("Undone"),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // The gate is released after the first call settles — a fresh pair of
    // clicks runs undoLatest exactly once more.
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
