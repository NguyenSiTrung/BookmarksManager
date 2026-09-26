import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { useState } from "react";
import { QueryInput } from "../../src/ui/components/query-input";
import type { SuggestionSources } from "../../src/search/suggest";

/**
 * `QueryInput` — the shared, controlled search-query input with inline
 * autocomplete (plan Phase 2 Task 3). Pure DOM tests: no chrome, no index —
 * `suggestFilters` does the parsing; this layer owns ARIA combobox wiring,
 * keyboard selection, and text splicing.
 */

const SOURCES: SuggestionSources = {
  tags: ["TypeScript", "machine learning", "Rust"],
  folders: ["Dev", "Work stuff", "Reading"],
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});
afterEach(cleanup);

/** Controlled harness mirroring how surfaces mount QueryInput. */
function Harness({
  initial = "",
  onEscape,
}: {
  initial?: string;
  onEscape?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <QueryInput
      aria-label="Search bookmarks"
      value={value}
      onChange={setValue}
      sources={SOURCES}
      onEscape={onEscape}
    />
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox", {
    name: "Search bookmarks",
  }) as HTMLInputElement;
}

function listbox(): HTMLElement | null {
  return screen.queryByRole("listbox");
}

function optionEls(): HTMLElement[] {
  return screen.queryAllByRole("option");
}

function typeText(text: string): void {
  const el = input();
  // Append at the caret like a real keystroke stream.
  const pos = el.selectionStart ?? el.value.length;
  const next = el.value.slice(0, pos) + text + el.value.slice(pos);
  fireEvent.change(el, { target: { value: next, selectionStart: pos + 1 } });
  el.setSelectionRange(pos + text.length, pos + text.length);
  fireEvent.select(el);
}

describe("QueryInput", () => {
  it("is a combobox that lists key completions for a fresh token", () => {
    render(<Harness />);
    const el = input();
    el.focus();

    typeText("t");
    const list = listbox();
    expect(list).not.toBeNull();
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.getAttribute("aria-controls")).toBe(list?.id);

    const labels = optionEls().map((o) => o.textContent);
    // `t` prefix-matches `tag:` first; `before:`/`after:` don't contain t…
    expect(labels).toContain("tag:");
    expect(labels[0]).toBe("tag:");
  });

  it("arrow keys move the highlight and Enter accepts a suggestion", () => {
    render(<Harness />);
    const el = input();
    el.focus();
    typeText("-f");

    const list = listbox();
    expect(list).not.toBeNull();
    // ArrowDown highlights the first option.
    fireEvent.keyDown(el, { key: "ArrowDown" });
    const options = optionEls();
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(el.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    fireEvent.keyDown(el, { key: "Enter" });
    // `-f` → `-folder:` keeps the negation outside the replaced span.
    expect(el.value).toBe("-folder:");
  });

  it("accepts a clicked option", () => {
    render(<Harness />);
    const el = input();
    el.focus();
    typeText("ta");

    const work = optionEls().find((o) => o.textContent === "tag:");
    expect(work).toBeTruthy();
    fireEvent.mouseDown(work!);
    fireEvent.click(work!);
    expect(el.value).toBe("tag:");
  });

  it("completes values after a key and quotes values with whitespace", () => {
    render(<Harness />);
    const el = input();
    el.focus();
    typeText("tag:");

    // All three tag values appear as options.
    expect(optionEls().map((o) => o.textContent)).toEqual([
      "TypeScript",
      "machine learning",
      "Rust",
    ]);

    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" }); // → "machine learning"
    fireEvent.keyDown(el, { key: "Enter" });

    // Whitespace value is inserted quoted so it tokenizes as one value.
    expect(el.value).toBe('tag:"machine learning"');
    // Caret lands at the end of the insertion.
    expect(el.selectionStart).toBe(el.value.length);
  });

  it("Esc closes the listbox first and only clears once closed", () => {
    let escapes = 0;
    render(<Harness onEscape={() => escapes++} />);
    const el = input();
    el.focus();
    typeText("ta");
    expect(listbox()).not.toBeNull();

    // First Esc: closes the popup — no clear, no parent signal.
    fireEvent.keyDown(el, { key: "Escape" });
    expect(listbox()).toBeNull();
    expect(el.value).toBe("ta");
    expect(escapes).toBe(0);

    // Second Esc: listbox already closed → parent decides (clear/close).
    fireEvent.keyDown(el, { key: "Escape" });
    expect(escapes).toBe(1);
  });

  it("keeps the listbox closed for free-form tokens", () => {
    render(<Harness />);
    const el = input();
    el.focus();

    // Free text, not a key prefix — quoted span means no key completions.
    typeText('"unterminated');
    expect(listbox()).toBeNull();

    // An unknown `key:` is free-form — no value suggestions.
    fireEvent.change(el, { target: { value: "bogus:val" } });
    el.setSelectionRange(9, 9);
    fireEvent.select(el);
    expect(listbox()).toBeNull();
  });

  it("suggests only in the token under the caret", () => {
    render(<Harness initial="tag:Rust " />);
    const el = input();
    el.focus();
    // Past the last token (trailing space) is a fresh context: all keys.
    el.setSelectionRange(9, 9);
    fireEvent.select(el);
    expect(listbox()).not.toBeNull();
    expect(optionEls().length).toBe(7); // the 7 FILTER_KEYS

    // Back inside the `tag:` value region, only tag values are offered.
    el.setSelectionRange(7, 7);
    fireEvent.select(el);
    expect(optionEls().map((o) => o.textContent)).toEqual(["Rust"]);
  });
});
