import { describe, expect, it } from "vitest";
import {
  displayDomain,
  folderLabel,
  formatAdded,
  visibleTags,
} from "../../src/entrypoints/sidepanel/row-text";

describe("displayDomain", () => {
  it("returns the hostname", () => {
    expect(displayDomain("https://work.example/design/system")).toBe(
      "work.example",
    );
  });

  it("strips a leading www.", () => {
    expect(displayDomain("https://www.example.com/a")).toBe("example.com");
  });

  it("drops the port", () => {
    expect(displayDomain("http://localhost:3000/a")).toBe("localhost");
  });

  it("falls back to the raw text when the URL does not parse", () => {
    expect(displayDomain("not a url")).toBe("not a url");
    expect(displayDomain("")).toBe("");
  });

  it("falls back to the raw text when there is no hostname", () => {
    expect(displayDomain("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });
});

describe("visibleTags", () => {
  it("shows everything at or under the cap", () => {
    expect(visibleTags(["a", "b"], 2)).toEqual({ shown: ["a", "b"], hidden: [] });
    expect(visibleTags([], 2)).toEqual({ shown: [], hidden: [] });
  });

  it("splits tags over the cap into shown and hidden", () => {
    expect(visibleTags(["a", "b", "c", "d"], 2)).toEqual({
      shown: ["a", "b"],
      hidden: ["c", "d"],
    });
  });
});

describe("folderLabel", () => {
  it("is empty for no path", () => {
    expect(folderLabel([])).toBe("");
  });

  it("joins one or two segments", () => {
    expect(folderLabel(["Bookmarks bar"])).toBe("Bookmarks bar");
    expect(folderLabel(["Other bookmarks", "Stuff"])).toBe(
      "Other bookmarks / Stuff",
    );
  });

  it("keeps the last two segments with a leading ellipsis when deeper", () => {
    expect(folderLabel(["Bookmarks bar", "Dev", "Deep"])).toBe("… / Dev / Deep");
  });
});

describe("formatAdded", () => {
  it("formats a date as day, short month, year", () => {
    expect(formatAdded(Date.UTC(2026, 2, 12, 12), "en-US")).toBe("Mar 12, 2026");
  });

  it("returns undefined for a missing or non-finite value", () => {
    expect(formatAdded(undefined)).toBeUndefined();
    expect(formatAdded(Number.NaN)).toBeUndefined();
  });
});
