import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScopeHeading } from "../../src/entrypoints/sidepanel/ScopeHeading";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function NarrowHarness() {
  const [open, setOpen] = useState(false);
  return (
    <ScopeHeading
      title="All bookmarks"
      drawer={{
        open,
        onOpenChange: setOpen,
        children: (
          <button type="button" onClick={() => setOpen(false)}>
            Pick Dev
          </button>
        ),
      }}
    />
  );
}

describe("ScopeHeading", () => {
  it("renders plain heading text when there is no drawer (wide mode)", () => {
    render(<ScopeHeading title="Dev" />);
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes the heading a drawer trigger in narrow mode", () => {
    render(<NarrowHarness />);
    const heading = screen.getByRole("heading", { name: "All bookmarks" });
    expect(heading.querySelector("button")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the drawer, closes on Escape and returns focus to the trigger", async () => {
    render(<NarrowHarness />);
    const trigger = screen.getByRole("button", { name: "All bookmarks" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Browse" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pick Dev" })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes when the content selects something", async () => {
    render(<NarrowHarness />);
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick Dev" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
