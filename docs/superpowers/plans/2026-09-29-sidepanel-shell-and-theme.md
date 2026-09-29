# Side Panel Shell and Shared Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the warm-neutral/teal/Geist theme the global default and rebuild the side panel shell as a narrow-first, search-first single column with a scope drawer (permanent scope column when wide).

**Architecture:** Theme is a CSS-only change in `src/ui/styles.css`. The shell is split out of `App.tsx` into small focused components (`TopBar`, `ViewChips`, `ScopePane`, `ScopeDrawer`/`ScopeHeading`) plus pure helpers (`scope.ts`) and two hooks (`useIsWide`, `useAiConnected`). `App.tsx` keeps view state, selection, dialogs and toasts and composes the pieces. The `SidePanelView` union and `views.ts` are unchanged.

**Tech Stack:** React 19, TypeScript (strict), Tailwind 4, Radix UI (`radix-ui` umbrella), Dexie + `dexie-react-hooks`, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-sidepanel-shell-and-theme-design.md` (amended by Task 0 of this plan).

## Global Constraints

- Commit per task, locally. **Never** `git push`, `git pull` or `git fetch` (AGENTS.md Git Policy).
- Track work with `bd`, not markdown TODO lists or TodoWrite (AGENTS.md).
- Zero new network requests. Do not add `fetch` anywhere (a lint rule bans it outside `src/net/`). Geist fonts are already bundled locally.
- Narrow/wide switch is exactly `(min-width: 640px)` on the viewport.
- Wide mode scope column is `w-56` (224 px). Narrow drawer is `w-[min(20rem,88vw)]`.
- Tests use role-based queries (`getByRole`), never CSS selectors, matching the existing suites.
- Radix dropdown triggers open on `pointerDown` in jsdom (`fireEvent.pointerDown(btn, { button: 0, ctrlKey: false })`).
- Baseline: the component suite has timing-flaky tests under full-suite load (e.g. popup 150 ms budget, EditDialog, drag overlay, scan dialog). If a failure is a timeout or looks unrelated, re-run that file alone before treating it as a regression: `npx vitest run --project components tests/components/<file>`.
- Gates before each commit that touches code: `npm run lint`, `npm run typecheck`, and the relevant vitest files. Before the final task also `npm run build` and the `check:*` scripts.
- Copy rules: plain, concise labels. Keep existing menu labels that end in `…` (`Import…`, `Export…`, `Manage tags…`, `Scan library…`).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/ui/styles.css` | modify | Global tokens (teal/warm-neutral, Geist), row tokens |
| `src/entrypoints/options/OptionsApp.tsx` | modify | Drop redundant `font-options-sans` class |
| `src/entrypoints/options/SentLog.tsx` | modify | `font-options-mono` → `font-mono` |
| `src/entrypoints/sidepanel/scope.ts` | create | Pure helpers: `categoryCounts`, `aiVisibility`, `moreViews`, `PRIMARY_CHIPS` |
| `src/entrypoints/sidepanel/useIsWide.ts` | create | `matchMedia` hook (`true` when unavailable) |
| `src/entrypoints/sidepanel/useAiConnected.ts` | create | Live "any non-test consent row" read |
| `src/entrypoints/sidepanel/ScopePane.tsx` | create | Folders, tags, categories content (host-agnostic) |
| `src/entrypoints/sidepanel/ScopeDrawer.tsx` | create | Radix sheet host |
| `src/entrypoints/sidepanel/ScopeHeading.tsx` | create | `<h2>` scope label; a drawer trigger in narrow mode |
| `src/entrypoints/sidepanel/ViewChips.tsx` | create | Chip row + More menu |
| `src/entrypoints/sidepanel/TopBar.tsx` | create | Search slot, Tools menu, Settings |
| `src/entrypoints/sidepanel/SearchBar.tsx` | modify | Root loses its own border/padding |
| `src/entrypoints/sidepanel/BookmarkList.tsx` | modify | Optional `leading` slot in the toolbar |
| `src/entrypoints/sidepanel/App.tsx` | modify | Compose the new shell, delete header/rail |
| `tests/unit/theme-tokens.test.ts` | create | Guards the global theme |
| `tests/unit/sidepanel-scope.test.ts` | create | Tests `scope.ts` |
| `tests/components/menu-helpers.ts` | create | `openMenu` / `chooseMenuItem` for Radix menus |
| `tests/components/sidepanel-hooks.test.tsx` | create | `useIsWide`, `useAiConnected` |
| `tests/components/sidepanel-scope-pane.test.tsx` | create | `ScopePane` |
| `tests/components/sidepanel-scope-drawer.test.tsx` | create | `ScopeDrawer` + `ScopeHeading` |
| `tests/components/sidepanel-chips.test.tsx` | create | `ViewChips` |
| `tests/components/sidepanel-topbar.test.tsx` | create | `TopBar` |
| `tests/components/sidepanel-shell.test.tsx` | create | Narrow/wide integration through `App` |
| `tests/components/sidepanel-layout.test.tsx` | modify | Nav selectors moved to chips/menus |
| `tests/components/review-view.test.tsx` | modify | Review reached through More menu |
| `tests/components/sidepanel-scan-ask.test.tsx` | modify | Scan reached through Tools menu (+ consent) |
| `tests/e2e/helpers/surfaces.ts` | modify | Tools/More helpers |
| `tests/e2e/shell.spec.ts`, `tests/e2e/decisions.spec.ts` | modify | Moved controls |

---

### Task 0: Amend the spec with decisions made while planning

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-sidepanel-shell-and-theme-design.md`

**Interfaces:**
- Produces: the amended spec that every later task cites.

- [ ] **Step 1: Amend the theme section**

In "Part 1 — Shared theme", replace the bullet beginning `- Add a few semantic tokens the side panel needs:` with:

```markdown
- Add two semantic tokens, `--row-hover` and `--row-selected`, exposed as the
  `bg-row-hover` / `bg-row-selected` utilities. The scope pane rows and the
  view chips consume them. Tag-chip colors are not added: `tag-chip.tsx`
  already owns them.
```

- [ ] **Step 2: Amend the shell section**

In "Part 2", replace the paragraph `### Wide mode (container width 640 px and up)` body and heading with:

```markdown
### Wide mode (viewport width 640 px and up)

The scope content renders as a permanent left column of about 224 px. It is
the same `ScopePane` component with a different host. The host is chosen in
JavaScript by `useIsWide()` (`matchMedia("(min-width: 640px)")`) so that
exactly one host renders. A CSS container query would render both hosts and
duplicate the folder tree in the DOM. A side panel's viewport width is the
panel width. When `matchMedia` is unavailable (jsdom) the hook reports wide.
```

Replace the heading `### Narrow mode (container width under 640 px)` with `### Narrow mode (viewport width under 640 px)`.

In the "Scope button" list item, replace `showing the current scope ("All bookmarks", a folder path, `#tag` or a category), with the item count and the List/Grid toggle on the same line. It replaces the old pane title. Activating it opens the scope drawer.` with:

```markdown
   A heading-level control showing the current view title from the existing
   `viewTitle` helper ("All bookmarks", the folder name, `#tag`, a category).
   It sits on the same line as the item count and List/Grid toggle (the
   `BookmarkList` toolbar gains a `leading` slot). It replaces the old pane
   title. In narrow mode it opens the scope drawer; in wide mode it is plain
   text.
```

In "Tools menu and AI visibility", replace the first two bullets with:

```markdown
- Tools menu items: Import, Export, Manage tags, and Scan library when a
  provider is connected.
- With no provider connected, Scan library is replaced by a single "Set up
  AI…" entry that opens Options.
- Restructure appears in the More menu (not Tools) only when a provider is
  connected. Duplicates is always in More.
- "Provider connected" means any consent row at the current consent version
  whose scope is not the synthetic `jev_test` scope.
```

In the code-structure table, replace the `ScopeButton.tsx` row with `| ScopeHeading.tsx | Scope label heading; drawer trigger in narrow mode |`, and add rows `| useIsWide.ts | matchMedia hook (wide when unavailable) |` and `| useAiConnected.ts | Live "provider connected" read from Dexie |`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-29-sidepanel-shell-and-theme-design.md
git commit -m "docs(spec): amend side panel design with planning decisions"
```

---

### Task 1: Shared theme (global tokens, Geist, row tokens)

**Files:**
- Modify: `src/ui/styles.css`
- Modify: `src/entrypoints/options/OptionsApp.tsx:158`
- Modify: `src/entrypoints/options/SentLog.tsx:170`
- Create: `tests/unit/theme-tokens.test.ts`

**Interfaces:**
- Produces: Tailwind utilities `bg-row-hover`, `bg-row-selected`, `font-sans`, `font-mono` used by later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/theme-tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/ui/styles.css", import.meta.url),
  "utf8",
);

/** Every `:root { … }` block, including the one inside the dark media query. */
const rootBlocks = [...css.matchAll(/^\s*:root\s*\{([^}]*)\}/gm)].map(
  (match) => match[1] ?? "",
);

