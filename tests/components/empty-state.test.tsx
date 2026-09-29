import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../../src/ui/components/empty-state";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("EmptyState", () => {
  it("renders the title and hint", () => {
    render(<EmptyState title="Nothing here" hint="Add something." />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("Add something.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an action button that fires onSelect", () => {
    const onSelect = vi.fn();
    render(<EmptyState title="Empty" action={{ label: "Import…", onSelect }} />);
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
