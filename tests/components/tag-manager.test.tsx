import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import {
  createTag,
  getMeta,
  getTag,
  listTags,
  putMeta,
} from "../../src/db/meta";
import { Category } from "../../src/schemas/bookmark";
import { CategorySelect } from "../../src/ui/components/category-select";
import { TagChip } from "../../src/ui/components/tag-chip";
import { TagManager } from "../../src/entrypoints/sidepanel/TagManager";
import type { TagManagerUndoInfo } from "../../src/entrypoints/sidepanel/TagManager";

/**
 * Phase 4 Task 5 — tag manager, tag chips, category select.
 *
 * Layers under test:
 *  - `TagChip`        pill: color dot (def color or neutral), accessible
 *                     label, optional × remove button, `sm` row variant.
 *  - `CategorySelect` controlled select over the 9 Category values + None
 *                     (None emits `null` — MetaPatch clear semantics).
 *  - `TagManager`     dialog over the `tags`/`bookmarkMeta` Dexie tables:
 *                     create (typed conflicts), rename (propagation +
 *                     affected count), recolor palette + clear, description
 *                     editor (≤300 live counter, hard-block over limit),
 *                     delete confirm showing the `getMetaByTag` count, then
 *                     `deleteTagWithUndo` → `onRequestUndo` seam.
 *
 * IndexedDB is fake-indexeddb; no chrome surface is needed (tag ops never
 * touch the bookmarks tree).
 */
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** Row (`<li>`) containing a tag name inside the manager list. */
function tagRow(name: string): HTMLElement {
  const el = screen.getByText(name).closest("li");
  if (el === null) throw new Error(`no row for ${name}`);
  return el;
}

// ---------------------------------------------------------------------------
// TagChip
// ---------------------------------------------------------------------------

describe("TagChip", () => {
  it("renders the name with a colored dot", () => {
    render(<TagChip name="Reading List" color="#3b82f6" />);
    const chip = screen.getByRole("group", { name: "Reading List" });
    expect(chip).toBeTruthy();
    const dot = chip.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dot.style.backgroundColor).toMatch(/59, 130, 246|#3b82f6/i);
  });

  it("renders a neutral dot when no color is set", () => {
    render(<TagChip name="plain" />);
    const chip = screen.getByRole("group", { name: "plain" });
    const dot = chip.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dot.style.backgroundColor).toBe("");
    expect(dot.className).toContain("bg-muted-foreground");
  });

  it("renders an accessible remove button only when onRemove is set", () => {
    const onRemove = vi.fn();
    const { rerender } = render(<TagChip name="ops" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove tag ops" }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    rerender(<TagChip name="ops" />);
    expect(
      screen.queryByRole("button", { name: "Remove tag ops" }),
    ).toBeNull();
  });

  it("supports the small size variant used inside bookmark rows", () => {
    render(<TagChip name="sm" size="sm" />);
    const chip = screen.getByRole("group", { name: "sm" });
    expect(chip.dataset.size).toBe("sm");
  });

  it("renders multiple chips inside a dense list row", () => {
    render(
      <div role="option" aria-selected="false">
        <TagChip size="sm" name="one" color="#ef4444" />
        <TagChip size="sm" name="two" />
      </div>,
    );
    const option = screen.getByRole("option");
    expect(within(option).getByRole("group", { name: "one" })).toBeTruthy();
    expect(within(option).getByRole("group", { name: "two" })).toBeTruthy();
    expect(option.textContent).toContain("one");
    expect(option.textContent).toContain("two");
  });
});

// ---------------------------------------------------------------------------
// CategorySelect
// ---------------------------------------------------------------------------