describe("global theme", () => {
  it("defines the teal primary and warm background on :root", () => {
    const all = rootBlocks.join("\n");
    expect(all).toContain("--primary: oklch(0.52 0.11 198)");
    expect(all).toContain("--background: oklch(0.975 0.004 90)");
  });

  it("has a dark-mode :root carrying the teal primary", () => {
    expect(rootBlocks.join("\n")).toContain("--primary: oklch(0.76 0.11 190)");
  });

  it("no longer scopes color tokens to .popup-root / .options-root", () => {
    expect(css).not.toMatch(/\.(options|popup)-root[^{]*\{[^}]*--background/);
  });

  it("defines the row tokens and exposes them as utilities", () => {
    expect(css).toContain("--row-hover:");
    expect(css).toContain("--row-selected:");
    expect(css).toContain("--color-row-hover: var(--row-hover)");
    expect(css).toContain("--color-row-selected: var(--row-selected)");
  });

  it("uses the standard font theme names", () => {
    expect(css).toContain('--font-sans: "Geist"');
    expect(css).toContain('--font-mono: "Geist Mono"');
    expect(css).not.toContain("font-options");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit tests/unit/theme-tokens.test.ts`
Expected: FAIL (primary is still `oklch(0.205 0 0)`, `font-options` still present).

- [ ] **Step 3: Replace the top of `styles.css`**

In `src/ui/styles.css`, replace everything from line 1 up to (but not including) the line `@theme inline {` with:

```css
@import "tailwindcss";

/*
 * Geist — vendored woff2 files bundled with the extension (no network).
 * Font: Vercel Geist, SIL OFL 1.1 (see src/entrypoints/options/fonts/LICENSE).
 */
@font-face {
  font-family: "Geist";
  src: url("../entrypoints/options/fonts/Geist-Variable.woff2")
    format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "Geist Mono";
  src: url("../entrypoints/options/fonts/GeistMono-Variable.woff2")
    format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@theme {
  --font-sans: "Geist", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}

/*
 * Design tokens shared by the popup, side panel and options page. The
 * primitives in src/ui/components/ reference these color/radius entries
 * (bg-background, text-foreground, bg-popover, border-input, ring-ring,
 * bg-destructive, rounded-*, …). Warm-neutral surfaces plus one deep-teal
 * accent; destructive/success/warning keep their semantic hues. Dark mode
 * follows `prefers-color-scheme`, matching Tailwind's default `dark:` variant.
 */
:root {
  --background: oklch(0.975 0.004 90);
  --foreground: oklch(0.19 0.012 255);
  --card: oklch(0.99 0.002 90);
  --card-foreground: oklch(0.19 0.012 255);
  --popover: oklch(0.99 0.002 90);
  --popover-foreground: oklch(0.19 0.012 255);
  --primary: oklch(0.52 0.11 198);
  --primary-foreground: oklch(0.985 0.005 200);
  --secondary: oklch(0.95 0.006 90);
  --secondary-foreground: oklch(0.24 0.015 255);
  --muted: oklch(0.95 0.006 90);
  --muted-foreground: oklch(0.5 0.015 255);
  --accent: oklch(0.94 0.022 195);
  --accent-foreground: oklch(0.32 0.06 210);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --border: oklch(0.9 0.008 90);
  --input: oklch(0.9 0.008 90);
  --ring: oklch(0.52 0.11 198);
  --row-hover: oklch(0.96 0.008 195);
  --row-selected: oklch(0.94 0.022 195);
  /* Tinted, ambient shadow — a hint of the accent hue instead of flat gray. */
  --shadow-color: oklch(0.3 0.04 220 / 8%);
  --radius: 0.625rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.16 0.008 250);
    --foreground: oklch(0.96 0.005 90);
    --card: oklch(0.2 0.008 250);
    --card-foreground: oklch(0.96 0.005 90);
    --popover: oklch(0.2 0.008 250);
    --popover-foreground: oklch(0.96 0.005 90);
    --primary: oklch(0.76 0.11 190);
    --primary-foreground: oklch(0.16 0.03 220);
    --secondary: oklch(0.25 0.01 250);
    --secondary-foreground: oklch(0.96 0.005 90);
    --muted: oklch(0.24 0.01 250);
    --muted-foreground: oklch(0.7 0.015 250);
    --accent: oklch(0.27 0.03 200);
    --accent-foreground: oklch(0.9 0.02 200);
    --destructive: oklch(0.704 0.191 22.216);
    --destructive-foreground: oklch(0.985 0 0);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 14%);
    --ring: oklch(0.76 0.11 190);
    --row-hover: oklch(0.25 0.012 200);
    --row-selected: oklch(0.29 0.04 200);
    --shadow-color: oklch(0 0 0 / 30%);
  }
}

```

- [ ] **Step 4: Expose the row tokens as utilities**

In the `@theme inline { … }` block, add these two lines directly after `--color-ring: var(--ring);`:

```css
  --color-row-hover: var(--row-hover);
  --color-row-selected: var(--row-selected);
```

- [ ] **Step 5: Replace the base layer's font rules**

In `@layer base { … }`, replace the block from the comment `/* Options page: Geist + tabular numbers …` through the closing brace of `.options-root::after { … }` with:

```css
  /* Geist + tabular numbers everywhere; the grain overlay below is the
     Options page's alone (a decorative extra the side panel's virtualized
     list does not need). The overlay is inert. */
  body {
    font-family: var(--font-sans);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  code,
  kbd {
    font-family: var(--font-mono);
    font-variant-numeric: normal;
  }
  .options-root::after {
    content: "";
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.035;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  }
```

Leave the `@media (prefers-reduced-motion …)` block and everything else in the layer as is.

- [ ] **Step 6: Rename the two font utility usages**

In `src/entrypoints/options/OptionsApp.tsx` line 158, change

```tsx
    <div className="options-root min-h-dvh bg-background font-options-sans text-foreground">
```

to

```tsx
    <div className="options-root min-h-dvh bg-background text-foreground">
```

In `src/entrypoints/options/SentLog.tsx` line 170, change `font-options-mono` to `font-mono`.

- [ ] **Step 7: Run the test to verify it passes, then the gates**

Run: `npx vitest run --project unit tests/unit/theme-tokens.test.ts`
Expected: PASS (5 tests).

Run: `npm run lint && npm run typecheck && npx vitest run --project components tests/components/options-app.test.tsx tests/components/popup-save.test.tsx`
Expected: lint and typecheck clean. Component files pass (`popup-save` has a known flaky 150 ms budget test; re-run alone if only that fails).

- [ ] **Step 8: Before/after screenshot check of popup and Options**

The "before" set already exists in `/tmp/capture/shots/` (`popup-380.png`, `options-*.png`). Edit `/tmp/capture/capture.mjs` so the output directory can be overridden: change `const OUT = "/tmp/capture/shots";` to `const OUT = process.env.OUT ?? "/tmp/capture/shots";`. Then:

Run: `cd /home/ubuntu/Documents/project/BookmarksManager && npm run build && cd /tmp/capture && OUT=/tmp/capture/after-theme node capture.mjs`
Expected: 21 `shot ...` lines. Read `popup-380.png` and `options-connections.png` from both directories. Popup and Options must look the same as before (same colors, Geist). The side panel shots must now show the teal accent and Geist (for example the "Start scan" button is teal).

- [ ] **Step 9: Commit**

```bash
git add src/ui/styles.css src/entrypoints/options/OptionsApp.tsx src/entrypoints/options/SentLog.tsx tests/unit/theme-tokens.test.ts
git commit -m "feat(ui): make the warm-neutral teal theme and Geist global"
```

---

### Task 2: Pure scope helpers (`scope.ts`)

**Files:**
- Create: `src/entrypoints/sidepanel/scope.ts`
- Create: `tests/unit/sidepanel-scope.test.ts`

**Interfaces:**
- Produces (exact):
  - `interface CategoryCount { category: Category; count: number }`
  - `categoryCounts(metas: readonly BookmarkMeta[], tree: FlattenedTree): CategoryCount[]`
  - `interface AiVisibility { showReview: boolean; showRestructure: boolean; showScan: boolean; showSetUpAi: boolean }`
  - `aiVisibility(input: { aiConnected: boolean; pendingCount: number }): AiVisibility`
  - `type MoreViewKind = "duplicates" | "review" | "restructure"`
  - `interface MoreView { kind: MoreViewKind; label: string }`
  - `moreViews(visibility: AiVisibility, activeKind: SidePanelViewKind): MoreView[]`
  - `const PRIMARY_CHIPS: readonly { kind: "all" | "recent" | "untagged"; label: string }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sidepanel-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PRIMARY_CHIPS,
  aiVisibility,
  categoryCounts,
  moreViews,
} from "../../src/entrypoints/sidepanel/scope";
import type { BookmarkMeta } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";

const ISO = "2026-09-29T10:00:00.000Z";

const nodes: BookmarksTreeNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        parentId: "0",
        index: 0,
        title: "Bookmarks bar",
        children: [
          { id: "b1", parentId: "1", index: 0, title: "A", url: "https://a.example/" },
          { id: "b2", parentId: "1", index: 1, title: "B", url: "https://b.example/" },
          { id: "b3", parentId: "1", index: 2, title: "C", url: "https://c.example/" },
        ],
      },
    ],
  },
];
const tree = flattenTree(nodes);

function meta(id: string, category?: BookmarkMeta["category"]): BookmarkMeta {
  return { id, tags: [], category, updatedAt: ISO };
}

