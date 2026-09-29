# Side Panel Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calm the side panel's content: list rows show title plus domain and reveal their controls on demand, duplicate groups show only what differs (folders), and every empty case gets a title, a hint and at most one next-step button.

**Architecture:** Pure text helpers (`row-text.ts`, `empty-state.ts`) carry all formatting and copy decisions so they are unit-testable. A small `EmptyState` UI component renders them. `BookmarkList`, `DuplicatesView` and `ReviewView` gain an optional `empty` node prop with today's text as the default; `App` builds it from the active view. `Option` (the list row) and `MemberRow` (the duplicates row) change presentation only.

**Tech Stack:** React 19, TypeScript (strict), Tailwind 4, Radix UI, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-sidepanel-content-design.md` (amended by Task 0 of this plan).

## Global Constraints

- Commit per task, locally. **Never** `git push`, `git pull` or `git fetch` (AGENTS.md Git Policy).
- Track work with `bd`, not markdown TODO lists or TodoWrite (AGENTS.md).
- Zero new network requests. Do not add `fetch` anywhere.
- Row height stays `LIST_ROW_HEIGHT = 40` (the virtualizer depends on it). The Grid layout is unchanged.
- Rows show at most 2 tag chips, then a `+N` chip.
- Tests use role-based queries (`getByRole`) where possible, matching the existing suites. Search box is `getByRole("combobox", { name: "Search bookmarks" })`.
- Radix dropdown triggers open on `pointerDown` in jsdom (`fireEvent.pointerDown(btn, { button: 0, ctrlKey: false })`); use `openMenu` / `chooseMenuItem` from `tests/components/menu-helpers.ts`.
- jsdom reports 0 for `offsetHeight`, so anything rendering `BookmarkList` rows needs the rect stub in `tests/components/virtual-rects.ts` (created in Task 3).
- Baseline: the component suite has timing-flaky tests under full-suite load (popup 150 ms budget, `EditDialog` in `sidepanel-actions`, drag overlay, scan dialog) and `tests/unit/search-perf.test.ts` is load-sensitive. If a failure is a timeout or looks unrelated, re-run that file alone before treating it as a regression: `npx vitest run --project components tests/components/<file>`.
- Gates before each commit that touches code: `npm run lint`, `npm run typecheck`, and the relevant vitest files. Before the final task also `npm run build` and the `check:*` scripts.
- Copy rules: plain, concise. Keep existing labels ending in `…` (`Import…`, `Scan library…`, `Set up AI…`).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/sidepanel/row-text.ts` | create | `displayDomain`, `visibleTags`, `folderLabel`, `formatAdded` |
| `src/entrypoints/sidepanel/empty-state.ts` | create | `emptyStateFor(view, ctx)`: copy and action per empty case |
| `src/ui/components/empty-state.tsx` | create | `EmptyState` presentational component |
| `src/entrypoints/sidepanel/BookmarkList.tsx` | modify | Row domain line, hover-revealed controls, chip cap, `empty` prop |
| `src/entrypoints/sidepanel/DuplicatesView.tsx` | modify | Group header, folder-led member row, icon Open, `empty` prop |
| `src/entrypoints/sidepanel/ReviewView.tsx` | modify | `empty` prop |
| `src/entrypoints/sidepanel/App.tsx` | modify | Build and pass `empty` for each view |
| `tests/unit/sidepanel-row-text.test.ts` | create | Helpers |
| `tests/unit/sidepanel-empty-state.test.ts` | create | `emptyStateFor` |
| `tests/components/empty-state.test.tsx` | create | `EmptyState` |
| `tests/components/virtual-rects.ts` | create | Shared `stubElementRects` / `restoreElementRects` |
| `tests/components/sidepanel-rows.test.tsx` | create | Row presentation |
| `tests/components/duplicates-view.test.tsx` | modify | New header/member layout assertions |
| `tests/components/sidepanel-empty.test.tsx` | create | Empty states through `App` |
| `tests/e2e/*.spec.ts` | review | Any assertion that relied on the full URL line |

---

### Task 0: Track the work and amend the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-sidepanel-content-design.md`

- [ ] **Step 1: Create the bd epic and children**

```bash
cd /home/ubuntu/Documents/project/BookmarksManager
bd create "UI redesign: side panel content (rows, duplicates, empty states)" -t epic -p 2 --json
```

Note the returned epic id, then create two children and link them (creating with a parent flag has failed before, so link afterwards):

```bash
bd create "Rows, hover controls and empty-state helpers (plan Tasks 1-3)" -t task -p 2 --json
bd create "Duplicates layout, empty-state wiring, e2e and screenshots (plan Tasks 4-6)" -t task -p 2 --json
bd update <child1-id> --parent <epic-id>
bd update <child2-id> --parent <epic-id>
bd update <child1-id> --claim
```

- [ ] **Step 2: Amend the spec**

In `docs/superpowers/specs/2026-09-29-sidepanel-content-design.md`, replace

```
`emptyStateFor(view, query, ctx)` is pure and returns
`{ title, hint?, action?: "import" | "clear-search" | "scan" | "setup-ai" }`
or `undefined` when the view is not empty. `ctx` carries `aiConnected` and
`libraryEmpty`.
```

with

