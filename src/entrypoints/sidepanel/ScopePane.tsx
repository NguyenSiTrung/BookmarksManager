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