describe("categoryCounts", () => {
  it("counts only categories with at least one bookmark, in schema order", () => {
    const counts = categoryCounts(
      [meta("b1", "docs"), meta("b2", "docs"), meta("b3", "article")],
      tree,
    );
    expect(counts).toEqual([
      { category: "article", count: 1 },
      { category: "docs", count: 2 },
    ]);
  });

  it("ignores rows without a category and rows for bookmarks that no longer exist", () => {
    expect(
      categoryCounts([meta("b1"), meta("gone", "video")], tree),
    ).toEqual([]);
  });
});

describe("aiVisibility", () => {
  it("hides every AI entry and offers setup when no provider is connected", () => {
    expect(aiVisibility({ aiConnected: false, pendingCount: 0 })).toEqual({
      showReview: false,
      showRestructure: false,
      showScan: false,
      showSetUpAi: true,
    });
  });

  it("still shows Review when suggestions are pending without a provider", () => {
    const vis = aiVisibility({ aiConnected: false, pendingCount: 2 });
    expect(vis.showReview).toBe(true);
    expect(vis.showScan).toBe(false);
  });

  it("shows every AI entry and no setup prompt when connected", () => {
    expect(aiVisibility({ aiConnected: true, pendingCount: 0 })).toEqual({
      showReview: true,
      showRestructure: true,
      showScan: true,
      showSetUpAi: false,
    });
  });
});

describe("moreViews", () => {
  const off = aiVisibility({ aiConnected: false, pendingCount: 0 });
  const on = aiVisibility({ aiConnected: true, pendingCount: 0 });

  it("always lists Duplicates and hides AI views without a provider", () => {
    expect(moreViews(off, "all").map((v) => v.kind)).toEqual(["duplicates"]);
  });

  it("lists Duplicates, Review and Restructure when connected", () => {
    expect(moreViews(on, "all")).toEqual([
      { kind: "duplicates", label: "Duplicates" },
      { kind: "review", label: "Review suggestions" },
      { kind: "restructure", label: "Restructure" },
    ]);
  });

  it("keeps the active view listed even when its visibility rule is off", () => {
    expect(moreViews(off, "review").map((v) => v.kind)).toEqual([
      "duplicates",
      "review",
    ]);
  });
});

describe("PRIMARY_CHIPS", () => {
  it("is All, Recent, Untagged", () => {
    expect(PRIMARY_CHIPS.map((c) => c.label)).toEqual([
      "All",
      "Recent",
      "Untagged",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit tests/unit/sidepanel-scope.test.ts`
Expected: FAIL (module `scope` not found).

- [ ] **Step 3: Write the implementation**

Create `src/entrypoints/sidepanel/scope.ts`:

```ts
import { Category } from "../../schemas/bookmark";
import type { BookmarkMeta } from "../../schemas/meta";
import type { FlattenedTree } from "../../sync/tree";
import type { SidePanelViewKind } from "./views";

/**
 * Pure helpers behind the side-panel shell: which categories are worth
 * listing, which AI entries a user without a provider should see, and which
 * views live behind the "More" chip. No React, no Dexie, no chrome.
 */

export interface CategoryCount {
  category: Category;
  count: number;
}

/**
 * Bookmarks per category, in schema order, omitting empty categories. Meta
 * rows for bookmarks that no longer exist are ignored — rows are lazy and
 * can outlive their node.
 */
export function categoryCounts(
  metas: readonly BookmarkMeta[],
  tree: FlattenedTree,
): CategoryCount[] {
  const counts = new Map<Category, number>();
  for (const meta of metas) {
    if (meta.category === undefined || !tree.bookmarks.has(meta.id)) continue;
    counts.set(meta.category, (counts.get(meta.category) ?? 0) + 1);
  }
  return Category.options.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [{ category, count }] : [];
  });
}

export interface AiVisibility {
  showReview: boolean;
  showRestructure: boolean;
  showScan: boolean;
  showSetUpAi: boolean;
}

/**
 * Review stays reachable while suggestions are pending even if the provider
 * was later disconnected; everything that starts new AI work needs a
 * connected provider. Without one, a single "Set up AI…" entry replaces them.
 */
export function aiVisibility(input: {
  aiConnected: boolean;
  pendingCount: number;
}): AiVisibility {
  const { aiConnected, pendingCount } = input;
  return {
    showReview: aiConnected || pendingCount > 0,
    showRestructure: aiConnected,
    showScan: aiConnected,
    showSetUpAi: !aiConnected,
  };
}

export type MoreViewKind = "duplicates" | "review" | "restructure";

export interface MoreView {
  kind: MoreViewKind;
  label: string;
}

const MORE_LABELS: Record<MoreViewKind, string> = {
  duplicates: "Duplicates",
  review: "Review suggestions",
  restructure: "Restructure",
};

/**
 * Views listed in the "More" menu. The active view is always listed so the
 * chip row can name where the user is, even if its visibility rule turned
 * off underneath them.
 */
export function moreViews(
  visibility: AiVisibility,
  activeKind: SidePanelViewKind,
): MoreView[] {
  const show: Record<MoreViewKind, boolean> = {
    duplicates: true,
    review: visibility.showReview,
    restructure: visibility.showRestructure,
  };
  return (Object.keys(MORE_LABELS) as MoreViewKind[])
    .filter((kind) => show[kind] || kind === activeKind)
    .map((kind) => ({ kind, label: MORE_LABELS[kind] }));
}

/** The always-visible chips. */
export const PRIMARY_CHIPS: readonly {
  kind: "all" | "recent" | "untagged";
  label: string;
}[] = [
  { kind: "all", label: "All" },
  { kind: "recent", label: "Recent" },
  { kind: "untagged", label: "Untagged" },
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit tests/unit/sidepanel-scope.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/entrypoints/sidepanel/scope.ts tests/unit/sidepanel-scope.test.ts
git commit -m "feat(sidepanel): add pure scope, category and AI-visibility helpers"
```

---

### Task 3: `useIsWide` and `useAiConnected` hooks

**Files:**
- Create: `src/entrypoints/sidepanel/useIsWide.ts`
- Create: `src/entrypoints/sidepanel/useAiConnected.ts`
- Create: `tests/components/sidepanel-hooks.test.tsx`

**Interfaces:**
- Produces (exact):
  - `export const WIDE_QUERY = "(min-width: 640px)"`
  - `export function useIsWide(): boolean`
  - `export function readAiConnected(): Promise<boolean>`
  - `export function useAiConnected(): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/components/sidepanel-hooks.test.tsx`:

```tsx
import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
} from "../../src/schemas/provider";
import {
  readAiConnected,
  useAiConnected,
} from "../../src/entrypoints/sidepanel/useAiConnected";
import {
  WIDE_QUERY,
  useIsWide,
} from "../../src/entrypoints/sidepanel/useIsWide";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const mql = {
    matches: initial,
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) =>
      listeners.delete(cb),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      return mql;
    }),
  );
  return {
    queries,
    set(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb();
    },
  };
}

describe("useIsWide", () => {
  it("reports wide when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useIsWide());
    expect(result.current).toBe(true);
  });

  it("follows the 640px media query and reacts to changes", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsWide());
    expect(result.current).toBe(false);
    expect(media.queries).toContain(WIDE_QUERY);
    expect(WIDE_QUERY).toBe("(min-width: 640px)");

    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });
});

