import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  escapeXml,
  registerOmnibox,
  toSuggestions,
} from "../../src/search/omnibox";
import type {
  OmniboxDeps,
  OmniboxSurface,
  SuggestResult,
} from "../../src/search/omnibox";
import { buildSearchHandle } from "../../src/search/run";
import type { SearchIndexHandle } from "../../src/search/run";
import type { FlattenedTree } from "../../src/sync/tree";

/**
 * Phase 3 Task 2 — the `bm` omnibox keyword. A SESSION index is built when
 * omnibox input starts (and rebuilt if the MV3 worker missed the event) and
 * dropped on enter/cancel. Suggestions are capped at 8 and every
 * user-derived string is XML-escaped (& < > " ') because Chrome parses
 * descriptions as a small XML dialect. Entered text that isn't a suggestion
 * opens the TOP OPENABLE hit; `javascript:`/`data:` are never opened and
 * never suggested. All listeners are total — a thrown error must never
 * escape into Chrome, and no query or bookmark data is logged.
 */

interface FakeOmnibox {
  api: OmniboxSurface;
  fireStarted(): void;
  fireChanged(text: string): Promise<SuggestResult[]>;
  fireEntered(text: string, disposition: string): Promise<void>;
  fireCancelled(): void;
  defaultSuggestions: { description: string }[];
  suggestedCalls: SuggestResult[][];
}