```
`emptyStateFor(view, ctx)` is pure and returns
`{ title, hint?, action?: { kind: "import" | "clear-search" | "scan" | "set-up-ai"; label } }`.
The typed query is already on the `search` view (`{ kind: "search", query }`),
so there is no separate query argument. The caller decides whether the list
is empty; the function only picks the copy. `ctx` carries `aiConnected` and
`libraryEmpty`. While the tree (or the search index) is still loading, `App`
shows a plain "Loading…" empty state instead, so "No bookmarks yet" never
flashes.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-29-sidepanel-content-design.md
git commit -m "docs(spec): clarify emptyStateFor signature and loading behaviour"
```

---

### Task 1: Pure text helpers

**Files:**
- Create: `src/entrypoints/sidepanel/row-text.ts`
- Test: `tests/unit/sidepanel-row-text.test.ts`

**Interfaces:**
- Produces (exact):
  ```ts
  export function displayDomain(url: string): string
  export function visibleTags(tags: readonly string[], max: number): { shown: string[]; hidden: string[] }
  export function folderLabel(path: readonly string[]): string
  export function formatAdded(ms: number | undefined, locale?: string): string | undefined
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sidepanel-row-text.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit tests/unit/sidepanel-row-text.test.ts`
Expected: FAIL (cannot resolve `row-text`).

- [ ] **Step 3: Implement**

Create `src/entrypoints/sidepanel/row-text.ts`:

```ts
/**
 * Pure text helpers for list and duplicate rows. Kept free of React so the
 * formatting rules (domain, tag cap, folder trail, date) are unit-testable.
 */

/** The URL's hostname without a leading `www.`; the raw text if it has none. */
export function displayDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host === "" ? url : host;
  } catch {
    return url;
  }
}

/** Split `tags` into the chips to draw and the ones folded into `+N`. */
export function visibleTags(
  tags: readonly string[],
  max: number,
): { shown: string[]; hidden: string[] } {
  return { shown: tags.slice(0, max), hidden: tags.slice(max) };
}

/** Last two folder segments, prefixed with an ellipsis when the path is deeper. */
export function folderLabel(path: readonly string[]): string {
  if (path.length === 0) return "";
  const tail = path.slice(-2).join(" / ");
  return path.length > 2 ? `… / ${tail}` : tail;
}

/** `Mar 12, 2026`-style date for a `dateAdded` value, or `undefined`. */
export function formatAdded(
  ms: number | undefined,
  locale?: string,
): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project unit tests/unit/sidepanel-row-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx eslint src/entrypoints/sidepanel/row-text.ts tests/unit/sidepanel-row-text.test.ts && npm run typecheck
git add src/entrypoints/sidepanel/row-text.ts tests/unit/sidepanel-row-text.test.ts
git commit -m "feat(sidepanel): add row text helpers for domain, tag cap, folder trail and date"
```

---

### Task 2: Empty-state copy and component

**Files:**
- Create: `src/entrypoints/sidepanel/empty-state.ts`
- Create: `src/ui/components/empty-state.tsx`
- Test: `tests/unit/sidepanel-empty-state.test.ts`
- Test: `tests/components/empty-state.test.tsx`

**Interfaces:**
- Consumes: `SidePanelView` from `src/entrypoints/sidepanel/views.ts`.
- Produces (exact):
  ```ts
  export type EmptyActionKind = "import" | "clear-search" | "scan" | "set-up-ai";
  export interface EmptyStateSpec {
    title: string;
    hint?: string;
    action?: { kind: EmptyActionKind; label: string };
  }
  export interface EmptyStateContext { aiConnected: boolean; libraryEmpty: boolean }
  export function emptyStateFor(view: SidePanelView, ctx: EmptyStateContext): EmptyStateSpec

  export interface EmptyStateProps {
    title: string;
    hint?: string;
    action?: { label: string; onSelect(): void };
    className?: string;
  }
  export function EmptyState(props: EmptyStateProps): ReactElement
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/sidepanel-empty-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emptyStateFor } from "../../src/entrypoints/sidepanel/empty-state";

const ctx = { aiConnected: false, libraryEmpty: false };

describe("emptyStateFor", () => {
  it("offers Import when the whole library is empty", () => {
    expect(
      emptyStateFor({ kind: "all" }, { ...ctx, libraryEmpty: true }),
    ).toEqual({
      title: "No bookmarks yet",
      hint: "Import a file, or save pages with the toolbar button.",
      action: { kind: "import", label: "Import…" },
    });
  });

  it("describes an empty folder without an action", () => {
    expect(emptyStateFor({ kind: "folder", folderId: "10" }, ctx)).toEqual({
      title: "This folder is empty",
      hint: "Use “Move to…” on a bookmark to put it here.",
    });
  });

  it("names the query and offers Clear search", () => {
    expect(emptyStateFor({ kind: "search", query: "sour" }, ctx)).toEqual({
      title: "No results for “sour”",
      hint: "Try fewer words or check the spelling.",
      action: { kind: "clear-search", label: "Clear search" },
    });
  });

  it("covers untagged, recent, tag, category and duplicates", () => {
    expect(emptyStateFor({ kind: "untagged" }, ctx).title).toBe(
      "Everything is tagged",
    );
    expect(emptyStateFor({ kind: "recent" }, ctx).title).toBe(
      "Nothing saved recently",
    );
    expect(emptyStateFor({ kind: "tag", nameKey: "dev" }, ctx).title).toBe(
      "No bookmarks with this tag",
    );
    expect(
      emptyStateFor({ kind: "category", category: "docs" }, ctx).title,
    ).toBe("No bookmarks in this category");
    expect(emptyStateFor({ kind: "duplicates" }, ctx)).toEqual({
      title: "No duplicates found",
      hint: "Every bookmark URL is unique.",
    });
  });

  it("offers Scan library when AI is connected and Set up AI when it is not", () => {
    expect(
      emptyStateFor({ kind: "review" }, { ...ctx, aiConnected: true }),
    ).toEqual({
      title: "Nothing to review",
      hint: "Suggestions from a scan appear here.",
      action: { kind: "scan", label: "Scan library…" },
    });
    expect(emptyStateFor({ kind: "review" }, ctx)).toEqual({
      title: "Nothing to review",
      hint: "Connect an AI provider to get suggestions.",
      action: { kind: "set-up-ai", label: "Set up AI…" },
    });
  });

  it("has a generic fallback for the all view with a non-empty library", () => {
    expect(emptyStateFor({ kind: "all" }, ctx).title).toBe("No bookmarks here");
  });
});
```

