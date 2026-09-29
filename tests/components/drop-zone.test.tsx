import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DropZone } from "../../src/ui/components/drop-zone";

const onFile = vi.fn();

const PROPS = {
  label: "Drop your bookmarks file here",
  activeLabel: "Drop to import",
  hint: "or click to browse — JSON, Netscape HTML, or CSV · up to 20 MiB",
  accept: ".json,.html,.htm,.csv",
  inputTestId: "import-file-input",
  onFile,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

function zone(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Drop your bookmarks file here",
  }) as HTMLButtonElement;
}

describe("DropZone", () => {
  afterEach(() => {
    cleanup();
    onFile.mockClear();
  });

  it("renders label, hint, and the sr-only input with its testid and accept", () => {
    render(<DropZone {...PROPS} />);
    expect(screen.getByText(PROPS.label)).toBeTruthy();
    expect(screen.getByText(PROPS.hint)).toBeTruthy();
    const input = screen.getByTestId(
      "import-file-input",
    ) as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe(".json,.html,.htm,.csv");
    expect(input.getAttribute("type")).toBe("file");
    // sr-only, not display:none — Playwright's toBeVisible() must keep
    // passing, and aria-hidden keeps it out of the tab order.
    expect(input.className).toContain("sr-only");
    expect(input.getAttribute("aria-hidden")).toBe("true");
    expect(input.tabIndex).toBe(-1);
  });

  it("highlights and swaps the line while a drag is over, reverts on dragleave", () => {
    render(<DropZone {...PROPS} />);
    const btn = zone();
    fireEvent.dragOver(btn, { dataTransfer: {} });
    // Armed: primary border + accent fill (the combined string can't be
    // confused with the idle hover:border-primary/50 variant), and the
    // accessible name follows the swapped line.
    expect(btn.className).toContain("border-primary bg-accent/50");
    expect(btn.getAttribute("aria-label")).toBe("Drop to import");
    expect(screen.getByText("Drop to import")).toBeTruthy();
    fireEvent.dragLeave(btn);
    expect(btn.className).toContain("border-input");
    expect(btn.className).not.toContain("bg-accent/50");
    expect(screen.getByText(PROPS.label)).toBeTruthy();
    // Idle accessible name is back.
    expect(zone()).toBeTruthy();
  });

  it("routes a dropped file to onFile and disarms the highlight", () => {
    render(<DropZone {...PROPS} />);
    const file = new File(["[]"], "bookmarks.json", {
      type: "application/json",
    });
    fireEvent.drop(zone(), { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(zone().className).toContain("border-input");
    expect(zone().className).not.toContain("bg-accent/50");
    expect(screen.getByText(PROPS.label)).toBeTruthy();
  });

  it("routes a picked file (input change) to onFile", () => {
    render(<DropZone {...PROPS} />);
    const file = new File(["a,b"], "bookmarks.csv", { type: "text/csv" });
    fireEvent.change(screen.getByTestId("import-file-input"), {
      target: { files: [file] },
    });
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("clicking the button opens the OS picker via the hidden input", () => {
    render(<DropZone {...PROPS} />);
    const input = screen.getByTestId("import-file-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(zone());
    expect(click).toHaveBeenCalledTimes(1);
  });
});
