import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The panels have their own suites; the shell test only needs stand-ins.
vi.mock("../../src/entrypoints/options/ProviderSetup", () => ({
  ProviderSetup: () => <section aria-label="stub provider" />,
}));
vi.mock("../../src/entrypoints/options/LlmProviderSetup", () => ({
  LlmProviderSetup: () => <section aria-label="stub llm" />,
}));
vi.mock("../../src/entrypoints/options/DecisionSettings", () => ({
  DecisionSettings: () => <section aria-label="stub decisions" />,
}));
vi.mock("../../src/entrypoints/options/SentLog", () => ({
  SentLog: () => <section aria-label="stub sent log" />,
}));
vi.mock("../../src/entrypoints/options/DeleteAllData", () => ({
  DeleteAllData: () => <section aria-label="stub delete all" />,
}));

import { OptionsApp } from "../../src/entrypoints/options/OptionsApp";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = "";
});

describe("OptionsApp shell", () => {
  it("has one page title and keeps every panel mounted inside main", () => {
    render(<OptionsApp />);

    expect(
      screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent),
    ).toEqual(["Bookmarks Manager Options"]);

    // Hidden panels stay mounted (form state survives navigation) — find
    // them with hidden: true rather than expecting them invisible forever.
    const main = screen.getByRole("main");
    for (const name of [
      "stub provider",
      "stub llm",
      "stub decisions",
      "stub sent log",
      "stub delete all",
    ]) {
      expect(
        within(main).getByRole("region", { name, hidden: true }),
      ).toBeTruthy();
    }
  });

  it("links each nav entry to a panel that exists on the page", () => {
    const { container } = render(<OptionsApp />);
    const nav = screen.getByRole("navigation", { name: "Options sections" });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([
      "Connections",
      "Permissions",
      "Activity",
      "Data",
    ]);
    for (const link of links) {
      const id = link.getAttribute("href")?.slice(1) ?? "";
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("shows the Connections panel by default and marks its nav item current", () => {
    render(<OptionsApp />);
    const nav = screen.getByRole("navigation", { name: "Options sections" });

    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["Connections"]);

    // Connections content is visible; another panel's is not.
    expect(
      screen.getByRole("region", { name: "stub provider" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "stub sent log" }),
    ).toBeNull();
  });

  it("switches panels when a nav entry is clicked", () => {
    render(<OptionsApp />);
    const nav = screen.getByRole("navigation", { name: "Options sections" });

    fireEvent.click(within(nav).getByRole("link", { name: /Activity/ }));

    expect(
      screen.getByRole("region", { name: "stub sent log" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "stub provider" })).toBeNull();
    expect(location.hash).toBe("#activity");
    expect(
      within(nav)
        .getByRole("link", { name: /Activity/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("restores the panel named by the hash on load", () => {
    location.hash = "#data";
    render(<OptionsApp />);

    expect(
      screen.getByRole("region", { name: "stub delete all" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "stub provider" })).toBeNull();
  });
});