function fakeOmnibox(): FakeOmnibox {
  const listeners: {
    started: (() => void)[];
    changed: ((text: string, suggest: (r: SuggestResult[]) => void) => void)[];
    entered: ((text: string, disposition: string) => void)[];
    cancelled: (() => void)[];
  } = { started: [], changed: [], entered: [], cancelled: [] };
  const fake: FakeOmnibox = {
    api: {
      setDefaultSuggestion: (r: { description: string }) => {
        fake.defaultSuggestions.push(r);
      },
      onInputStarted: {
        addListener: (fn: () => void) => listeners.started.push(fn),
      },
      onInputChanged: {
        addListener: (
          fn: (text: string, suggest: (r: SuggestResult[]) => void) => void,
        ) => listeners.changed.push(fn),
      },
      onInputEntered: {
        addListener: (fn: (text: string, disposition: string) => void) =>
          listeners.entered.push(fn),
      },
      onInputCancelled: {
        addListener: (fn: () => void) => listeners.cancelled.push(fn),
      },
    },
    defaultSuggestions: [],
    suggestedCalls: [],
    fireStarted() {
      for (const fn of listeners.started) fn();
    },
    async fireChanged(text) {
      for (const fn of listeners.changed) {
        fn(text, (r) => {
          fake.suggestedCalls.push(r);
        });
      }
      // Let any async index build resolve.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return fake.suggestedCalls.at(-1) ?? [];
    },
    async fireEntered(text, disposition) {
      for (const fn of listeners.entered) fn(text, disposition);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    fireCancelled() {
      for (const fn of listeners.cancelled) fn();
    },
  };
  return fake;
}

const TREE: FlattenedTree = {
  folders: new Map([
    [
      "1",
      {
        id: "1",
        title: "Bookmarks bar",
        path: [],
        parentId: "0",
        childIds: ["a1", "a2", "a3"],
        kind: "folder" as const,
        isRoot: true,
        isManaged: false,
        depth: 0,
      },
    ],
  ]),
  bookmarks: new Map([
    [
      "a1",
      {
        id: "a1",
        title: 'Fish & "Chips" <b>',
        url: "https://fish.example/?a=1&b='2'",
        parentId: "1",
        path: ["Bookmarks bar"],
        kind: "bookmark" as const,
        isRoot: false,
        isManaged: false,
        depth: 1,
      },
    ],
    [
      "a2",
      {
        id: "a2",
        title: "Payload",
        url: "javascript:alert(1)",
        parentId: "1",
        path: ["Bookmarks bar"],
        kind: "bookmark" as const,
        isRoot: false,
        isManaged: false,
        depth: 1,
      },
    ],
    [
      "a3",
      {
        id: "a3",
        title: "Second",
        url: "https://second.example/",
        parentId: "1",
        path: ["Bookmarks bar"],
        kind: "bookmark" as const,
        isRoot: false,
        isManaged: false,
        depth: 1,
      },
    ],
  ]),
};

function makeHandle(tree: FlattenedTree = TREE): SearchIndexHandle {
  return buildSearchHandle(tree, [], []);
}

function deps(overrides: Partial<OmniboxDeps> = {}): OmniboxDeps {
  return {
    load: vi.fn(async () => makeHandle()),
    open: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("escapeXml", () => {
  it("escapes all five omnibox-significant characters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });
});

describe("toSuggestions", () => {
  it("caps at 8 and XML-escapes title and URL", () => {
    const bookmarks = new Map(
      Array.from({ length: 12 }, (_, i) => [
        `x${i}`,
        {
          id: `x${i}`,
          title: `Common term ${i}`,
          url: `https://x${i}.example/`,
          parentId: "1",
          path: ["Bookmarks bar"],
          kind: "bookmark" as const,
          isRoot: false,
          isManaged: false,
          depth: 1,
        },
      ]),
    );
    const handle = makeHandle({ folders: TREE.folders, bookmarks });
    const results = toSuggestions(handle, "common");
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.length).toBe(8);
    for (const r of results) {
      expect(r.content).toMatch(/^https:\/\//);
      expect(r.description).toContain("Common term");
      expect(r.description).not.toContain("<b>");
    }
  });

  it("escapes dangerous characters in descriptions", () => {
    const results = toSuggestions(makeHandle(), "fish");
    expect(results).toHaveLength(1);
    expect(results[0]?.description).toContain("Fish &amp;");
    expect(results[0]?.description).toContain("&quot;Chips&quot;");
    expect(results[0]?.description).toContain("&lt;b&gt;");
    expect(results[0]?.description).toContain("&amp;b=&apos;2&apos;");
    expect(results[0]?.content).toBe("https://fish.example/?a=1&b='2'");
  });

  it("never suggests unopenable URLs", () => {
    const results = toSuggestions(makeHandle(), "payload");
    expect(results).toEqual([]);
  });
});

describe("registerOmnibox", () => {
  let omnibox: FakeOmnibox;

  beforeEach(() => {
    omnibox = fakeOmnibox();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("builds the session index on input start and suggests on change", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await Promise.resolve();
    expect(d.load).toHaveBeenCalledTimes(1);
    const results = await omnibox.fireChanged("fish");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("https://fish.example/?a=1&b='2'");
  });

  it("sets a static default suggestion", () => {
    registerOmnibox(omnibox.api, deps());
    omnibox.fireStarted();
    expect(omnibox.defaultSuggestions.length).toBeGreaterThan(0);
  });

  it("builds lazily when input start was missed (worker wake)", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    const results = await omnibox.fireChanged("fish");
    expect(d.load).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it("reuses one session index across keystrokes", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    await omnibox.fireChanged("second");
    expect(d.load).toHaveBeenCalledTimes(1);
  });

  it("drops the session on cancel and rebuilds next time", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    omnibox.fireCancelled();
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    expect(d.load).toHaveBeenCalledTimes(2);
  });

  it("drops the session after enter", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    await omnibox.fireEntered(
      "https://fish.example/?a=1&b='2'",
      "newForegroundTab",
    );
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    expect(d.load).toHaveBeenCalledTimes(2);
  });

  it("maps omnibox dispositions to open dispositions", async () => {
    for (const [disposition, expected] of [
      ["currentTab", "current"],
      ["newForegroundTab", "foreground"],
      ["newBackgroundTab", "background"],
    ] as const) {
      const d = deps();
      registerOmnibox(omnibox.api, d);
      omnibox.fireStarted();
      await omnibox.fireChanged("fish");
      await omnibox.fireEntered("https://fish.example/?a=1&b='2'", disposition);
      expect(d.open, disposition).toHaveBeenCalledWith(
        "https://fish.example/?a=1&b='2'",
        expected,
      );
    }
  });

  it("free text opens the top openable hit", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("second");
    await omnibox.fireEntered("second", "currentTab");
    expect(d.open).toHaveBeenCalledWith("https://second.example/", "current");
  });

  it("never opens javascript:/data: even as entered content", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("payload");
    await omnibox.fireEntered("javascript:alert(1)", "currentTab");
    expect(d.open).not.toHaveBeenCalled();
    await omnibox.fireEntered("data:text/html,x", "currentTab");
    expect(d.open).not.toHaveBeenCalled();
  });

  it("stays total: load failure → empty suggestions, enter no-ops", async () => {
    const d = deps({ load: vi.fn(async () => {
      throw new Error("db gone");
    }) });
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await Promise.resolve();
    const results = await omnibox.fireChanged("fish");
    expect(results).toEqual([]);
    await omnibox.fireEntered("fish", "currentTab"); // must not throw
    expect(d.open).not.toHaveBeenCalled();
  });

  it("stays total when open rejects", async () => {
    const d = deps({
      open: vi.fn(async () => {
        throw new Error("tabs gone");
      }),
    });
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("fish");
    await omnibox.fireEntered(
      "https://fish.example/?a=1&b='2'",
      "newForegroundTab",
    );
    expect(d.open).toHaveBeenCalled();
  });

  it("logs nothing — no query or bookmark data leaves the handler", async () => {
    const d = deps();
    registerOmnibox(omnibox.api, d);
    omnibox.fireStarted();
    await omnibox.fireChanged("fish secret");
    await omnibox.fireEntered("https://fish.example/?a=1&b='2'", "currentTab");
    for (const spy of [console.log, console.warn, console.error]) {
      for (const call of (spy as ReturnType<typeof vi.fn>).mock.calls) {
        expect(String(call.join(" "))).not.toContain("fish");
        expect(String(call.join(" "))).not.toContain("secret");
      }
    }
  });
});
