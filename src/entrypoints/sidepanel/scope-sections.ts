import { useState } from "react";
import { usePersistedMap } from "./session-state";
import type { SidePanelView } from "./views";

/**
 * Collapse state for the scope column's three sections (Folders, Tags,
 * Categories). All start open; only collapsed sections are stored, and the
 * state persists in `chrome.storage.session` (see `./session-state`) so it
 * survives closing the panel and reopening the narrow-mode drawer.
 *
 * Like the folder tree's reveal, a selection that arrives from outside (the
 * command palette, a search hit) opens its section — once per selection
 * change, so the user can collapse it again afterwards.
 */

export type ScopeSection = "folders" | "tags" | "categories";

/** `chrome.storage.session` key holding `section → collapsed`. */
export const SCOPE_SECTIONS_KEY = "bookmarksManager:scopeSections";

/** The section a view lives in, with an id unique to the selection. */
function selectionOf(
  view: SidePanelView,
): { section: ScopeSection; id: string } | undefined {
  switch (view.kind) {
    case "folder":
      return { section: "folders", id: `folders:${view.folderId}` };
    case "tag":
      return { section: "tags", id: `tags:${view.nameKey}` };
    case "category":
      return { section: "categories", id: `categories:${view.category}` };
    default:
      return undefined;
  }
}

export interface ScopeSections {
  isOpen(section: ScopeSection): boolean;
  toggle(section: ScopeSection): void;
}

export function useScopeSections(view: SidePanelView): ScopeSections {
  const [collapsed, setCollapsed] = usePersistedMap(SCOPE_SECTIONS_KEY);
  const [revealedId, setRevealedId] = useState<string | undefined>(undefined);

  // Derived during render (React's "adjust state when a prop changes"
  // pattern) so the selected row is on the first paint.
  const selection = selectionOf(view);
  if (selection?.id !== revealedId) {
    setRevealedId(selection?.id);
    if (selection !== undefined && collapsed.get(selection.section) === true) {
      setCollapsed((current) => new Map(current).set(selection.section, false));
    }
  }

  return {
    isOpen: (section) => collapsed.get(section) !== true,
    toggle: (section) =>
      setCollapsed((current) =>
        new Map(current).set(section, current.get(section) !== true),
      ),
  };
}
