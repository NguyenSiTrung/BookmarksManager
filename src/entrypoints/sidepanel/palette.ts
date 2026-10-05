import { Category } from "../../schemas/bookmark";
import type { TagDef } from "../../schemas/meta";
import { isOpenableUrl } from "../../search/openable";
import { runQuery } from "../../search/run";
import type { SearchIndexHandle } from "../../search/run";
import type { FlattenedTree } from "../../sync/tree";
import type { SidePanelView } from "./views";

/**
 * Command-palette item generation (spec §5). Pure — no `chrome`, DOM, React,
 * or Dexie — so it is unit-tested directly and reused if other surfaces ever
 * want the same item model.
 *
 * Sections, in display order:
 *  1. Bookmarks — `runQuery` hits over the live index (omitted when the
 *     query is blank, the index is still building, or nothing matched).
 *  2. Views — the four fixed destinations (All, Recently saved, Untagged,
 *     Duplicates).
 *  3. Folders — every non-root folder; the label is the title and the
 *     detail is its `path` breadcrumb.
 *  4. Tags — tag definitions by display name.
 *  5. Categories — the fixed Category enum.
 *
 * A non-empty query also NARROWS the jump sections by case-insensitive
 * substring on the label; empty sections drop out. Commands (Import,
 * Export, …) are added by Phase 2 Task 5 as a final section.
 *
 * Every item's `view` (jump) or `id`/`url` (bookmark) is resolved HERE so
 * the component layer only renders and dispatches — no lookup work in JSX.
 */
/** Commands the palette can dispatch into the panel's existing flows. */
export type PaletteCommand =
  | "import"
  | "export"
  | "tag-manager"
  | "new-folder"
  | "undo"
  | "options";

export type PaletteItem =
  | {
      kind: "bookmark";
      /** Bookmark node id — used to reveal/open the live BookmarkItem. */
      id: string;
      label: string;
      detail: string;
      url: string;
      /**
       * `isOpenableUrl(url)` — `false` for non-allowlisted schemes,
       * which keep Reveal/Edit/Copy but no Open actions.
       */
      openable: boolean;
    }
  | {
      kind: "jump";
      label: string;
      detail: string;
      /** The side-panel view activating this item selects. */
      view: SidePanelView;
    }
  | {
      kind: "command";
      label: string;
      detail: string;
      command: PaletteCommand;
    };

export interface PaletteSection {
  id: string;
  label: string;
  items: PaletteItem[];
}

export interface PaletteSources {
  query: string;
  /** Live index from `useSearchIndex`; `null` while it builds. */
  search: SearchIndexHandle | null;
  tree: FlattenedTree;
  tagDefs: readonly TagDef[];
}

const FIXED_VIEWS: readonly { label: string; view: SidePanelView }[] = [
  { label: "All bookmarks", view: { kind: "all" } },
  { label: "Recently saved", view: { kind: "recent" } },
  { label: "Untagged", view: { kind: "untagged" } },
  { label: "Duplicates", view: { kind: "duplicates" } },
];

/** Fixed commands, always appended as the last section (spec §5). */
const COMMANDS: readonly { label: string; command: PaletteCommand }[] = [
  { label: "Import bookmarks…", command: "import" },
  { label: "Export bookmarks…", command: "export" },
  { label: "Manage tags…", command: "tag-manager" },
  { label: "New folder…", command: "new-folder" },
  { label: "Undo last action", command: "undo" },
  { label: "Open options", command: "options" },
];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Case-insensitive substring test used to narrow jump sections. */
function matches(query: string, label: string): boolean {
  return label.toLowerCase().includes(query);
}

/** Sections for `sources`; empty sections are omitted. Never throws. */
export function buildPaletteSections({
  query,
  search,
  tree,
  tagDefs,
}: PaletteSources): PaletteSection[] {
  const needle = query.trim().toLowerCase();
  const sections: PaletteSection[] = [];

  if (needle !== "" && search !== null) {
    let items: PaletteItem[] = [];
    try {
      items = runQuery(search.index, query, search.ctx).hits.map((hit) => ({
        kind: "bookmark",
        id: String(hit.id),
        label: hit.title === "" ? hit.url : hit.title,
        detail: hit.folderTitles.join(" › "),
        url: hit.url,
        openable: isOpenableUrl(hit.url),
      }));
    } catch {
      // runQuery is total by contract; belt-and-suspenders keeps the
      // palette alive even if that contract regresses.
      items = [];
    }
    if (items.length > 0) {
      sections.push({ id: "bookmarks", label: "Bookmarks", items });
    }
  }

  const jumpSection = (
    id: string,
    label: string,
    all: readonly { label: string; detail?: string; view: SidePanelView }[],
  ): void => {
    const items: PaletteItem[] = all
      .filter((entry) => needle === "" || matches(needle, entry.label))
      .map((entry) => ({
        kind: "jump",
        label: entry.label,
        detail: entry.detail ?? "",
        view: entry.view,
      }));
    if (items.length > 0) sections.push({ id, label, items });
  };

  jumpSection("views", "Views", FIXED_VIEWS);
  jumpSection(
    "folders",
    "Folders",
    [...tree.folders.values()]
      // Chrome's fixed roots ("Bookmarks bar" etc.) are real folders worth
      // jumping to; only the synthetic root "0" has an empty title.
      .filter((folder) => folder.title !== "")
      .map((folder) => ({
        label: folder.title,
        detail: folder.path.join(" › "),
        view: { kind: "folder", folderId: folder.id } as SidePanelView,
      })),
  );
  jumpSection(
    "tags",
    "Tags",
    tagDefs.map((tag) => ({
      label: tag.name,
      view: { kind: "tag", nameKey: tag.nameKey } as SidePanelView,
    })),
  );
  jumpSection(
    "categories",
    "Categories",
    Category.options.map((category) => ({
      label: capitalize(category),
      view: { kind: "category", category } as SidePanelView,
    })),
  );

  const commandItems: PaletteItem[] = COMMANDS.filter((entry) =>
    matches(needle, entry.label),
  ).map((entry) => ({
    kind: "command",
    label: entry.label,
    detail: "",
    command: entry.command,
  }));
  if (commandItems.length > 0) {
    sections.push({ id: "commands", label: "Commands", items: commandItems });
  }

  return sections;
}

/** Flat item list in display order — the unit arrow keys walk. */
export function flattenPaletteSections(
  sections: readonly PaletteSection[],
): PaletteItem[] {
  return sections.flatMap((section) => section.items);
}