Create `tests/components/empty-state.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/sidepanel-empty-state.test.ts tests/components/empty-state.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

Create `src/entrypoints/sidepanel/empty-state.ts`:

```ts
import type { SidePanelView } from "./views";

/**
 * Copy and next step for each way the side panel can be empty. Pure: the
 * caller decides whether the list is empty and maps `action.kind` to a real
 * handler. The typed search query lives on the `search` view.
 */
export type EmptyActionKind = "import" | "clear-search" | "scan" | "set-up-ai";

export interface EmptyStateSpec {
  title: string;
  hint?: string;
  action?: { kind: EmptyActionKind; label: string };
}

export interface EmptyStateContext {
  aiConnected: boolean;
  /** The whole library has no bookmarks (not just this view). */
  libraryEmpty: boolean;
}

export function emptyStateFor(
  view: SidePanelView,
  ctx: EmptyStateContext,
): EmptyStateSpec {
  switch (view.kind) {
    case "all":
      return ctx.libraryEmpty
        ? {
            title: "No bookmarks yet",
            hint: "Import a file, or save pages with the toolbar button.",
            action: { kind: "import", label: "Import…" },
          }
        : { title: "No bookmarks here" };
    case "folder":
      return {
        title: "This folder is empty",
        hint: "Use “Move to…” on a bookmark to put it here.",
      };
    case "search":
      return {
        title: `No results for “${view.query}”`,
        hint: "Try fewer words or check the spelling.",
        action: { kind: "clear-search", label: "Clear search" },
      };
    case "untagged":
      return {
        title: "Everything is tagged",
        hint: "Bookmarks without tags would show up here.",
      };
    case "recent":
      return {
        title: "Nothing saved recently",
        hint: "Newly saved bookmarks appear here.",
      };
    case "tag":
      return {
        title: "No bookmarks with this tag",
        hint: "Tag bookmarks from their ⋯ menu.",
      };
    case "category":
      return {
        title: "No bookmarks in this category",
        hint: "Categories are set when you edit a bookmark.",
      };
    case "duplicates":
      return {
        title: "No duplicates found",
        hint: "Every bookmark URL is unique.",
      };
    case "review":
      return ctx.aiConnected
        ? {
            title: "Nothing to review",
            hint: "Suggestions from a scan appear here.",
            action: { kind: "scan", label: "Scan library…" },
          }
        : {
            title: "Nothing to review",
            hint: "Connect an AI provider to get suggestions.",
            action: { kind: "set-up-ai", label: "Set up AI…" },
          };
    case "restructure":
      return { title: "Nothing here yet" };
  }
}
```

Create `src/ui/components/empty-state.tsx`:

```tsx
import type { ReactElement } from "react";
import { cn } from "../lib/cn";

/**
 * A centred "nothing here" block: a title, one line of guidance and at most
 * one next-step button. Static content, so it has no live-region role.
 */
export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: { label: string; onSelect(): void };
  className?: string;
}

export function EmptyState({
  title,
  hint,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-1 px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium break-words">{title}</p>
      {hint !== undefined && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onSelect}
          className="mt-3 rounded-sm border border-border bg-background px-3 py-1.5 text-xs outline-hidden hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/unit/sidepanel-empty-state.test.ts tests/components/empty-state.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx eslint src/entrypoints/sidepanel/empty-state.ts src/ui/components/empty-state.tsx tests/unit/sidepanel-empty-state.test.ts tests/components/empty-state.test.tsx && npm run typecheck
git add src/entrypoints/sidepanel/empty-state.ts src/ui/components/empty-state.tsx tests/unit/sidepanel-empty-state.test.ts tests/components/empty-state.test.tsx
git commit -m "feat(sidepanel): add contextual empty-state copy and component"
```

---

### Task 3: List rows (domain, hover controls, chip cap, `empty` prop)

**Files:**
- Create: `tests/components/virtual-rects.ts`
- Create: `tests/components/sidepanel-rows.test.tsx`
- Modify: `src/entrypoints/sidepanel/BookmarkList.tsx` (imports; `Option`; `BookmarkListProps`; the listbox block near line 660)

**Interfaces:**
- Consumes: `displayDomain`, `visibleTags` from `row-text.ts`.
- Produces: `BookmarkListProps.empty?: ReactNode` (rendered as a sibling of the listbox when `items.length === 0`); every row's control wrapper has `data-row-controls` (kebab wrapper) and the drag handle keeps `data-dnd-drag`.

- [ ] **Step 1: Shared rect stub**

Create `tests/components/virtual-rects.ts`:

```ts
/**
 * jsdom reports 0 for offsetHeight/offsetWidth, so @tanstack/react-virtual
 * sees an empty viewport and renders no rows. This gives only the scroll
 * container (`data-testid="bookmark-scroll"`) a 600x400 box.
 */
const SCROLL_TESTID = "bookmark-scroll";
let saved: [string, PropertyDescriptor | undefined][] = [];

export function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  saved = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID ? value : 0;
      },
    });
    return [prop, prior];
  });
}

