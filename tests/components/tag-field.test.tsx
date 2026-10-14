import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TagDef } from "../../src/schemas/meta";
import { TagField } from "../../src/ui/components/tag-field";
import type { TagFieldChip } from "../../src/ui/components/tag-field";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

const AVAILABLE_TAGS: readonly TagDef[] = [
  {
    name: "Frontend",
    nameKey: "frontend",
    color: "#3b82f6",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    name: "Framework",
    nameKey: "framework",
    color: "#10b981",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    name: "Rust",
    nameKey: "rust",
    color: "#f97316",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];

function Harness({
  initialChips = [],
  availableTags = AVAILABLE_TAGS,
}: {
  initialChips?: readonly TagFieldChip[];
  availableTags?: readonly TagDef[];
}) {
  const [chips, setChips] = useState<TagFieldChip[]>([...initialChips]);
  const [input, setInput] = useState("");

  const handleCommit = (explicitLabel?: string): void => {
    const label = (explicitLabel ?? input).trim();
    const key = label.toLowerCase();
    if (key === "" || chips.some((c) => c.key === key)) return;
    setChips((prev) => [...prev, { key, label }]);
    setInput("");
  };

  return (
    <TagField
      chips={chips}
      input={input}
      availableTags={availableTags}
      onInputChange={setInput}
      onCommit={handleCommit}
      onRemove={(key) => setChips((prev) => prev.filter((c) => c.key !== key))}
    />
  );
}

describe("TagField (UX-01)", () => {
  it("renders matching unselected tags with color dots when focused and typing", () => {
    render(
      <Harness initialChips={[{ key: "rust", label: "Rust" }]} />,
    );

    const input = screen.getByLabelText("New tag name");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "fr" } });

    const list = screen.getByTestId("tag-field-suggestions");
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Frontend", "Framework"]);

    // Color dot rendered on suggestion
    const dot = options[0]?.querySelector("[data-tag-dot]") as HTMLElement | null;
    expect(dot).not.toBeNull();
    expect(dot?.style.backgroundColor).toBe("rgb(59, 130, 246)");

    // Already-selected "Rust" is excluded even when query is cleared and ArrowDown opens list
    fireEvent.change(input, { target: { value: "ru" } });
    expect(screen.queryByTestId("tag-field-suggestions")).toBeNull();
  });

  it("navigates suggestions with ArrowDown/ArrowUp and commits via Enter or MouseDown", () => {
    render(<Harness />);
    const input = screen.getByLabelText("New tag name") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "fr" } });

    // ArrowDown highlights first ("Frontend"), second ArrowDown highlights "Framework"
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    const list = screen.getByTestId("tag-field-suggestions");
    const options = within(list).getAllByRole("option");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    // ArrowUp moves back to "Frontend"
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    // Enter commits "Frontend" and clears the input
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("group", { name: "Frontend" })).toBeTruthy();
    expect(input.value).toBe("");

    // Typing again and MouseDown on a suggestion commits it
    fireEvent.change(input, { target: { value: "fr" } });
    const nextList = screen.getByTestId("tag-field-suggestions");
    const frameworkOption = within(nextList).getByRole("option", {
      name: "Framework",
    });
    fireEvent.mouseDown(frameworkOption);
    expect(screen.getByRole("group", { name: "Framework" })).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("commits raw typed text on Enter or comma when no suggestion is highlighted", () => {
    render(<Harness />);
    const input = screen.getByLabelText("New tag name") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "CustomTag" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("group", { name: "CustomTag" })).toBeTruthy();
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "CommaTag" } });
    fireEvent.keyDown(input, { key: "," });
    expect(screen.getByRole("group", { name: "CommaTag" })).toBeTruthy();
  });

  it("closes suggestions on Escape without losing input focus", () => {
    render(<Harness />);
    const input = screen.getByLabelText("New tag name") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "fr" } });

    expect(screen.getByTestId("tag-field-suggestions")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("tag-field-suggestions")).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("renders staged chips with their color from availableTags", () => {
    render(
      <Harness initialChips={[{ key: "frontend", label: "Frontend" }]} />,
    );
    const chip = screen.getByRole("group", { name: "Frontend" });
    const dot = chip.querySelector("span[aria-hidden='true']") as HTMLElement | null;
    expect(dot?.style.backgroundColor).toBe("rgb(59, 130, 246)");
  });
});
