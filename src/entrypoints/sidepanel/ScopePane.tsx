import { useId } from "react";
import type { ReactElement, ReactNode } from "react";
import type { TagDef } from "../../schemas/meta";
import type { FlattenedTree, FolderNode } from "../../sync/tree";
import { FolderTree } from "./FolderTree";
import type { CategoryCount } from "./scope";
import { useScopeSections } from "./scope-sections";
import type { ScopeSection } from "./scope-sections";
import type { SidePanelView } from "./views";

/**
 * The "where am I looking" content: folder tree, tags, categories. It is
 * host-agnostic — the shell renders it in the permanent left column when the
 * panel is wide and inside the scope drawer when it is narrow. Each section
 * collapses from its heading (state: `./scope-sections`).
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

const HEADING_BUTTON_CLASS =
  "flex w-full items-center gap-1 rounded-sm px-2 text-xs font-medium " +
  "text-muted-foreground outline-hidden hover:text-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

interface SectionProps {
  title: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}

/**
 * A scope section whose heading toggles it. The content is `hidden`, not
 * unmounted, so the folder tree keeps its focus and drag state while
 * collapsed.
 */
function Section({ title, open, onToggle, children }: SectionProps) {
  const contentId = useId();
  return (
    <section aria-label={title}>
      <h3 className="pb-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={onToggle}
          className={HEADING_BUTTON_CLASS}
        >
          <span aria-hidden="true" className="w-3 shrink-0 text-center">
            {open ? "▾" : "▸"}
          </span>
          {title}
        </button>
      </h3>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
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
  const sections = useScopeSections(view);
  const sectionProps = (section: ScopeSection, title: string) => ({
    title,
    open: sections.isOpen(section),
    onToggle: () => sections.toggle(section),
  });

  return (
    <div className="space-y-4">
      <Section {...sectionProps("folders", "Folders")}>
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
      </Section>
      {tagDefs.length > 0 && (
        <Section {...sectionProps("tags", "Tags")}>
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
        </Section>
      )}
      {categories.length > 0 && (
        <Section {...sectionProps("categories", "Categories")}>
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
        </Section>
      )}
    </div>
  );
}