export function restoreElementRects(): void {
  for (const [prop, prior] of saved) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  saved = [];
}
```

- [ ] **Step 2: Write the failing row tests**

Create `tests/components/sidepanel-rows.test.tsx`:

```tsx
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { BookmarkList } from "../../src/entrypoints/sidepanel/BookmarkList";
import type { BookmarkMeta } from "../../src/schemas/meta";
import type { BookmarkItem } from "../../src/sync/tree";
import { restoreElementRects, stubElementRects } from "./virtual-rects";

const ISO = "2026-09-01T00:00:00.000Z";

function item(
  id: string,
  title: string,
  url: string,
  overrides: Partial<BookmarkItem> = {},
): BookmarkItem {
  return {
    id,
    title,
    url,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 1,
    kind: "bookmark",
    ...overrides,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(stubElementRects);
afterEach(() => {
  cleanup();
  restoreElementRects();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("list row", () => {
  it("shows the domain instead of the full URL and keeps the URL as a tooltip", () => {
    render(
      <BookmarkList
        items={[
          item("a", "Design system", "https://www.work.example/design/tokens?x=1"),
        ]}
      />,
    );
    const row = screen.getByRole("option");
    expect(row.textContent).toContain("work.example");
    expect(row.textContent).not.toContain("/design/tokens");
    expect(row.getAttribute("title")).toBe(
      "https://www.work.example/design/tokens?x=1",
    );
  });

  it("keeps row controls in the DOM, hidden until hover, focus or selection", () => {
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        renderItemActions={() => <button type="button">Actions</button>}
      />,
    );
    const row = screen.getByRole("option");
    const controls = row.querySelector("[data-row-controls]");
    expect(controls).not.toBeNull();
    expect(within(controls as HTMLElement).getByRole("button", { name: "Actions" }))
      .toBeTruthy();
    expect(controls?.className).toContain("opacity-0");
    expect(controls?.className).toContain("group-hover/row:opacity-100");
    expect(controls?.className).toContain("group-focus-within/row:opacity-100");
    expect(controls?.className).toContain("group-aria-selected/row:opacity-100");

    const handle = row.querySelector("[data-dnd-drag]");
    expect(handle).not.toBeNull();
    expect(handle?.className).toContain("opacity-0");
    expect(handle?.className).toContain("group-hover/row:opacity-100");
  });

  it("shows at most two tag chips and folds the rest into a +N chip with a tooltip", () => {
    const metaById = new Map<string, BookmarkMeta>([
      [
        "a",
        { id: "a", tags: ["one", "two", "three", "four"], updatedAt: ISO },
      ],
    ]);
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        metaById={metaById}
        tagNameByKey={new Map([
          ["one", "One"],
          ["two", "Two"],
          ["three", "Three"],
          ["four", "Four"],
        ])}
      />,
    );
    const row = screen.getByRole("option");
    expect(row.querySelectorAll("[data-tag]").length).toBe(2);
    expect(row.textContent).toContain("One");
    expect(row.textContent).toContain("Two");
    expect(row.textContent).not.toContain("Three");
    const more = row.querySelector("[data-tag-more]");
    expect(more?.textContent).toBe("+2");
    expect(more?.getAttribute("title")).toBe("Three, Four");
  });

  it("renders no +N chip when the tags fit", () => {
    const metaById = new Map<string, BookmarkMeta>([
      ["a", { id: "a", tags: ["one", "two"], updatedAt: ISO }],
    ]);
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        metaById={metaById}
      />,
    );
    expect(screen.getByRole("option").querySelector("[data-tag-more]")).toBeNull();
  });
});

describe("empty list", () => {
  it("renders the empty node outside the listbox", () => {
    render(<BookmarkList items={[]} empty={<p>Custom empty</p>} />);
    expect(screen.getByText("Custom empty")).toBeTruthy();
    const listbox = screen.getByRole("listbox", { name: "Bookmarks" });
    expect(within(listbox).queryByText("Custom empty")).toBeNull();
  });

  it("falls back to the default line when no empty node is given", () => {
    render(<BookmarkList items={[]} />);
    expect(screen.getByText("No bookmarks in this view.")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-rows.test.tsx`
Expected: FAIL (URL still shown, no `data-row-controls`, no `+N`, no `empty` prop).

- [ ] **Step 4: Implement in `BookmarkList.tsx`**

1. Add to the imports (next to the other sidepanel imports):

```tsx
import { displayDomain, visibleTags } from "./row-text";
```

2. Add near the other module constants (after `CONTEXT_MENU_CONTENT_CLASS`):

```tsx
/** Max tag chips on a row before the rest fold into a `+N` chip. */
const MAX_ROW_TAGS = 2;

/**
 * Row controls are drawn but transparent until the row is hovered, holds
 * focus, or is selected; touch devices (no hover) always show them. They keep
 * their width so rows never shift.
 */
const REVEAL_CLASS =
  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 " +
  "group-aria-selected/row:opacity-100 [@media(hover:none)]:opacity-100";

/** Managed rows' drag handle is inert, so it reveals dimmed. */
const REVEAL_DIMMED_CLASS =
  "group-hover/row:opacity-40 group-focus-within/row:opacity-40 " +
  "group-aria-selected/row:opacity-40 [@media(hover:none)]:opacity-40";
```

3. In `Option`, right after `const title = ...` add:

```tsx
  const domain = displayDomain(item.url);
```

4. On the row `<div role="option" ...>` add `title={item.url}` (next to `data-bookmark-id`), and add `"group/row"` as the first argument in its `cn(`:

```tsx
      className={cn(
        "group/row h-full cursor-default overflow-hidden rounded-sm outline-hidden",
```
   Also change the selected/hover background so hover is visible: append `"hover:bg-row-hover"` after the `aria-selected:bg-accent ...` line:
```tsx
        "aria-selected:bg-accent aria-selected:text-accent-foreground",
        "hover:bg-row-hover",
```

5. Replace the URL line in the list layout:

```tsx
        {layout === "list" && (
          <div className="truncate text-xs text-muted-foreground">
            {domain}
          </div>
        )}
```

6. Replace the whole chips block (`{layout === "list" && meta !== undefined && (<span className="flex shrink-0 items-center gap-1"> ... </span>)}`) with:

```tsx
      {layout === "list" && meta !== undefined && (
        <span className="flex shrink-0 items-center gap-1">
          {(() => {
            const { shown, hidden } = visibleTags(meta.tags, MAX_ROW_TAGS);
            return (
              <>
                {shown.map((nameKey) => (
                  <span
                    key={nameKey}
                    data-tag={nameKey}
                    className="rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {tagNameByKey?.get(nameKey) ?? nameKey}
                  </span>
                ))}
                {hidden.length > 0 && (
                  <span
                    data-tag-more
                    title={hidden
                      .map((nameKey) => tagNameByKey?.get(nameKey) ?? nameKey)
                      .join(", ")}
                    className="rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground"
                  >
                    +{hidden.length}
                  </span>
                )}
              </>
            );
          })()}
          {meta.category !== undefined && (
            <span
              data-category={meta.category}
              className="rounded-sm bg-primary/10 px-1 py-0.5 text-[11px] text-primary"
            >
              {meta.category}
            </span>
          )}
        </span>
      )}
```

7. Give the actions wrapper the reveal class and a marker:

```tsx
        <span
          data-row-controls
          className={cn("flex shrink-0 items-center", REVEAL_CLASS)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
```

8. Pass the reveal class to the drag handle:

```tsx
        <DragHandle
          id={item.id}
          kind="bookmark"
          label={title}
          parentId={item.parentId}
          index={item.index}
          disabled={item.isManaged}
          className={cn(REVEAL_CLASS, item.isManaged && REVEAL_DIMMED_CLASS)}
        />
```

9. In `BookmarkListProps` add (after `leading`):

```tsx
  /**
   * Shown below the (empty) listbox when `items` is empty. Defaults to a plain
   * "No bookmarks in this view." line.
   */
  empty?: ReactNode;
```

   Add `empty,` to the destructured parameters of `BookmarkList` (next to `leading`).

10. Replace the empty-message block **inside** the listbox

```tsx
          {items.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No bookmarks in this view.
            </p>
          )}
```

    by nothing (delete it), and insert this right after the listbox's closing `</div>` (still inside the `bookmark-scroll` div):

```tsx
        {items.length === 0 &&
          (empty ?? (
            <p className="p-4 text-sm text-muted-foreground">
              No bookmarks in this view.
            </p>
          ))}
```

- [ ] **Step 5: Run the row tests**

Run: `npx vitest run --project components tests/components/sidepanel-rows.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the suites that render rows and fix copy-dependent assertions**

Run:
`npx vitest run --project components tests/components/sidepanel-layout.test.tsx tests/components/sidepanel-actions.test.tsx tests/components/sidepanel-dnd.test.tsx tests/components/sidepanel-search.test.tsx tests/components/sidepanel-shell.test.tsx tests/components/review-view.test.tsx`

Expected: PASS. If a test fails because it matched the row's URL text (an option accessible name that included `https://…`), change that query to the title or the domain. Do not weaken any behavioural assertion. Re-run failing files alone before judging (see Global Constraints).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx eslint src/entrypoints/sidepanel tests/components && npm run typecheck
git add src/entrypoints/sidepanel/BookmarkList.tsx tests/components/virtual-rects.ts tests/components/sidepanel-rows.test.tsx
git commit -m "feat(sidepanel): domain line, hover-revealed row controls and capped tag chips"
```

If Step 6 changed other test files, add them to the same commit.

---

### Task 4: Duplicates layout

**Files:**
- Modify: `src/entrypoints/sidepanel/DuplicatesView.tsx` (imports, `MemberRow`, group `<header>`, empty branch, props)
- Modify: `tests/components/duplicates-view.test.tsx`

**Interfaces:**
- Consumes: `displayDomain`, `folderLabel`, `formatAdded` from `row-text.ts`; `ExternalLinkIcon` from `src/ui/components/icons.tsx`.
- Produces: `DuplicatesViewProps.empty?: ReactNode` (defaults to the current "No duplicates — every bookmark URL is unique." line).

- [ ] **Step 1: Update the tests first**

In `tests/components/duplicates-view.test.tsx`:

a) Replace the two key assertions in `renders each group as a card...`:

```tsx
    expect(exact.textContent).toContain("https://x.example/");
```
with
```tsx
    expect(exact.textContent).toContain("Exact One");
    expect(exact.textContent).toContain("x.example");
    expect(exact.querySelector("header")?.getAttribute("title")).toBe(
      "https://x.example/",
    );
```
and
```tsx
    expect(normalized.textContent).toContain("a.example/page");
```
with
```tsx
    expect(normalized.textContent).toContain("a.example");
    expect(normalized.querySelector("header")?.getAttribute("title")).toBe(
      "a.example/page",
    );
```

b) In `renders member rows with favicon, title, url, folder path, and tag chips`: replace the first three assertions after `const row = memberRow("x1");`

```tsx
    expect(row.textContent).toContain("Exact One");
    expect(row.textContent).toContain("https://x.example/");
    // Folder path: x1 sits at the top of the Bookmarks bar.
    expect(row.textContent).toContain("Bookmarks bar");
```
with
```tsx
    // Folder-led: x1 sits at the top of the Bookmarks bar. Its title equals
    // the group header's, so it is not repeated; the URL is not shown.
    expect(row.textContent).toContain("Bookmarks bar");
    expect(row.textContent).not.toContain("Exact One");
    expect(row.textContent).not.toContain("https://x.example/");
```
   and replace the `x2` block

```tsx
    const x2 = memberRow("x2");
    expect(x2.textContent).toContain("notes");
```
with
```tsx
    const x2 = memberRow("x2");
    expect(x2.textContent).toContain("notes");
    // A member whose title differs from the group's keeps its title.
    expect(x2.textContent).toContain("Exact Two");
```
   and replace the n2 block

```tsx
    const n2 = memberRow("n2");
    expect(n2.textContent).toContain("Bookmarks bar");
    expect(n2.textContent).toContain("Dev");
    expect(n2.textContent).toContain("Deep");
```
with
```tsx
    // Deep paths show the last two segments; the tooltip has the full path.
    const n2 = memberRow("n2");
    expect(n2.textContent).toContain("… / Dev / Deep");
    expect(
      n2.querySelector('[title="Bookmarks bar / Dev / Deep"]'),
    ).not.toBeNull();
```

c) Add these tests inside `describe("DuplicatesView rendering", ...)`:

```tsx
  it("shows when each member was added", async () => {
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} />);
    expect(memberRow("x1").textContent).toMatch(/Added [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  });

  it("uses an icon-only Open button that keeps its accessible name", async () => {
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} onActivateItem={() => {}} />);
    const open = within(memberRow("x1")).getByRole("button", {
      name: "Open Exact One",
    });
    expect(open.textContent).toBe("");
    expect(open.querySelector("svg")).not.toBeNull();
  });

  it("renders a custom empty node when there are no groups", () => {
    render(<DuplicatesView groups={[]} empty={<p>Custom empty</p>} />);
    expect(screen.getByText("Custom empty")).toBeTruthy();
    expect(screen.queryByText(/No duplicates/)).toBeNull();
  });
```

   (The fake bookmarks clock stamps `dateAdded` on every node, so `Added …` renders. If the date test fails because `dateAdded` is absent in this fake, seed one with `installBookmarksFake({ now: () => 1_773_144_000_000, ... })` for that test only.)

- [ ] **Step 2: Run to verify the new/changed tests fail**

Run: `npx vitest run --project components tests/components/duplicates-view.test.tsx`
Expected: FAIL on the changed layout assertions and the three new tests.

- [ ] **Step 3: Implement in `DuplicatesView.tsx`**

1. Imports: add

```tsx
import { ExternalLinkIcon } from "../../ui/components/icons";
import { displayDomain, folderLabel, formatAdded } from "./row-text";
```
   (keep the existing `Favicon`, `cn` imports; check `ReactNode` is imported from `react`, add it if not).

2. Add to `DuplicatesViewProps` (find the interface; add next to `className`):

```tsx
  /** Shown when there are no groups. Defaults to the plain "No duplicates" line. */
  empty?: ReactNode;
```
   and destructure `empty` in `DuplicatesView`'s parameters.

3. `MemberRowProps`: add `groupTitle: string;`. In `MemberRow` destructure it, then replace the text block

```tsx
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{displayTitle(item)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {item.url}
        </div>
        {item.path.length > 0 && (
          <div className="truncate text-xs text-muted-foreground">
            {item.path.join(" / ")}
          </div>
        )}
      </div>
```
with

```tsx
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={item.path.join(" / ")}>
          {primary}
        </div>
        {added !== undefined && (
          <div className="truncate text-xs text-muted-foreground">
            Added {added}
          </div>
        )}
        {showTitle && (
          <div className="truncate text-xs text-muted-foreground">
            {displayTitle(item)}
          </div>
        )}
      </div>
```
   and define, at the top of `MemberRow` (after `const tags = ...`):

```tsx
  const folder = folderLabel(item.path);
  const primary = folder === "" ? displayTitle(item) : folder;
  const showTitle = folder !== "" && displayTitle(item) !== groupTitle;
  const added = formatAdded(item.dateAdded);
```

4. Make Open an icon button. Replace

```tsx
            onClick={() => onActivate(item)}
            className={secondaryButtonClass}
          >
            Open
          </button>
```
with

```tsx
            onClick={() => onActivate(item)}
            className={cn(secondaryButtonClass, "px-1.5")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </button>
```

5. Group header. Inside `groups.map((group) => {`, before `return (`, add:

```tsx
              const first = group.items[0];
              const groupTitle =
                first === undefined ? group.key : displayTitle(first);
              const groupDomain =
                first === undefined ? "" : displayDomain(first.url);
```
   Replace the `<header ...>` contents:

```tsx
                  <header
                    title={group.key}
                    className="flex items-center gap-2 border-b border-border px-3 py-2"
                  >
                    <span className={badgeClass(group.kind)}>
                      {kindLabel(group.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {groupTitle}
                      {groupDomain !== "" && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {groupDomain}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {group.items.length}{" "}
                      {group.items.length === 1 ? "member" : "members"}
                    </span>
                  </header>
```
   and pass `groupTitle={groupTitle}` to `<MemberRow ... />`.

6. Empty branch: replace

```tsx
      ) : groups.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No duplicates — every bookmark URL is unique.
        </p>
      ) : (
```
with

```tsx
      ) : groups.length === 0 ? (
        (empty ?? (
          <p className="p-4 text-sm text-muted-foreground">
            No duplicates — every bookmark URL is unique.
          </p>
        ))
      ) : (
```

- [ ] **Step 4: Run the duplicates tests**

Run: `npx vitest run --project components tests/components/duplicates-view.test.tsx`
Expected: PASS (merge, confirm, undo and failure tests unchanged).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx eslint src/entrypoints/sidepanel/DuplicatesView.tsx tests/components/duplicates-view.test.tsx && npm run typecheck
git add src/entrypoints/sidepanel/DuplicatesView.tsx tests/components/duplicates-view.test.tsx
git commit -m "feat(sidepanel): folder-led duplicate groups with an icon Open button"
```

---

### Task 5: Wire empty states through `App`

**Files:**
- Modify: `src/entrypoints/sidepanel/ReviewView.tsx` (props + empty branch near line 768)
- Modify: `src/entrypoints/sidepanel/App.tsx`
- Create: `tests/components/sidepanel-empty.test.tsx`

**Interfaces:**
- Consumes: `emptyStateFor`, `EmptyState`, `ToolsAction` handlers already in `App` (`handleTools`), `setSearchQuery`.
- Produces: `ReviewViewProps.empty?: ReactNode`.

- [ ] **Step 1: Write the failing App-level tests**

Create `tests/components/sidepanel-empty.test.tsx`:

```tsx
import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import { App } from "../../src/entrypoints/sidepanel/App";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";
import { restoreElementRects, stubElementRects } from "./virtual-rects";

/**
 * Empty states through the real `App`: what each empty view says and what its
 * one action does. `matchMedia` is stubbed to "wide" so the folder tree is
 * on screen without opening the drawer.
 */

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreElementRects();
});

function stubChrome(options: Parameters<typeof createFakeBookmarks>[0]): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  vi.stubGlobal("chrome", {
    bookmarks: createFakeBookmarks(options),
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
}

beforeEach(async () => {
  stubElementRects();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.consents.clear();
  await db.decisions.clear();
});

const searchbox = (): HTMLElement =>
  screen.getByRole("combobox", { name: "Search bookmarks" });

describe("empty states in the app", () => {
  it("an empty library offers Import…, which opens the import dialog", async () => {
    stubChrome({ bookmarksBar: [], otherBookmarks: [] });
    render(<App />);
    expect(await screen.findByText("No bookmarks yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    expect(
      await screen.findByRole("heading", { name: "Import bookmarks" }),
    ).toBeTruthy();
  });

  it("a search with no hits names the query and Clear search empties the box", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.change(searchbox(), { target: { value: "zzzqqq" } });
    expect(await screen.findByText("No results for “zzzqqq”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect((searchbox() as HTMLInputElement).value).toBe(""),
    );
    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeTruthy();
  });

  it("Duplicates with none says so", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    await openMenu(/^More/);
    await chooseMenuItem("Duplicates");
    expect(await screen.findByText("No duplicates found")).toBeTruthy();
    expect(screen.getByText("Every bookmark URL is unique.")).toBeTruthy();
  });

  it("Untagged says everything is tagged when every bookmark has a tag", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    const { putMeta } = await import("../../src/db/meta");
    await putMeta("b1", { tags: ["dev"] });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    const views = screen.getByRole("navigation", { name: "Views" });
    fireEvent.click(
      Array.from(views.querySelectorAll("button")).find(
        (b) => b.textContent === "Untagged",
      ) as HTMLElement,
    );
    expect(await screen.findByText("Everything is tagged")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-empty.test.tsx`
Expected: FAIL (old copy is still rendered).

- [ ] **Step 3: Add `empty` to `ReviewView`**

In `ReviewView.tsx`: add `empty?: ReactNode;` to its props interface (with a one-line doc: "Shown when the queue is empty. Defaults to the plain 'No pending suggestions' line."), destructure `empty`, make sure `ReactNode` is imported from `react`, and replace

```tsx
          <p className="p-4 text-sm text-muted-foreground">
            No pending suggestions — the queue is empty.
          </p>
```
with
```tsx
          (empty ?? (
            <p className="p-4 text-sm text-muted-foreground">
              No pending suggestions — the queue is empty.
            </p>
          ))
```

- [ ] **Step 4: Wire `App.tsx`**

1. Imports:

```tsx
import { EmptyState } from "../../ui/components/empty-state";
import { emptyStateFor } from "./empty-state";
```

2. After `handleTools` add:

```tsx
  /**
   * The empty-state block for the active view, or a plain "Loading…" while
   * the tree or the search index is still being built so "No bookmarks yet"
   * never flashes.
   */
  const emptyNode = (() => {
    const loading =
      tree.folders.size === 0 ||
      (activeView.kind === "search" && search === null);
    if (loading) return <EmptyState title="Loading…" />;
    const spec = emptyStateFor(activeView, {
      aiConnected,
      libraryEmpty: tree.bookmarks.size === 0,
    });
    const kind = spec.action?.kind;
    const runAction = (): void => {
      if (kind === "import") handleTools("import");
      else if (kind === "scan") handleTools("scan");
      else if (kind === "set-up-ai") handleTools("set-up-ai");
      else if (kind === "clear-search") setSearchQuery("");
    };
    return (
      <EmptyState
        title={spec.title}
        {...(spec.hint === undefined ? {} : { hint: spec.hint })}
        {...(spec.action === undefined
          ? {}
          : { action: { label: spec.action.label, onSelect: runAction } })}
      />
    );
  })();
```

3. Pass it: add `empty={emptyNode}` to `<DuplicatesView ...>`, `<ReviewView ...>` and `<BookmarkList ...>`.

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run --project components tests/components/sidepanel-empty.test.tsx`
Expected: PASS. If "Loading…" persists in the empty-library test, check that `tree.folders.size` is non-zero once the fake's root folders load (the empty-library fake still has the built-in root folders); if the tree reports zero folders for an empty library, use `tree.bookmarks.size === 0 && tree.folders.size === 0` only for the initial load via the tree hook's own loading flag instead, and note the deviation in the commit message.

- [ ] **Step 6: Run the wider suites**

Run: `npx vitest run --project components tests/components/sidepanel-layout.test.tsx tests/components/sidepanel-shell.test.tsx tests/components/sidepanel-search.test.tsx tests/components/review-view.test.tsx tests/components/duplicates-view.test.tsx tests/components/sidepanel-scan-ask.test.tsx`
Expected: PASS. Fix only copy-dependent assertions (for example a test that expected "No pending suggestions" through `App` now sees "Nothing to review"); re-run failing files alone before judging.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx eslint src tests && npm run typecheck
git add src/entrypoints/sidepanel/App.tsx src/entrypoints/sidepanel/ReviewView.tsx tests/components/sidepanel-empty.test.tsx
git commit -m "feat(sidepanel): contextual empty states with one next action"
```

Add any test files touched in Step 6 to the same commit. Close the first bd child now: `bd close <child1-id>` and claim the second: `bd update <child2-id> --claim`.

---

### Task 6: Verification, screenshots and store asset

**Files:**
- Modify: `store/assets/screenshot-manager-1280x800.png` (regenerated)
- Review: `tests/e2e/*.spec.ts`

- [ ] **Step 1: Run every gate**

Run: `npm run lint && npm run typecheck && npm run build && npm run check:manifest && npm run check:bundle && npm run check:site`
Expected: all clean.

Run: `npx vitest run --project unit` (re-run alone if only `search-perf` fails; it is load-sensitive).
Run: `npx vitest run --project components` (re-run any failing file alone; known flaky files are listed in Global Constraints).

- [ ] **Step 2: Review and run the e2e specs**

Run: `grep -rn "https://\|example/" tests/e2e/*.spec.ts | grep -i "getByText\|toContainText\|toHaveText"` and read each hit: any assertion that expects a row's full URL text must use the domain (or the row's `title` attribute) instead.

Run: `npm run build && xvfb-run -a npx playwright test tests/e2e/shell.spec.ts tests/e2e/core-manager.spec.ts tests/e2e/decisions.spec.ts --reporter=line`
Expected: PASS. Fix selectors that involve the changed rows, Open button or empty states only; unrelated drift is tracked as `BookmarksManager-gyx`.

- [ ] **Step 3: Capture and inspect**

Run: `cd /home/ubuntu/Documents/project/BookmarksManager && npm run build && cd /tmp/capture && OUT=/tmp/capture/after-content xvfb-run -a node capture.mjs`

Also capture an empty library: add to `/tmp/capture/capture.mjs` a second page on a fresh profile (or delete every bookmark through `chrome.bookmarks.removeTree` in the seed page) and save `sidepanel-480-empty-library`, `sidepanel-480-empty-search` (type `zzzqqq`) and `sidepanel-480-empty-duplicates`.

Read `sidepanel-480.png`, `sidepanel-360.png`, `sidepanel-480-view-duplicates.png`, `sidepanel-480-empty-library.png`, `sidepanel-480-empty-search.png` from `/tmp/capture/after-content/` (at most five images per read; save notes as text first). Check against the spec:
- Rows: title plus domain only, no ⋯ or drag handle until hover (screenshots show the rest state); at most 2 tag chips plus `+N`.
- Duplicates: header shows title and domain once; members lead with the folder path, then `Added <date>`; the Open button is an icon.
- Empty states: centred title, hint and one button; nothing clipped at 360 px.

Report and fix any visual defect before continuing.

- [ ] **Step 4: Regenerate the store screenshot**

Run: `UPDATE_STORE_ASSETS=1 xvfb-run -a npx playwright test tests/e2e/store-assets.spec.ts` then `npm run check:store`.
Read `store/assets/screenshot-manager-1280x800.png` and confirm the wide layout, domain rows, and only synthetic `*.example` content.

- [ ] **Step 5: Commit the asset and close tracking**

```bash
git add store/assets/screenshot-manager-1280x800.png
git commit -m "chore(store): regenerate the manager screenshot for the new rows"
bd close <child2-id>
bd close <epic-id>
```

- [ ] **Step 6: Report**

Summarise for the user: commits (`git log --oneline -12`), gates and results, which flaky tests were seen, the screenshot comparison, and the proposed next sub-project (dialogs: Import drop zone, left-aligned copy, plain-language scan cost; then options and popup polish). Do not push.
