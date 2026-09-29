import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ViewChips } from "../../src/entrypoints/sidepanel/ViewChips";
import { aiVisibility } from "../../src/entrypoints/sidepanel/scope";
import type { SidePanelViewKind } from "../../src/entrypoints/sidepanel/views";
import { chooseMenuItem, openMenu } from "./menu-helpers";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function renderChips(
  options: {
    activeKind?: SidePanelViewKind;
    pendingCount?: number;
    aiConnected?: boolean;
  } = {},
) {
  const { activeKind = "all", pendingCount = 0, aiConnected = false } = options;
  const onSelect = vi.fn();
  render(
    <ViewChips
      activeKind={activeKind}
      pendingCount={pendingCount}
      visibility={aiVisibility({ aiConnected, pendingCount })}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("ViewChips", () => {
  it("shows All, Recent and Untagged with the active one pressed", () => {
    renderChips({ activeKind: "recent" });
    expect(
      screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "Recent" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Untagged" })).toBeTruthy();
  });

  it("selects a primary chip", () => {
    const onSelect = renderChips();
    fireEvent.click(screen.getByRole("button", { name: "Untagged" }));
    expect(onSelect).toHaveBeenCalledWith("untagged");
  });

  it("lists only Duplicates in More without a provider or pending items", async () => {
    renderChips();
    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: "Duplicates" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Review/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Restructure" })).toBeNull();
  });

  it("lists every view when connected and selects from the menu", async () => {
    const onSelect = renderChips({ aiConnected: true });
    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: /Review suggestions/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Restructure" })).toBeTruthy();
    await chooseMenuItem("Restructure");
    expect(onSelect).toHaveBeenCalledWith("restructure");
  });

  it("puts the pending count on More and on the Review item", async () => {
    renderChips({ pendingCount: 3 });
    const more = screen.getByRole("button", { name: /^More/ });
    expect(more.textContent).toContain("3");
    await openMenu(/^More/);
    expect(
      screen.getByRole("menuitem", { name: /Review suggestions/ }).textContent,
    ).toContain("3");
  });

  it("names the active view on the More chip when it lives in the menu", () => {
    renderChips({ activeKind: "duplicates" });
    const more = screen.getByRole("button", { name: /^Duplicates/ });
    expect(more.getAttribute("data-active")).toBe("true");
  });
});
