import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The sections have their own suites; the shell test only needs stand-ins.
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
});

describe("OptionsApp shell", () => {
  it("has one page title and puts every section inside the main landmark", () => {
    render(<OptionsApp />);

    expect(
      screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent),
    ).toEqual(["Bookmarks Manager Options"]);

    const main = screen.getByRole("main");
    for (const name of [
      "stub provider",
      "stub llm",
      "stub decisions",
      "stub sent log",
      "stub delete all",
    ]) {
      expect(within(main).getByRole("region", { name })).toBeTruthy();
    }
  });

  it("links each nav entry to a section that exists on the page", () => {
    const { container } = render(<OptionsApp />);
    const nav = screen.getByRole("navigation", { name: "Options sections" });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([
      "AI providers",
      "Decisions",
      "Activity",
      "Data",
    ]);
    for (const link of links) {
      const id = link.getAttribute("href")?.slice(1) ?? "";
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("marks the first section current until scrolling says otherwise", () => {
    // jsdom has no IntersectionObserver; the shell must still render.
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<OptionsApp />);
    const nav = screen.getByRole("navigation", { name: "Options sections" });

    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "true")
        .map((link) => link.textContent),
    ).toEqual(["AI providers"]);
  });
});