describe("CategorySelect", () => {
  it("lists the categories humanized plus None", () => {
    render(<CategorySelect value="docs" onChange={() => {}} />);
    const select = screen.getByRole("combobox", {
      name: "Category",
    }) as HTMLSelectElement;
    const labels = Array.from(select.options).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual([
      "None",
      "Article",
      "Paper",
      "Course",
      "Docs",
      "Tool",
      "Video",
      "Repo",
      "Reference",
      "Shopping",
      "Social",
      "Other",
    ]);
    expect(select.value).toBe("docs");
    // One option per enum value + the clear option.
    expect(select.options.length).toBe(Category.options.length + 1);
  });

  it("emits the Category for choices and null for None (clear)", () => {
    const onChange = vi.fn();
    render(<CategorySelect value={undefined} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Category" });
    fireEvent.change(select, { target: { value: "video" } });
    expect(onChange).toHaveBeenLastCalledWith("video");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("is controlled — the select reflects the value prop", () => {
    const { rerender } = render(
      <CategorySelect value="article" onChange={() => {}} />,
    );
    expect(
      (screen.getByRole("combobox") as HTMLSelectElement).value,
    ).toBe("article");
    rerender(<CategorySelect value="repo" onChange={() => {}} />);
    expect(
      (screen.getByRole("combobox") as HTMLSelectElement).value,
    ).toBe("repo");
    rerender(<CategorySelect value={null} onChange={() => {}} />);
    expect(
      (screen.getByRole("combobox") as HTMLSelectElement).value,
    ).toBe("");
  });

  it("renders a bound visible label when provided", () => {
    render(
      <CategorySelect label="Set category" value="tool" onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Set category")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TagManager — list + search
// ---------------------------------------------------------------------------

describe("TagManager", () => {
  it("lists tag defs with color chips and bookmark counts", async () => {
    await createTag("Reading List", { color: "#3b82f6" });
    await createTag("Ops");
    await putMeta("bm-a", { tags: ["reading list"] });
    await putMeta("bm-b", { tags: ["reading list", "ops"] });
    await putMeta("bm-c", { tags: ["other"] });
    render(<TagManager open />);

    await screen.findByText("Reading List");
    expect(within(tagRow("Reading List")).getByText("2 bookmarks")).toBeTruthy();
    expect(within(tagRow("Ops")).getByText("1 bookmark")).toBeTruthy();
    // Both defs render as chips.
    expect(
      screen.getByRole("group", { name: "Reading List" }),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Ops" })).toBeTruthy();
  });

  it("filters the list via the search box", async () => {
    await createTag("Alpha");
    await createTag("Beta");
    render(<TagManager open />);
    await screen.findByText("Alpha");

    fireEvent.change(screen.getByLabelText("Filter tags"), {
      target: { value: "bet" },
    });
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("shows an empty state when no tags exist", async () => {
    render(<TagManager open />);
    await screen.findByText("No tags yet.");
  });

  it("runs no live queries while closed, then queries on open (U11)", async () => {
    await createTag("Idle");
    const tagsSpy = vi.spyOn(db.tags, "toArray");
    const metaSpy = vi.spyOn(db.bookmarkMeta, "toArray");

    const view = render(<TagManager open={false} />);
    // Flush any would-be query microtasks before asserting silence.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(metaSpy).not.toHaveBeenCalled();

    // A write while closed fires no scan either — nothing is subscribed.
    await putMeta("bm-offscreen", { tags: ["idle"] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tagsSpy).not.toHaveBeenCalled();
    expect(metaSpy).not.toHaveBeenCalled();

    // Opening mounts the queries and lists the tag.
    view.rerender(<TagManager open />);
    await screen.findByText("Idle");
    expect(tagsSpy).toHaveBeenCalled();
    expect(metaSpy).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  it("creates a tag via the new-tag input and reports it", async () => {
    render(<TagManager open />);
    await screen.findByRole("dialog");

    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "Fresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));

    await screen.findByText("Fresh");
    expect((await getTag("fresh"))?.name).toBe("Fresh");
    expect(await listTags()).toHaveLength(1);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain('Created "Fresh"');
  });

  it("shows the typed tag_exists error on a case-insensitive duplicate", async () => {
    await createTag("Reading List");
    render(<TagManager open />);
    await screen.findByText("Reading List");

    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "  READING LIST " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("tag_exists");
    expect(await listTags()).toHaveLength(1);
  });

  it("shows the typed invalid_tag error on a blank new-tag name", async () => {
    render(<TagManager open />);
    await screen.findByRole("dialog");

    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("invalid_tag");
    expect(await listTags()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  it("renames a tag inline, propagates the nameKey, and reports the count", async () => {
    await createTag("Reading List");
    await putMeta("bm-a", { tags: ["reading list", "other"] });
    await putMeta("bm-b", { tags: ["reading list"] });
    render(<TagManager open />);
    await screen.findByText("Reading List");

    fireEvent.click(
      screen.getByRole("button", { name: "Rename Reading List" }),
    );
    fireEvent.change(
      screen.getByLabelText("New name for Reading List"),
      { target: { value: "Articles" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Articles");
    expect((await getTag("articles"))?.name).toBe("Articles");
    expect(await getTag("reading list")).toBeUndefined();
    expect((await getMeta("bm-a"))?.tags).toEqual(["articles", "other"]);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Articles");
    expect(status.textContent).toContain("2 bookmarks");
  });

  it("shows tag_exists when a rename collides with another tag", async () => {
    await createTag("Alpha");
    await createTag("Beta");
    await putMeta("bm-a", { tags: ["alpha"] });
    render(<TagManager open />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Rename Alpha" }));
    fireEvent.change(screen.getByLabelText("New name for Alpha"), {
      target: { value: "BETA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("tag_exists");
    expect((await getTag("alpha"))?.name).toBe("Alpha");
    expect((await getMeta("bm-a"))?.tags).toEqual(["alpha"]);
  });

  // -------------------------------------------------------------------------
  // recolor
  // -------------------------------------------------------------------------

  it("recolors a tag from the preset palette and clears the color", async () => {
    await createTag("Tint", { color: "#3b82f6" });
    render(<TagManager open />);
    await screen.findByText("Tint");

    fireEvent.click(screen.getByRole("button", { name: "Recolor Tint" }));
    fireEvent.click(screen.getByRole("button", { name: "red" }));

    await waitFor(async () => {
      expect((await getTag("tint"))?.color).toBe("#ef4444");
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Tint");

    fireEvent.click(
      await screen.findByRole("button", { name: "Recolor Tint" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear color" }));
    await waitFor(async () => {
      expect((await getTag("tint"))?.color).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // description
  // -------------------------------------------------------------------------

  it("edits the description with a live counter", async () => {
    await createTag("Doc Tag", { description: "first" });
    render(<TagManager open />);
    await screen.findByText("Doc Tag");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit description of Doc Tag" }),
    );
    const textarea = screen.getByLabelText(
      "Description for Doc Tag",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("first");
    expect(screen.getByText("5/300")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "shorter" } });
    expect(screen.getByText("7/300")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect((await getTag("doc tag"))?.description).toBe("shorter");
    });
  });

  it("hard-blocks saving a description over 300 characters", async () => {
    await createTag("Doc Tag");
    render(<TagManager open />);
    await screen.findByText("Doc Tag");

    fireEvent.click(
      screen.getByRole("button", { name: "Edit description of Doc Tag" }),
    );
    const textarea = screen.getByLabelText(
      "Description for Doc Tag",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x".repeat(301) } });

    expect(screen.getByText("301/300")).toBeTruthy();
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Even if it were clickable, the handler must refuse the write.
    fireEvent.click(save);
    expect((await getTag("doc tag"))?.description).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // delete + undo seam
  // -------------------------------------------------------------------------

  it("confirms delete with the affected count, then fires onRequestUndo", async () => {
    await createTag("Doomed");
    await putMeta("bm-a", { tags: ["doomed", "keep"] });
    await putMeta("bm-b", { tags: ["doomed"] });
    const onRequestUndo = vi.fn();
    render(<TagManager open onRequestUndo={onRequestUndo} />);
    await screen.findByText("Doomed");

    fireEvent.click(screen.getByRole("button", { name: "Delete Doomed" }));
    // The confirm step surfaces the getMetaByTag count BEFORE deleting.
    await screen.findByText(/removed from 2 bookmarks/i);

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Doomed");
    expect(status.textContent).toContain("2 bookmarks");

    expect(onRequestUndo).toHaveBeenCalledTimes(1);
    const info = onRequestUndo.mock.calls[0]?.[0] as TagManagerUndoInfo;
    expect(info.affected).toBe(2);
    expect(typeof info.snapshotId).toBe("number");
    expect(info.tag.name).toBe("Doomed");

    expect(await getTag("doomed")).toBeUndefined();
    expect((await getMeta("bm-a"))?.tags).toEqual(["keep"]);
    await waitFor(() => expect(screen.queryByText("Doomed")).toBeNull());
  });

  it("still deletes when onRequestUndo is absent (no-op seam)", async () => {
    await createTag("Solo");
    render(<TagManager open />);
    await screen.findByText("Solo");

    fireEvent.click(screen.getByRole("button", { name: "Delete Solo" }));
    await screen.findByText(/removed from 0 bookmarks/i);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(async () => {
      expect(await getTag("solo")).toBeUndefined();
    });
  });
});
