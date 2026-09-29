import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TopBar } from "../../src/entrypoints/sidepanel/TopBar";
import { aiVisibility } from "../../src/entrypoints/sidepanel/scope";
import { chooseMenuItem, openMenu } from "./menu-helpers";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function renderTopBar(aiConnected: boolean) {
  const onTools = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <TopBar
      search={<input aria-label="Search bookmarks" />}
      visibility={aiVisibility({ aiConnected, pendingCount: 0 })}
      onTools={onTools}
      onOpenSettings={onOpenSettings}
    />,
  );
  return { onTools, onOpenSettings };
}

describe("TopBar", () => {
  it("keeps a screen-reader-only h1 and renders the search slot", () => {
    renderTopBar(false);
    expect(
      screen.getByRole("heading", { level: 1, name: "Bookmarks Manager" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Search bookmarks")).toBeTruthy();
  });

  it("offers Set up AI instead of Scan when no provider is connected", async () => {
    const { onTools } = renderTopBar(false);
    await openMenu("Tools");
    for (const name of ["Import…", "Export…", "Manage tags…", "Set up AI…"]) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("menuitem", { name: "Scan library…" })).toBeNull();
    await chooseMenuItem("Set up AI…");
    expect(onTools).toHaveBeenCalledWith("set-up-ai");
  });

  it("offers Scan library instead of Set up AI when connected", async () => {
    const { onTools } = renderTopBar(true);
    await openMenu("Tools");
    expect(screen.queryByRole("menuitem", { name: "Set up AI…" })).toBeNull();
    await chooseMenuItem("Scan library…");
    expect(onTools).toHaveBeenCalledWith("scan");
  });

  it("maps Import, Export and Manage tags to their actions", async () => {
    const { onTools } = renderTopBar(false);
    await openMenu("Tools");
    await chooseMenuItem("Import…");
    expect(onTools).toHaveBeenLastCalledWith("import");
    await openMenu("Tools");
    await chooseMenuItem("Export…");
    expect(onTools).toHaveBeenLastCalledWith("export");
    await openMenu("Tools");
    await chooseMenuItem("Manage tags…");
    expect(onTools).toHaveBeenLastCalledWith("manage-tags");
  });

  it("opens settings from the Settings button", () => {
    const { onOpenSettings } = renderTopBar(false);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