describe("useAiConnected", () => {
  beforeAll(async () => {
    await db.open();
  });
  afterAll(() => {
    db.close();
  });
  beforeEach(async () => {
    await db.consents.clear();
  });

  const row = (scope: string, version = CONSENT_VERSION) => ({
    scope: scope as typeof DECISIONS_CONSENT_SCOPE,
    origin: "https://provider.example",
    consentVersion: version,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });

  it("is false with no consent rows", async () => {
    expect(await readAiConnected()).toBe(false);
  });

  it("ignores the synthetic test-connection scope", async () => {
    await db.consents.put(row(CONSENT_SCOPE));
    expect(await readAiConnected()).toBe(false);
  });

  it("ignores stale consent versions", async () => {
    await db.consents.put(row(DECISIONS_CONSENT_SCOPE, CONSENT_VERSION - 1));
    expect(await readAiConnected()).toBe(false);
  });

  it("is true for a current decisions consent, live", async () => {
    const { result } = renderHook(() => useAiConnected());
    expect(result.current).toBe(false);
    await db.consents.put(row(DECISIONS_CONSENT_SCOPE));
    await waitFor(() => expect(result.current).toBe(true));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-hooks.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `useIsWide.ts`**

Create `src/entrypoints/sidepanel/useIsWide.ts`:

```ts
import { useSyncExternalStore } from "react";

/**
 * Viewport width at and above which the side panel shows the permanent scope
 * column instead of the scope drawer. A side panel's viewport width IS the
 * panel width, so `matchMedia` tracks the user resizing the panel.
 */
export const WIDE_QUERY = "(min-width: 640px)";

function hasMatchMedia(): boolean {
  return typeof globalThis.matchMedia === "function";
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const mql = globalThis.matchMedia(WIDE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  // No matchMedia (jsdom, tests): render the fuller wide layout.
  return hasMatchMedia() ? globalThis.matchMedia(WIDE_QUERY).matches : true;
}

/** True when the panel is wide enough for the permanent scope column. */
export function useIsWide(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
```

- [ ] **Step 4: Write `useAiConnected.ts`**

Create `src/entrypoints/sidepanel/useAiConnected.ts`:

```ts
import { useLiveQuery } from "dexie-react-hooks";
import { CONSENT_VERSION } from "../../consent/records";
import { db } from "../../db/database";
import { CONSENT_SCOPE } from "../../schemas/provider";

/**
 * True when any consent row at the current {@link CONSENT_VERSION} exists for
 * a real scope. The synthetic `jev_test` scope (the "Test connection" click)
 * does not count: it sends nothing about bookmarks. Origin- and
 * scope-agnostic on purpose, like the Ask toggle's read — the worker stays
 * the authority on what actually sends. The `.catch` is required because
 * `useLiveQuery` rethrows observable errors.
 */
export function readAiConnected(): Promise<boolean> {
  return db.consents
    .toArray()
    .then((rows) =>
      rows.some(
        (row) =>
          row.consentVersion === CONSENT_VERSION &&
          row.scope !== CONSENT_SCOPE,
      ),
    )
    .catch((): boolean => false);
}

/** Live "an AI provider is connected" flag; `false` until Dexie answers. */
export function useAiConnected(): boolean {
  return useLiveQuery(readAiConnected, []) === true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project components tests/components/sidepanel-hooks.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/entrypoints/sidepanel/useIsWide.ts src/entrypoints/sidepanel/useAiConnected.ts tests/components/sidepanel-hooks.test.tsx
git commit -m "feat(sidepanel): add useIsWide and useAiConnected hooks"
```

---

### Task 4: `ScopePane` (folders, tags, categories)

**Files:**
- Create: `src/entrypoints/sidepanel/ScopePane.tsx`
- Create: `tests/components/sidepanel-scope-pane.test.tsx`

**Interfaces:**
- Consumes: `CategoryCount` from `./scope`; `SidePanelView` from `./views`; `FolderTree` (unchanged); `TagDef`; `FlattenedTree`, `FolderNode`.
- Produces (exact):
  ```ts
  export interface ScopePaneProps {
    tree: FlattenedTree;
    view: SidePanelView;
    tagDefs: readonly TagDef[];
    categories: readonly CategoryCount[];
    onSelect(view: SidePanelView): void;
    renderFolderActions?: (node: FolderNode) => ReactNode;
    renderFolderContextMenu?: (node: FolderNode) => ReactNode;
  }
  export function ScopePane(props: ScopePaneProps): ReactElement
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/components/sidepanel-scope-pane.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScopePane } from "../../src/entrypoints/sidepanel/ScopePane";
import type { ScopePaneProps } from "../../src/entrypoints/sidepanel/ScopePane";
import type { TagDef } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";

const ISO = "2026-09-29T10:00:00.000Z";

const nodes: BookmarksTreeNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        parentId: "0",
        index: 0,
        title: "Bookmarks bar",
        children: [
          {
            id: "10",
            parentId: "1",
            index: 0,
            title: "Dev",
            children: [
              { id: "b1", parentId: "10", index: 0, title: "A", url: "https://a.example/" },
            ],
          },
        ],
      },
      { id: "2", parentId: "0", index: 1, title: "Other bookmarks", children: [] },
    ],
  },
];
const tree: FlattenedTree = flattenTree(nodes);
const devTag: TagDef = {
  name: "Ops",
  nameKey: "ops",
  createdAt: ISO,
  updatedAt: ISO,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function renderPane(overrides: Partial<ScopePaneProps> = {}) {
  const onSelect = vi.fn();
  render(
    <ScopePane
      tree={tree}
      view={{ kind: "all" }}
      tagDefs={[devTag]}
      categories={[{ category: "docs", count: 2 }]}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return onSelect;
}

describe("ScopePane", () => {
  it("renders folders, tags and non-empty categories with counts", () => {
    renderPane();
    expect(screen.getByRole("treeitem", { name: "Dev" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ops" })).toBeTruthy();
    const docs = screen.getByRole("button", { name: /^Docs/ });
    expect(docs.textContent).toContain("2");
  });

  it("omits the Tags and Categories sections when empty", () => {
    renderPane({ tagDefs: [], categories: [] });
    expect(screen.queryByRole("heading", { name: "Tags" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Categories" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Folders" })).toBeTruthy();
  });

  it("shows a loading note until the tree has folders", () => {
    renderPane({ tree: flattenTree([]) });
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("routes selections to onSelect as views", () => {
    const onSelect = renderPane();
    fireEvent.click(screen.getByRole("treeitem", { name: "Dev" }));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "folder",
      folderId: "10",
    });
    fireEvent.click(screen.getByRole("button", { name: "Ops" }));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "tag", nameKey: "ops" });
    fireEvent.click(screen.getByRole("button", { name: /^Docs/ }));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "category",
      category: "docs",
    });
  });

  it("marks the current scope as pressed/selected", () => {
    renderPane({ view: { kind: "tag", nameKey: "ops" } });
    expect(
      screen.getByRole("button", { name: "Ops" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /^Docs/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-scope-pane.test.tsx`
Expected: FAIL (module `ScopePane` not found).

- [ ] **Step 3: Write the implementation**

Create `src/entrypoints/sidepanel/ScopePane.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import type { TagDef } from "../../schemas/meta";
import type { FlattenedTree, FolderNode } from "../../sync/tree";
import { FolderTree } from "./FolderTree";
import type { CategoryCount } from "./scope";
import type { SidePanelView } from "./views";

/**
 * The "where am I looking" content: folder tree, tags, categories. It is
 * host-agnostic — the shell renders it in the permanent left column when the
 * panel is wide and inside the scope drawer when it is narrow.
 */
export interface ScopePaneProps {
  tree: FlattenedTree;
  view: SidePanelView;
  tagDefs: readonly TagDef[];
  categories: readonly CategoryCount[];
  onSelect(view: SidePanelView): void;
  renderFolderActions?: (node: FolderNode) => ReactNode;
  renderFolderContextMenu?: (node: FolderNode) => ReactNode;
}

const ROW_CLASS =
  "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 " +
  "text-left text-sm outline-hidden hover:bg-row-hover " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "aria-pressed:bg-row-selected aria-pressed:font-medium " +
  "aria-pressed:text-accent-foreground";

const HEADING_CLASS =
  "px-2 pb-1 text-xs font-medium text-muted-foreground";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ScopePane({
  tree,
  view,
  tagDefs,
  categories,
  onSelect,
  renderFolderActions,
  renderFolderContextMenu,
}: ScopePaneProps): ReactElement {
  return (
    <div className="space-y-4">
      <section aria-label="Folders">
        <h3 className={HEADING_CLASS}>Folders</h3>
        {tree.folders.size === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <FolderTree
            tree={tree}
            selectedFolderId={
              view.kind === "folder" ? view.folderId : undefined
            }
            onSelectFolder={(folderId) =>
              onSelect({ kind: "folder", folderId })
            }
            renderFolderActions={renderFolderActions}
            renderFolderContextMenu={renderFolderContextMenu}
          />
        )}
      </section>
      {tagDefs.length > 0 && (
        <section aria-label="Tags">
          <h3 className={HEADING_CLASS}>Tags</h3>
          <ul className="space-y-0.5">
            {tagDefs.map((tag) => (
              <li key={tag.nameKey}>
                <button
                  type="button"
                  aria-pressed={
                    view.kind === "tag" && view.nameKey === tag.nameKey
                  }
                  onClick={() =>
                    onSelect({ kind: "tag", nameKey: tag.nameKey })
                  }
                  className={ROW_CLASS}
                >
                  <span className="truncate">
                    <span aria-hidden="true">#</span>
                    {tag.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {categories.length > 0 && (
        <section aria-label="Categories">
          <h3 className={HEADING_CLASS}>Categories</h3>
          <ul className="space-y-0.5">
            {categories.map(({ category, count }) => (
              <li key={category}>
                <button
                  type="button"
                  aria-pressed={
                    view.kind === "category" && view.category === category
                  }
                  onClick={() => onSelect({ kind: "category", category })}
                  className={ROW_CLASS}
                >
                  <span className="truncate">{capitalize(category)}</span>
                  <span className="text-xs text-muted-foreground">
                    {count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project components tests/components/sidepanel-scope-pane.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/entrypoints/sidepanel/ScopePane.tsx tests/components/sidepanel-scope-pane.test.tsx
git commit -m "feat(sidepanel): add ScopePane for folders, tags and categories"
```

---

### Task 5: `ScopeDrawer` and `ScopeHeading`

**Files:**
- Create: `src/entrypoints/sidepanel/ScopeDrawer.tsx`
- Create: `src/entrypoints/sidepanel/ScopeHeading.tsx`
- Create: `tests/components/sidepanel-scope-drawer.test.tsx`

**Interfaces:**
- Produces (exact):
  ```ts
  // ScopeDrawer.tsx
  export interface ScopeDrawerProps {
    open: boolean;
    onOpenChange(open: boolean): void;
    /** Rendered through Radix Trigger (asChild); focus returns to it on close. */
    trigger: ReactElement;
    children: ReactNode;
  }
  export function ScopeDrawer(props: ScopeDrawerProps): ReactElement
  // ScopeHeading.tsx
  export interface ScopeHeadingProps {
    title: string;
    /** Present in narrow mode only. */
    drawer?: { open: boolean; onOpenChange(open: boolean): void; children: ReactNode };
  }
  export function ScopeHeading(props: ScopeHeadingProps): ReactElement
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/components/sidepanel-scope-drawer.test.tsx`:

```tsx
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScopeHeading } from "../../src/entrypoints/sidepanel/ScopeHeading";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function NarrowHarness() {
  const [open, setOpen] = useState(false);
  return (
    <ScopeHeading
      title="All bookmarks"
      drawer={{
        open,
        onOpenChange: setOpen,
        children: (
          <button type="button" onClick={() => setOpen(false)}>
            Pick Dev
          </button>
        ),
      }}
    />
  );
}

describe("ScopeHeading", () => {
  it("renders plain heading text when there is no drawer (wide mode)", () => {
    render(<ScopeHeading title="Dev" />);
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes the heading a drawer trigger in narrow mode", () => {
    render(<NarrowHarness />);
    const heading = screen.getByRole("heading", { name: "All bookmarks" });
    expect(heading.querySelector("button")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the drawer, closes on Escape and returns focus to the trigger", async () => {
    render(<NarrowHarness />);
    const trigger = screen.getByRole("button", { name: "All bookmarks" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Browse" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pick Dev" })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("closes when the content selects something", async () => {
    render(<NarrowHarness />);
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick Dev" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-scope-drawer.test.tsx`
Expected: FAIL (module `ScopeHeading` not found).

- [ ] **Step 3: Write `ScopeDrawer.tsx`**

Create `src/entrypoints/sidepanel/ScopeDrawer.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "../../ui/components/icons";

/**
 * Left sheet over the side panel that hosts the scope content in narrow
 * mode. It is a Radix modal dialog, so Escape closes it, focus is trapped
 * while open, and focus returns to the trigger on close.
 */
export interface ScopeDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactElement;
  children: ReactNode;
}

export function ScopeDrawer({
  open,
  onOpenChange,
  trigger,
  children,
}: ScopeDrawerProps): ReactElement {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,88vw)] flex-col border-r border-border bg-background shadow-pop outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:slide-in-from-left-2">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Browse
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-sm p-1 text-muted-foreground outline-hidden hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">
            Choose a folder, tag or category to show.
          </DialogPrimitive.Description>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
```

- [ ] **Step 4: Write `ScopeHeading.tsx`**

Create `src/entrypoints/sidepanel/ScopeHeading.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import { ChevronDownIcon } from "../../ui/components/icons";
import { ScopeDrawer } from "./ScopeDrawer";

/**
 * The current view's title as an `<h2>`. In narrow mode the title is a
 * button that opens the scope drawer; in wide mode (no `drawer`) it is plain
 * text because the scope column is already on screen. The heading's
 * accessible name is the title in both modes.
 */
export interface ScopeHeadingProps {
  title: string;
  drawer?: {
    open: boolean;
    onOpenChange(open: boolean): void;
    children: ReactNode;
  };
}

export function ScopeHeading({
  title,
  drawer,
}: ScopeHeadingProps): ReactElement {
  return (
    <h2 className="min-w-0 text-sm font-medium">
      {drawer === undefined ? (
        <span className="block truncate">{title}</span>
      ) : (
        <ScopeDrawer
          open={drawer.open}
          onOpenChange={drawer.onOpenChange}
          trigger={
            <button
              type="button"
              className="flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 -mx-1 outline-hidden hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{title}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        >
          {drawer.children}
        </ScopeDrawer>
      )}
    </h2>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project components tests/components/sidepanel-scope-drawer.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/entrypoints/sidepanel/ScopeDrawer.tsx src/entrypoints/sidepanel/ScopeHeading.tsx tests/components/sidepanel-scope-drawer.test.tsx
git commit -m "feat(sidepanel): add scope drawer and scope heading"
```

---

### Task 6: `ViewChips` and shared menu test helpers

**Files:**
- Create: `tests/components/menu-helpers.ts`
- Create: `src/entrypoints/sidepanel/ViewChips.tsx`
- Create: `tests/components/sidepanel-chips.test.tsx`

**Interfaces:**
- Consumes: `AiVisibility`, `PRIMARY_CHIPS`, `moreViews` from `./scope`; `SidePanelViewKind` from `./views`.
- Produces (exact):
  ```ts
  export interface ViewChipsProps {
    activeKind: SidePanelViewKind;
    pendingCount: number;
    visibility: AiVisibility;
    onSelect(kind: SidePanelViewKind): void;
  }
  export function ViewChips(props: ViewChipsProps): ReactElement
  // tests/components/menu-helpers.ts
  export function openMenu(name: string | RegExp): Promise<void>
  export function chooseMenuItem(name: string | RegExp): Promise<void>
  ```

- [ ] **Step 1: Create the shared test helper**

Create `tests/components/menu-helpers.ts`:

```ts
import { fireEvent, screen } from "@testing-library/react";

/** Radix dropdown triggers open on pointerdown; jsdom needs the explicit event. */
export async function openMenu(name: string | RegExp): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByRole("menu");
}

/** Click one item of the currently open menu. */
export async function chooseMenuItem(name: string | RegExp): Promise<void> {
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/components/sidepanel-chips.test.tsx`:

```tsx
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-chips.test.tsx`
Expected: FAIL (module `ViewChips` not found).

- [ ] **Step 4: Write the implementation**

Create `src/entrypoints/sidepanel/ViewChips.tsx`:

```tsx
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { ChevronDownIcon } from "../../ui/components/icons";
import { PRIMARY_CHIPS, moreViews } from "./scope";
import type { AiVisibility } from "./scope";
import type { SidePanelViewKind } from "./views";

/**
 * The view switcher: All / Recent / Untagged chips plus a "More" menu for
 * Duplicates, Review suggestions and Restructure. When the active view lives
 * in More, the More chip is relabelled with that view's name so the chip row
 * always says where the user is. The pending-suggestion count shows on the
 * More chip and on the Review item.
 */
export interface ViewChipsProps {
  activeKind: SidePanelViewKind;
  pendingCount: number;
  visibility: AiVisibility;
  onSelect(kind: SidePanelViewKind): void;
}

const CHIP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-border " +
  "px-2.5 py-1 text-xs outline-hidden hover:bg-row-hover " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "aria-pressed:border-transparent aria-pressed:bg-row-selected " +
  "aria-pressed:font-medium aria-pressed:text-accent-foreground " +
  "data-[active=true]:border-transparent data-[active=true]:bg-row-selected " +
  "data-[active=true]:font-medium data-[active=true]:text-accent-foreground";

export function ViewChips({
  activeKind,
  pendingCount,
  visibility,
  onSelect,
}: ViewChipsProps): ReactElement {
  const more = moreViews(visibility, activeKind);
  const activeMore = more.find((entry) => entry.kind === activeKind);
  return (
    <nav
      aria-label="Views"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
    >
      {PRIMARY_CHIPS.map(({ kind, label }) => (
        <button
          key={kind}
          type="button"
          aria-pressed={activeKind === kind}
          onClick={() => onSelect(kind)}
          className={CHIP_CLASS}
        >
          {label}
        </button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-active={activeMore !== undefined}
            className={CHIP_CLASS}
          >
            {activeMore?.label ?? "More"}
            {pendingCount > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="rounded-sm bg-primary px-1.5 text-[10px] font-medium text-primary-foreground"
                >
                  {pendingCount}
                </span>
                <span className="sr-only">, {pendingCount} pending</span>
              </>
            )}
            <ChevronDownIcon className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {more.map(({ kind, label }) => (
            <DropdownMenuItem key={kind} onSelect={() => onSelect(kind)}>
              {label}
              {kind === "review" && pendingCount > 0 && (
                <span className="ml-auto rounded-sm bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
                  {pendingCount}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project components tests/components/sidepanel-chips.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add tests/components/menu-helpers.ts src/entrypoints/sidepanel/ViewChips.tsx tests/components/sidepanel-chips.test.tsx
git commit -m "feat(sidepanel): add view chips with a More menu"
```

---

### Task 7: `TopBar` with the Tools menu

**Files:**
- Create: `src/entrypoints/sidepanel/TopBar.tsx`
- Create: `tests/components/sidepanel-topbar.test.tsx`

**Interfaces:**
- Consumes: `AiVisibility` from `./scope`; `SettingsIcon` from `../../ui/components/settings-icon`; dropdown primitives.
- Produces (exact):
  ```ts
  export type ToolsAction = "import" | "export" | "manage-tags" | "scan" | "set-up-ai";
  export interface TopBarProps {
    search: ReactNode;
    visibility: AiVisibility;
    onTools(action: ToolsAction): void;
    onOpenSettings(): void;
  }
  export function TopBar(props: TopBarProps): ReactElement
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/components/sidepanel-topbar.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components tests/components/sidepanel-topbar.test.tsx`
Expected: FAIL (module `TopBar` not found).

- [ ] **Step 3: Write the implementation**

Create `src/entrypoints/sidepanel/TopBar.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { SettingsIcon } from "../../ui/components/settings-icon";
import type { AiVisibility } from "./scope";

/**
 * Top of the side panel: the search input (passed as a slot), the Tools menu
 * and Settings. There is no visible title — Chrome's panel header already
 * names the extension — but a screen-reader-only `<h1>` keeps the landmark.
 */
export type ToolsAction =
  | "import"
  | "export"
  | "manage-tags"
  | "scan"
  | "set-up-ai";

export interface TopBarProps {
  search: ReactNode;
  visibility: AiVisibility;
  onTools(action: ToolsAction): void;
  onOpenSettings(): void;
}

const ICON_BUTTON_CLASS =
  "shrink-0 rounded-sm p-1 text-muted-foreground outline-hidden " +
  "hover:bg-row-hover hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring";

export function TopBar({
  search,
  visibility,
  onTools,
  onOpenSettings,
}: TopBarProps): ReactElement {
  return (
    <header className="shrink-0 border-b border-border px-3 py-2">
      <h1 className="sr-only">Bookmarks Manager</h1>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">{search}</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Tools"
              title="Tools"
              className={`${ICON_BUTTON_CLASS} px-2 text-base leading-none`}
            >
              ⋯
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onTools("import")}>
              Import…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTools("export")}>
              Export…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTools("manage-tags")}>
              Manage tags…
            </DropdownMenuItem>
            {visibility.showScan && (
              <DropdownMenuItem onSelect={() => onTools("scan")}>
                Scan library…
              </DropdownMenuItem>
            )}
            {visibility.showSetUpAi && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onTools("set-up-ai")}>
                  Set up AI…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
          className={ICON_BUTTON_CLASS}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project components tests/components/sidepanel-topbar.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add src/entrypoints/sidepanel/TopBar.tsx tests/components/sidepanel-topbar.test.tsx
git commit -m "feat(sidepanel): add top bar with a Tools menu"
```

---

### Task 8: Compose the new shell in `App.tsx` and update the existing tests

This task is deliberately one unit: swapping the shell breaks the existing App-level tests until their selectors move, so the code change and the test updates must land together.

**Files:**
- Modify: `src/entrypoints/sidepanel/SearchBar.tsx`
- Modify: `src/entrypoints/sidepanel/BookmarkList.tsx`
- Modify: `src/entrypoints/sidepanel/App.tsx`
- Modify: `tests/components/sidepanel-layout.test.tsx`
- Modify: `tests/components/review-view.test.tsx`
- Modify: `tests/components/sidepanel-scan-ask.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2 to 7.
- Produces: `BookmarkListProps.leading?: ReactNode`.

- [ ] **Step 1: Update the tests first (they fail against the old shell)**

`tests/components/sidepanel-layout.test.tsx` — add the import near the other imports:

```tsx
import { chooseMenuItem, openMenu } from "./menu-helpers";
```

In the test `renders the two-pane shell with views, tree, and list`, replace

```tsx
    expect(
      screen.getByRole("button", { name: "Review suggestions" }),
    ).toBeTruthy();
```

with

```tsx
    expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
```

In the test `switches views and joins meta rows live`, replace the category click

```tsx
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
```

with

```tsx
    fireEvent.click(screen.getByRole("button", { name: /^Docs/ }));
```

replace the Duplicates click

```tsx
    fireEvent.click(screen.getByRole("button", { name: "Duplicates" }));
```

with

```tsx
    await openMenu(/^More/);
    await chooseMenuItem("Duplicates");
```

and replace the Recent click

```tsx
    fireEvent.click(
      screen.getByRole("button", { name: "Recently saved" }),
    );
```

with

```tsx
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
```

`tests/components/review-view.test.tsx` — add the import:

```tsx
import { chooseMenuItem, openMenu } from "./menu-helpers";
```

Replace the `openReviewView` helper (and its doc comment) with:

```tsx
/** Open the More menu, pick Review suggestions and wait for the queue. */
async function openReviewView(): Promise<HTMLElement> {
  await openMenu(/^More/);
  await chooseMenuItem(/Review suggestions/);
  return screen.findByRole("listbox", { name: "Pending suggestions" });
}
```

In `opens via the header button and nav entry with a pending-count badge`, rename the test to `opens via the More menu with a pending-count badge` and replace

```tsx
    const headerButton = screen.getByRole("button", {
      name: /Review suggestions/,
    });
    // The pending count streams from Dexie, so it lands a tick after mount.
    await waitFor(() => expect(headerButton.textContent).toContain("4"));
```

with

```tsx
    const moreButton = screen.getByRole("button", { name: /^More/ });
    // The pending count streams from Dexie, so it lands a tick after mount.
    await waitFor(() => expect(moreButton.textContent).toContain("4"));
```

In `excludes placeholders from bulk approve and from the pending badge`, replace

```tsx
    const headerButton = screen.getByRole("button", {
      name: /Review suggestions/,
    });
    await waitFor(() => expect(headerButton.textContent).toContain("4"));
    expect(headerButton.textContent).not.toContain("5");
```

with

```tsx
    const moreButton = screen.getByRole("button", { name: /^More/ });
    await waitFor(() => expect(moreButton.textContent).toContain("4"));
    expect(moreButton.textContent).not.toContain("5");
```

`tests/components/sidepanel-scan-ask.test.tsx` — add the import:

```tsx
import { chooseMenuItem, openMenu } from "./menu-helpers";
```

In `opens the scan dialog from the sidebar and starts a scan over every bookmark`, replace

```tsx
    await renderApp();

    // The sidebar entry opens the dialog hosting ScanPanel.
    fireEvent.click(screen.getByRole("button", { name: "Scan library…" }));
```

with

```tsx
    // Scan library is offered only once an AI provider is connected.
    await seedConsent();
    await renderApp();

    // The Tools menu entry opens the dialog hosting ScanPanel.
    await openMenu("Tools");
    await chooseMenuItem("Scan library…");
```

Also update that test's title to `opens the scan dialog from the Tools menu and starts a scan over every bookmark`.

- [ ] **Step 2: Run the updated tests to verify they fail**

Run: `npx vitest run --project components tests/components/sidepanel-layout.test.tsx tests/components/review-view.test.tsx tests/components/sidepanel-scan-ask.test.tsx`
Expected: FAIL on the App-level tests (no `Tools` button, no `More` chip yet). The pure `views`, `FolderTree` and `BookmarkList` tests still pass.

- [ ] **Step 3: Slim the `SearchBar` root**

In `src/entrypoints/sidepanel/SearchBar.tsx`, change the root element

```tsx
    <div className="shrink-0 border-b border-border px-3 py-2">
```

to

```tsx
    <div className="min-w-0 flex-1">
```

(The `TopBar` now owns the border and padding.)

- [ ] **Step 4: Add the `leading` slot to `BookmarkList`**

In `src/entrypoints/sidepanel/BookmarkList.tsx`, add to `BookmarkListProps` (just before `className?: string;`):

```tsx
  /**
   * Optional content at the start of the toolbar row (the shell puts the
   * scope heading here so the title, item count and List/Grid toggle share
   * one line).
   */
  leading?: ReactNode;
```

Add `leading,` to the destructured props of `BookmarkList` (next to `className`). Then replace the count span in the toolbar

```tsx
        <span className="mr-auto text-xs text-muted-foreground">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
```

with

```tsx
        {leading !== undefined && (
          <div className="mr-auto min-w-0 flex-1 px-1">{leading}</div>
        )}
        <span
          className={cn(
            "text-xs text-muted-foreground",
            leading === undefined && "mr-auto",
          )}
        >
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
```

- [ ] **Step 5: Rewire `App.tsx` imports and constants**

In `src/entrypoints/sidepanel/App.tsx`:

Remove these imports: `import { Category } from "../../schemas/bookmark";` and `import { SettingsIcon } from "../../ui/components/settings-icon";`.

Add these imports (next to the other `./` imports):

```tsx
import { ScopeHeading } from "./ScopeHeading";
import { ScopePane } from "./ScopePane";
import { TopBar } from "./TopBar";
import type { ToolsAction } from "./TopBar";
import { ViewChips } from "./ViewChips";
import { aiVisibility, categoryCounts } from "./scope";
import { useAiConnected } from "./useAiConnected";
import { useIsWide } from "./useIsWide";
```

Delete the `FIXED_VIEWS` constant and the `navButtonClass` constant (both are now unused). Keep `makeView`.

- [ ] **Step 6: Add shell state to the `App` component**

Directly after the existing `const pendingCount = useMemo(...)` block, add:

```tsx
  const wide = useIsWide();
  const aiConnected = useAiConnected();
  const visibility = useMemo(
    () => aiVisibility({ aiConnected, pendingCount }),
    [aiConnected, pendingCount],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
```

After the existing `const tagNameByKey = useMemo(...)` block, add:

```tsx
  const categories = useMemo(
    () => categoryCounts(metas, tree),
    [metas, tree],
  );
```

After the existing `handleFolderAction` function, replace it with a version that also closes the drawer (a folder dialog opening over an open drawer would stack two modals), and add `selectView` and `handleTools` next to it:

```tsx
  /** Folder menus route moves to the shared dialog, the rest to a prompt. */
  const handleFolderAction = (
    kind: FolderActionKind,
    node: FolderNode,
  ): void => {
    setDrawerOpen(false);
    if (kind === "move") {
      setMoveIds([node.id]);
      return;
    }
    setFolderRequest({ kind, node });
  };

  /**
   * Every scope/chip selection: Review clears any active search so the queue
   * is actually shown (same rule as a palette jump), and the narrow-mode
   * drawer closes once something is chosen.
   */
  const selectView = (next: SidePanelView): void => {
    if (next.kind === "review") setSearchQuery("");
    setView(next);
    setDrawerOpen(false);
  };

  const handleTools = (action: ToolsAction): void => {
    if (action === "import") setImportOpen(true);
    else if (action === "export") setExportOpen(true);
    else if (action === "manage-tags") setTagManagerOpen(true);
    else if (action === "scan") setScanOpen(true);
    else openOptionsPage();
  };
```

- [ ] **Step 7: Replace the shell JSX**

In the `return (` of `App`, replace everything from `<div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">` down to and including the matching `</DndProvider>` (the header, the `<aside>` rail, and the right-hand `<section>`) with the block below. Just before the `return (`, add the two helper elements:

```tsx
  const scopePane = (
    <ScopePane
      tree={tree}
      view={view}
      tagDefs={tagDefs}
      categories={categories}
      onSelect={selectView}
      renderFolderActions={(node) => (
        <FolderActions node={node} onAction={handleFolderAction} />
      )}
      renderFolderContextMenu={(node) => (
        <FolderActionsContextItems node={node} onAction={handleFolderAction} />
      )}
    />
  );
  const scopeHeading = (
    <ScopeHeading
      title={title}
      drawer={
        wide
          ? undefined
          : {
              open: drawerOpen,
              onOpenChange: setDrawerOpen,
              children: scopePane,
            }
      }
    />
  );
```

Then the replacement JSX:

```tsx
        <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
          <TopBar
            search={
              <SearchBar
                ref={searchInputRef}
                value={searchQuery}
                onChange={setSearchQuery}
                onRerankOrder={handleRerankOrder}
                resultCount={
                  searchQuery === ""
                    ? null
                    : search === null
                      ? null
                      : items.length
                }
                sources={suggestionSources}
                askDebounceMs={props?.askDebounceMs}
              />
            }
            visibility={visibility}
            onTools={handleTools}
            onOpenSettings={openOptionsPage}
          />
          <DndProvider tree={tree} selection={selection}>
            <div className="flex min-h-0 flex-1">
              {wide && (
                <aside
                  aria-label="Browse"
                  className="w-56 shrink-0 overflow-y-auto border-r border-border p-2"
                >
                  {scopePane}
                </aside>
              )}
              <section
                aria-label={title}
                className="flex min-w-0 flex-1 flex-col"
              >
                <ViewChips
                  activeKind={view.kind}
                  pendingCount={pendingCount}
                  visibility={visibility}
                  onSelect={(kind) => selectView(makeView(kind))}
                />
                {activeView.kind === "duplicates" ? (
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <DuplicatesView
                      groups={duplicateGroups}
                      metaById={metaById}
                      tagNameByKey={tagNameByKey}
                      loading={tree.folders.size === 0}
                      onActivateItem={openItem}
                      onRequestUndo={() =>
                        reportToast({
                          message: "Duplicates merged.",
                          undoable: true,
                        })
                      }
                      className="flex-1"
                    />
                  </>
                ) : activeView.kind === "review" ? (
                  // The pending-decisions queue replaces BookmarkList the
                  // same way DuplicatesView does — its rows are Decision
                  // rows from Dexie, not bookmarks.
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <ReviewView
                      decisions={pendingDecisions}
                      tree={tree}
                      onApplied={armDecisionRevert}
                      className="flex-1"
                    />
                  </>
                ) : activeView.kind === "restructure" ? (
                  // The restructure workflow replaces BookmarkList the same
                  // way ReviewView does — its rows are the job's diff.
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <RestructureView className="flex-1" />
                  </>
                ) : (
                  <BookmarkList
                    items={items}
                    metaById={metaById}
                    tagNameByKey={tagNameByKey}
                    onActivateItem={openItem}
                    onDeleteSelection={(ids) => void handleDeleteIds(ids)}
                    reorderable={
                      activeView.kind === "all" || activeView.kind === "folder"
                    }
                    renderItemActions={renderItemActions}
                    renderItemContextMenu={renderItemContextMenu}
                    leading={scopeHeading}
                    className="flex-1"
                  />
                )}
                <BulkBar
                  tree={tree}
                  onMoveRequest={(ids) => setMoveIds(ids)}
                />
              </section>
            </div>
          </DndProvider>
        </div>
```

Also update the doc comment above `export function App` (the ASCII two-pane diagram) to read: `Side-panel application shell — top bar (search, Tools, Settings), view chips, then the scope heading over the list; the scope content (folders, tags, categories) is a left column when wide and a drawer when narrow.`

Leave every dialog after the shell (`EditDialog`, `SummaryDialog`, `MoveToDialog`, `FolderActionDialog`, `TagManager`, the scan `Dialog`, `ImportDialog`, `ExportDialog`, `CommandPalette`, `UndoToast`) exactly as it is. The palette's `onJump` and `onCommand` handlers are unchanged.

- [ ] **Step 8: Run lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean. If lint reports `Category`, `SettingsIcon`, `FIXED_VIEWS` or `navButtonClass` unused, delete the leftover reference.

- [ ] **Step 9: Run every side-panel component test**

Run: `npx vitest run --project components tests/components/sidepanel-layout.test.tsx tests/components/review-view.test.tsx tests/components/sidepanel-scan-ask.test.tsx tests/components/sidepanel-search.test.tsx tests/components/sidepanel-dnd.test.tsx tests/components/sidepanel-actions.test.tsx tests/components/command-palette.test.tsx tests/components/command-palette-actions.test.tsx tests/components/duplicates-view.test.tsx tests/components/restructure-view.test.tsx tests/components/tag-manager.test.tsx tests/components/import-export.test.tsx tests/components/popup-save.test.tsx`
Expected: PASS. Known-flaky (they also failed on the pre-change baseline under load): the popup 150 ms budget, EditDialog edit, BulkBar tag, drag-overlay and scan-dialog tests. Re-run any failing file alone; a failure that persists alone is a real regression.

Because jsdom has no `matchMedia`, `useIsWide` reports wide, so these tests run against the wide layout (permanent scope column, tree visible). The narrow layout is covered in Task 9.

- [ ] **Step 10: Commit**

```bash
git add src/entrypoints/sidepanel/SearchBar.tsx src/entrypoints/sidepanel/BookmarkList.tsx src/entrypoints/sidepanel/App.tsx tests/components/sidepanel-layout.test.tsx tests/components/review-view.test.tsx tests/components/sidepanel-scan-ask.test.tsx
git commit -m "feat(sidepanel): narrow-first shell with chips, Tools menu and scope drawer"
```

---

### Task 9: Narrow/wide integration tests through `App`

**Files:**
- Create: `tests/components/sidepanel-shell.test.tsx`

**Interfaces:**
- Consumes: `App`, `menu-helpers`, `createFakeBookmarks`.

- [ ] **Step 1: Write the tests**

Create `tests/components/sidepanel-shell.test.tsx`:

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
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { putMeta } from "../../src/db/meta";
import { App } from "../../src/entrypoints/sidepanel/App";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";

/**
 * Side-panel shell: narrow (drawer) and wide (permanent column) hosts, the
 * chips + More menu and the Tools menu, all through the real `App`.
 * `matchMedia` is stubbed per test; without it `useIsWide` reports wide.
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
});

function stubViewport(wide: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: wide,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.consents.clear();
  await db.decisions.clear();
  const fake = createFakeBookmarks({
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
      },
      { id: "b3", title: "Gamma", url: "https://x.example/" },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
});

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

async function seedConsent(): Promise<void> {
  await db.consents.put({
    scope: DECISIONS_CONSENT_SCOPE,
    origin: "https://provider.example",
    consentVersion: CONSENT_VERSION,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("narrow shell", () => {
  it("hides the folder tree until the scope heading opens the drawer", async () => {
    stubViewport(false);
    await renderApp();
    expect(screen.queryByRole("treeitem")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    const drawer = await screen.findByRole("dialog", { name: "Browse" });
    expect(drawer).toBeTruthy();
    expect(await screen.findByRole("treeitem", { name: "Dev" })).toBeTruthy();
  });

  it("selecting a folder in the drawer closes it and retitles the scope", async () => {
    stubViewport(false);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: "Dev" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
    await waitFor(() => {
      const texts = screen
        .getAllByRole("option")
        .map((el) => el.textContent ?? "")
        .join("|");
      expect(texts).toContain("Alpha");
      expect(texts).not.toContain("Gamma");
    });
  });

  it("lists only non-empty categories, with counts, in the drawer", async () => {
    await putMeta("b1", { category: "docs" });
    await putMeta("b3", { category: "docs" });
    stubViewport(false);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    const docs = await screen.findByRole("button", { name: /^Docs/ });
    expect(docs.textContent).toContain("2");
    expect(screen.queryByRole("button", { name: /^Video/ })).toBeNull();
  });
});

describe("wide shell", () => {
  it("shows the permanent scope column and a plain scope heading", async () => {
    stubViewport(true);
    await renderApp();
    expect(await screen.findByRole("treeitem", { name: "Dev" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Browse" })).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "All bookmarks" });
    expect(heading.querySelector("button")).toBeNull();
  });
});

describe("Tools and More menus", () => {
  it("offers Set up AI and no Scan or Restructure without a provider", async () => {
    stubViewport(false);
    await renderApp();

    await openMenu("Tools");
    expect(screen.getByRole("menuitem", { name: "Set up AI…" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Scan library…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: "Duplicates" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Review/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Restructure" })).toBeNull();
  });

  it("offers Scan, Review and Restructure once a provider is connected", async () => {
    await seedConsent();
    stubViewport(false);
    await renderApp();

    await openMenu("Tools");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Scan library…" })).toBeTruthy(),
    );
    expect(screen.queryByRole("menuitem", { name: "Set up AI…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: /Review suggestions/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Restructure" })).toBeTruthy();
  });

  it("switches to Duplicates from More and relabels the chip", async () => {
    stubViewport(false);
    await renderApp();
    await openMenu(/^More/);
    await chooseMenuItem("Duplicates");
    expect(await screen.findByRole("heading", { name: "Duplicates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Duplicates/ })).toBeTruthy();
  });

  it("opens the Manage tags dialog from Tools", async () => {
    stubViewport(false);
    await renderApp();
    await openMenu("Tools");
    await chooseMenuItem("Manage tags…");
    expect(await screen.findByRole("heading", { name: "Manage tags" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run --project components tests/components/sidepanel-shell.test.tsx`
Expected: PASS (8 tests). If `createFakeBookmarks` rejects the option shape, mirror the call in `tests/components/sidepanel-layout.test.tsx` (`bookmarksBar` / `otherBookmarks` arrays of `{ id, title, url | children }`). If `db.decisions` is not a table name, use `db.decisions` as in `review-view.test.tsx` (`db.decisions.bulkPut`), which exists.

- [ ] **Step 3: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: clean.

```bash
git add tests/components/sidepanel-shell.test.tsx
git commit -m "test(sidepanel): cover narrow drawer, wide column, Tools and More menus"
```

---

### Task 10: Update the e2e helpers and specs

The Playwright suite has known assertion drift (`BookmarksManager-gyx`), so this task updates the selectors this change moves and verifies what can be verified, without trying to fix unrelated drift.

**Files:**
- Modify: `tests/e2e/helpers/surfaces.ts`
- Modify: `tests/e2e/shell.spec.ts`
- Modify: `tests/e2e/decisions.spec.ts`

**Interfaces:**
- Produces (exact):
  ```ts
  export async function chooseTool(page: Page, name: string): Promise<void>
  export async function openMoreView(page: Page, name: string): Promise<void>
  ```

- [ ] **Step 1: Add the helpers and route Import/Export through Tools**

In `tests/e2e/helpers/surfaces.ts`, add after `waitForSidePanelReady`:

```ts
/** Choose one entry of the side panel's Tools (⋯) menu. */
export async function chooseTool(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("menuitem", { name }).click();
}

/** Open the view chips' More menu and switch to one of its views. */
export async function openMoreView(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /^More/ }).click();
  await page.getByRole("menuitem", { name }).click();
}
```

Replace the click in `openImportDialog`

```ts
  await page.getByRole("button", { name: "Import…" }).click();
```

with

```ts
  await chooseTool(page, "Import…");
```

and the click in `openExportDialog`

```ts
  await page.getByRole("button", { name: "Export…" }).click();
```

with

```ts
  await chooseTool(page, "Export…");
```

`waitForSidePanelReady` needs no change: the `Bookmarks Manager` heading is now the screen-reader-only `<h1>`, and the tree item is present because a Playwright page defaults to a 1280 px viewport (wide mode).

- [ ] **Step 2: Update `shell.spec.ts`**

In `tests/e2e/shell.spec.ts`, replace

```ts
    await expect(
      sidepanel.getByRole("button", { name: "Review suggestions" }),
    ).toBeVisible();
```

with

```ts
    await expect(
      sidepanel.getByRole("button", { name: "Tools" }),
    ).toBeVisible();
```

- [ ] **Step 3: Update `decisions.spec.ts`**

In `tests/e2e/decisions.spec.ts`, add `chooseTool, openMoreView` to the import from `./helpers/surfaces` (add an import line if none exists). Replace line 85

```ts
  await sidepanel.getByRole("button", { name: "Scan library…" }).click();
```

with

```ts
  await chooseTool(sidepanel, "Scan library…");
```

Then open the statement that currently ends at line 190 (`.getByRole("button", { name: "Review suggestions" })` followed by `.click()`) and replace the whole `sidepanel …click();` statement with:

```ts
  await openMoreView(sidepanel, "Review suggestions");
```

Both flows configure and consent to a provider earlier in the spec, so Scan library and Review are visible.

- [ ] **Step 4: Typecheck and run what the environment supports**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run build && xvfb-run -a npx playwright test tests/e2e/shell.spec.ts tests/e2e/core-manager.spec.ts`
Expected: specs that fail only from the known drift (`BookmarksManager-gyx`) may still fail. Read each failure message and confirm none involves the moved controls (Tools, More, the `Bookmarks Manager` heading, tree items). If one does, fix that selector.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/helpers/surfaces.ts tests/e2e/shell.spec.ts tests/e2e/decisions.spec.ts
git commit -m "test(e2e): reach Import, Export, Scan and Review through the new menus"
```

---

### Task 11: Final verification, screenshots and store asset

**Files:**
- Modify: `store/assets/screenshot-manager-1280x800.png` (regenerated)

- [ ] **Step 1: Run every gate**

Run: `npm run lint && npm run typecheck && npm run build && npm run check:manifest && npm run check:bundle && npm run check:site`
Expected: all clean.

Run: `npx vitest run --project unit`
Expected: PASS.

Run: `npx vitest run --project components`
Expected: PASS apart from the known-flaky timing tests listed under Global Constraints; re-run any failing file alone.

- [ ] **Step 2: Update the capture script for the new controls and capture**

`/tmp/capture/capture.mjs` clicks `Import…`, `Export…`, `Manage tags…`, `Scan library…` as buttons, and view names as buttons. Change the dialogs loop so each item is chosen through the Tools menu:

```js
const dialogs = [["Import…", "import"], ["Export…", "export"], ["Manage tags…", "tags"]];
for (const [label, key] of dialogs) {
  try {
    await seedPage.getByRole("button", { name: "Tools" }).click({ timeout: 2000 });
    await seedPage.getByRole("menuitem", { name: label }).click({ timeout: 2000 });
    await shot(seedPage, `sidepanel-480-dialog-${key}`);
    await seedPage.keyboard.press("Escape");
    await seedPage.waitForTimeout(300);
  } catch (e) { console.log("skip", label, e.message.split("\n")[0]); }
}
```

and in the views loop, open the More menu for `Duplicates` (`getByRole("button", { name: /^More/ })` then `getByRole("menuitem", { name: v })`). Also add a drawer capture after `sidepanel-480`: click the button named `All bookmarks` and `await shot(seedPage, "sidepanel-480-drawer")`, then press Escape.

Run: `cd /home/ubuntu/Documents/project/BookmarksManager && npm run build && cd /tmp/capture && OUT=/tmp/capture/after-shell node capture.mjs`

Read `sidepanel-360.png`, `sidepanel-480.png`, `sidepanel-480-drawer.png`, `sidepanel-1280.png`, `sidepanel-480-view-duplicates.png` from `/tmp/capture/after-shell/`. Check against the spec:
- 360 and 480 px: single column; search plus Tools plus Settings on one row; the chips fit; the scope heading, item count and List/Grid share a line; titles and URLs are no longer truncated to a few characters.
- The Duplicates rows use the full width.
- 1280 px: a 224 px scope column with folders and the list beside it.
- Drawer: a left sheet with Browse, folders, tags and categories.
- Teal accent and Geist throughout.

Report any visual defect (wrapping chips, clipped toggle, overlapping controls) and fix it before continuing.

- [ ] **Step 3: Regenerate the store screenshot**

Run: `cd /home/ubuntu/Documents/project/BookmarksManager && UPDATE_STORE_ASSETS=1 xvfb-run -a npx playwright test tests/e2e/store-assets.spec.ts`
Expected: 1 passed. Read `store/assets/screenshot-manager-1280x800.png` and confirm it shows the wide layout with the new theme, only synthetic `*.example` content, and no personal data.

Run: `npm run check:store`
Expected: passes (or fails only on the pre-existing pending account steps noted in the README; confirm the failure is not about the screenshot).

- [ ] **Step 4: Commit the asset**

```bash
git add store/assets/screenshot-manager-1280x800.png
git commit -m "chore(store): regenerate the manager screenshot for the new shell"
```

- [ ] **Step 5: Report**

Summarise for the user: the commits made (`git log --oneline -12`), the gates run and their results, which known-flaky tests were seen, the screenshot comparison result, and the proposed next sub-project (side panel content: rows, Duplicates layout, empty states). Do not push.
