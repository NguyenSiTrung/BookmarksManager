import { useState } from "react";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { FlattenedTree } from "../../sync/tree";
import { usePersistedMap } from "./session-state";

/**
 * Expand/collapse state for the side panel's folder tree.
 *
 * State is a `Map<id, boolean>` of *overrides*: Chrome's fixed roots default
 * to expanded, every other folder to collapsed, and an entry only exists once
 * the user (or a reveal) changed that folder. Overrides rather than a Set of
 * open ids so the defaults still apply after the tree loads asynchronously.
 *
 * Two behaviours live here beyond plain local state:
 *
 *  - **Reveal.** When `selectedFolderId` changes (command palette, search
 *    hit, the popup's "Edit that bookmark" handoff, …) every ancestor is
 *    expanded so the selected row is rendered. It runs on a selection
 *    *change* only — afterwards the user can collapse an ancestor and it
 *    stays collapsed.
 *  - **Session persistence** via `usePersistedMap` (see `./session-state`).
 *    Ids that are no longer in the tree are pruned on write; an empty tree
 *    means "not loaded yet", so nothing is pruned then.
 */

/** `chrome.storage.session` key holding the persisted overrides. */
export const FOLDER_EXPANSION_KEY = "bookmarksManager:folderExpansion";

export type ExpansionOverrides = ReadonlyMap<string, boolean>;

/**
 * `overrides` with every collapsed ancestor of `folderId` set to expanded.
 * Returns `overrides` itself (same reference) when nothing needs to open, so
 * callers can skip a state update.
 */
export function revealFolder(
  tree: FlattenedTree,
  folderId: string,
  overrides: ExpansionOverrides,
): ExpansionOverrides {
  let next: Map<string, boolean> | null = null;
  const seen = new Set<string>([folderId]);
  let parentId = tree.folders.get(folderId)?.parentId;
  while (parentId !== undefined && parentId !== ROOT_NODE_ID) {
    // A cyclic parent chain (corrupt model) must not spin.
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = tree.folders.get(parentId);
    if (parent === undefined) break;
    if (((next ?? overrides).get(parentId) ?? parent.isRoot) !== true) {
      next ??= new Map(overrides);
      next.set(parentId, true);
    }
    parentId = parent.parentId;
  }
  return next ?? overrides;
}

export interface FolderExpansion {
  overrides: ExpansionOverrides;
  setExpanded(id: string, expanded: boolean): void;
  /**
   * The selected folder whose ancestors were last revealed — the row the
   * caller should scroll into view once it renders. `undefined` while no
   * folder is selected (or the selection is not in the tree yet).
   */
  revealedFor: string | undefined;
}

export function useFolderExpansion(
  tree: FlattenedTree,
  selectedFolderId: string | undefined,
): FolderExpansion {
  const [overrides, setOverrides] = usePersistedMap(
    FOLDER_EXPANSION_KEY,
    (id) => tree.folders.size === 0 || tree.folders.has(id),
  );
  const [revealedFor, setRevealedFor] = useState<string | undefined>(undefined);

  // Reveal on selection change. Derived during render (React's "adjust state
  // when a prop changes" pattern) so the first paint already shows the row.
  // A selection missing from the tree is retried when the tree changes.
  if (
    selectedFolderId !== revealedFor &&
    (selectedFolderId === undefined || tree.folders.has(selectedFolderId))
  ) {
    setRevealedFor(selectedFolderId);
    if (selectedFolderId !== undefined) {
      const next = revealFolder(tree, selectedFolderId, overrides);
      if (next !== overrides) setOverrides(next);
    }
  }

  const setExpanded = (id: string, expanded: boolean): void => {
    setOverrides((current) => {
      if (current.get(id) === expanded) return current;
      const next = new Map(current);
      next.set(id, expanded);
      return next;
    });
  };

  return { overrides, setExpanded, revealedFor };
}
