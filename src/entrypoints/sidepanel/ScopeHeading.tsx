import type { ReactElement, ReactNode } from "react";
import { ChevronDownIcon, FolderIcon } from "../../ui/components/icons";
import { useDndState } from "./dnd";
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
  const { dragging } = useDndState();
  return (
    <h2 className="min-w-0 flex-1 text-sm font-medium">
      {drawer === undefined ? (
        <span className="block truncate">{title}</span>
      ) : (
        <ScopeDrawer
          open={drawer.open}
          onOpenChange={drawer.onOpenChange}
          trigger={
            <button
              type="button"
              data-testid="scope-drawer-trigger"
              onPointerEnter={() => {
                if (dragging && !drawer.open) drawer.onOpenChange(true);
              }}
              onDragEnter={() => {
                if (!drawer.open) drawer.onOpenChange(true);
              }}
              className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border/80 bg-card px-2 py-1 text-xs font-medium shadow-2xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
