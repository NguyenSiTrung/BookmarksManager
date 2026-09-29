import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { getMetaByIds } from "../../db/meta";
import type { DuplicateGroup, DuplicateGroupKind } from "../../duplicates/group";
import { mergeGroup } from "../../duplicates/merge";
import type { MergeSuccess } from "../../duplicates/merge";
import type { Category } from "../../schemas/bookmark";
import type { BookmarkMeta } from "../../schemas/meta";
import type { BookmarkItem } from "../../sync/tree";
import { ExternalLinkIcon } from "../../ui/components/icons";
import { Favicon } from "../../ui/components/favicon";
import { cn } from "../../ui/lib/cn";
import { undoLatest } from "../../undo/restore";
import { displayDomain, folderLabel, formatAdded } from "./row-text";

/**
 * Grouped duplicates view (spec §6): each `DuplicateGroup<BookmarkItem>`
 * from `resolveDuplicateGroups` renders as a card — kind badge ("Exact"
 * solid vs "Normalized" outline), member count, and the shared key — and
 * every member row carries favicon, title, url, folder path, and its
 * existing tags/category/notes so the user can pick the copy to keep.
 *
 * Merge flow per group: "Keep this one" marks the keeper and flags the
 * other members "will be removed" → an inline confirm panel names the
 * keeper, counts the removals, and previews the merged-meta consequences
 * (kept-first tag union, notes-combine count, winning category — fetched
 * live via `getMetaByIds`, the same read `mergeGroup` performs) →
 * `mergeGroup` runs → a status banner reports the merged fields plus an
 * Undo affordance. Failures surface `code` + `message` in the card.
 *
 * Undo seam: `onRequestUndo` is the preferred path — the coordinator wires
 * it to App's UndoToast/`undoLatest`. When it is absent the banner's Undo
 * calls `undoLatest` directly and reports the outcome inline. A single
 * banner mirrors the global LIFO undo stack, so only the latest merge
 * offers it.
 *
 * Everything the view needs arrives as props — the component performs no
 * tree reads itself (only the preview's meta read + the merge/undo calls),
 * so it stays testable against the in-memory chrome.bookmarks fake.
 */

export interface DuplicatesViewProps {
  /** Grouped duplicates — `resolveDuplicateGroups(tree)` output. */
  groups: readonly DuplicateGroup<BookmarkItem>[];
  /** Meta rows keyed by bookmark id — member rows show tag/category chips. */
  metaById?: ReadonlyMap<string, BookmarkMeta>;
  /** Tag display names keyed by nameKey; falls back to the key. */
  tagNameByKey?: ReadonlyMap<string, string>;
  /** True while the bookmark tree is still loading. */
  loading?: boolean;
  /**
   * Undo seam — the coordinator wires this to App's toast + `undoLatest`.
   * When absent the banner calls `undoLatest` itself and reports inline.
   */
  onRequestUndo?: () => void;
  /** Fired once per successful merge (refresh counts, extra toasts). */
  onMerged?: (
    result: MergeSuccess,
    group: DuplicateGroup<BookmarkItem>,
  ) => void;
  /** Open-bookmark affordance; adds an "Open" button per member row. */
  onActivateItem?: (item: BookmarkItem) => void;
  /** Shown when there are no groups. Defaults to the plain "No duplicates" line. */
  empty?: ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// Merge preview — mirrors merge.ts's kept-first union, plus display extras
// ---------------------------------------------------------------------------

/** What the confirm panel previews about the merge's metadata effects. */
interface MergePreviewData {
  /** Unioned tag nameKeys, kept member first then group order, deduped. */
  tags: string[];
  /** How many members contribute a non-empty note to the join. */
  notesCount: number;
  /** The winning category: kept's own, else first found in group order. */
  category?: Category;
  /** Member whose category wins — lets the panel name the source. */
  categorySourceId?: string;
}

type ConfirmPreview =
  | { status: "loading" }
  | { status: "ready"; data: MergePreviewData }
  | { status: "error" };

/**
 * Compute the field set `mergeGroup` will write from pre-merge meta rows.
 * `rows` must already be ordered kept-first then group order — exactly the
 * `getMetaByIds([keepId, ...others])` read the merge itself performs.
 */
function buildMergePreview(
  rows: readonly BookmarkMeta[],
): MergePreviewData {
  const seen = new Set<string>();
  const tags: string[] = [];
  let notesCount = 0;
  let category: Category | undefined;
  let categorySourceId: string | undefined;
  for (const row of rows) {
    for (const tag of row.tags) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    if (row.notes !== undefined && row.notes !== "") {
      notesCount += 1;
    }
    if (category === undefined && row.category !== undefined) {
      category = row.category;
      categorySourceId = row.id;
    }
  }
  const data: MergePreviewData = { tags, notesCount };
  if (category !== undefined) data.category = category;
  if (categorySourceId !== undefined) data.categorySourceId = categorySourceId;
  return data;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stable card identity: kind+key is unique across emitted groups. */
function groupIdOf(group: DuplicateGroup<BookmarkItem>): string {
  return `${group.kind}:${group.key}`;
}

function displayTitle(item: BookmarkItem): string {
  return item.title === "" ? item.url : item.title;
}

function kindLabel(kind: DuplicateGroupKind): string {
  return kind === "exact" ? "Exact" : "Normalized";
}

/** Badge weight: Exact is the stronger signal (identical URLs). */
function badgeClass(kind: DuplicateGroupKind): string {
  return cn(
    "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
    kind === "exact"
      ? "bg-primary text-primary-foreground"
      : "border border-border bg-transparent text-muted-foreground",
  );
}

const secondaryButtonClass =
  "shrink-0 rounded-sm border border-border bg-background px-2 py-1 text-xs " +
  "outline-hidden hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const primaryButtonClass =
  "rounded-sm bg-primary px-2 py-1 text-xs text-primary-foreground " +
  "outline-hidden hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const chipClass =
  "rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground";

// ---------------------------------------------------------------------------
// Member row
// ---------------------------------------------------------------------------

type MemberKeepState = "idle" | "keeping" | "removing" | "removed";

interface MemberRowProps {
  item: BookmarkItem;
  meta?: BookmarkMeta;
  tagNameByKey?: ReadonlyMap<string, string>;
  /** The group header's title — a member repeating it is omitted. */
  groupTitle: string;
  keepState: MemberKeepState;
  merging: boolean;
  onKeep: () => void;
  onActivate?: (item: BookmarkItem) => void;
}

function MemberRow({
  item,
  meta,
  tagNameByKey,
  groupTitle,
  keepState,
  merging,
  onKeep,
  onActivate,
}: MemberRowProps) {
  const tags = meta?.tags ?? [];
  const folder = folderLabel(item.path);
  const primary = folder === "" ? displayTitle(item) : folder;
  const showTitle = folder !== "" && displayTitle(item) !== groupTitle;
  const added = formatAdded(item.dateAdded);
  return (
    <li
      data-testid="duplicate-member"
      data-bookmark-id={item.id}
      className={cn(
        "flex items-center gap-2 px-3 py-2",
        keepState === "keeping" && "bg-accent/40",
        (keepState === "removing" || keepState === "removed") && "opacity-60",
      )}
    >
      <Favicon pageUrl={item.url} size={16} className="shrink-0" />
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
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {tags.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {tags.length} {tags.length === 1 ? "tag" : "tags"}
          </span>
        )}
        {tags.map((nameKey) => (
          <span key={nameKey} data-tag={nameKey} className={chipClass}>
            {tagNameByKey?.get(nameKey) ?? nameKey}
          </span>
        ))}
        {meta?.category !== undefined && (
          <span data-category={meta.category} className={chipClass}>
            {meta.category}
          </span>
        )}
        {meta !== undefined &&
          meta.notes !== undefined &&
          meta.notes !== "" && (
            <span className="text-[10px] italic text-muted-foreground">
              has notes
            </span>
          )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {keepState === "idle" && (
          <button
            type="button"
            disabled={merging}
            onClick={onKeep}
            className={secondaryButtonClass}
          >
            Keep this one
          </button>
        )}
        {keepState === "keeping" && (
          <span className="rounded-sm bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
            Keeping
          </span>
        )}
        {keepState === "removing" && (
          <span className="text-xs italic text-muted-foreground">
            will be removed
          </span>
        )}
        {keepState === "removed" && (
          <span className="text-xs text-muted-foreground">Removed</span>
        )}
        {onActivate !== undefined && keepState === "idle" && (
          <button
            type="button"
            aria-label={`Open ${displayTitle(item)}`}
            title={item.url}
            onClick={() => onActivate(item)}
            className={cn(secondaryButtonClass, "px-1.5")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Inline confirm panel — merged-meta consequences from getMetaByIds
// ---------------------------------------------------------------------------

interface ConfirmPanelProps {
  group: DuplicateGroup<BookmarkItem>;
  keepId: string;
  preview: ConfirmPreview | null;
  merging: boolean;
  tagNameByKey?: ReadonlyMap<string, string>;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmPanel({
  group,
  keepId,
  preview,
  merging,
  tagNameByKey,
  onConfirm,
  onCancel,
}: ConfirmPanelProps) {
  const kept = group.items.find((item) => item.id === keepId);
  const others = group.items.filter((item) => item.id !== keepId);
  const data = preview?.status === "ready" ? preview.data : undefined;
  const categorySource = group.items.find(
    (item) => item.id === data?.categorySourceId,
  );
  return (
    <div
      data-testid="merge-confirm"
      role="group"
      aria-label="Confirm merge"
      className="border-t border-border bg-accent/30 px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="text-sm">
        Keep <strong>{kept === undefined ? keepId : displayTitle(kept)}</strong>
        ? {others.length}{" "}
        {others.length === 1 ? "bookmark" : "bookmarks"} will be removed.
      </p>
      {preview?.status === "loading" && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Loading merge preview…
        </p>
      )}
      {preview?.status === "error" && (
        <p className="mt-1 text-xs text-muted-foreground">
          Metadata preview unavailable — tags and notes are still unioned.
        </p>
      )}
      {data !== undefined && (
        <dl className="mt-1 space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-1">
            <dt className="text-muted-foreground">
              Tags after merge ({data.tags.length})
            </dt>
            <dd className="flex flex-wrap items-center gap-1">
              {data.tags.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                data.tags.map((nameKey) => (
                  <span key={nameKey} data-tag={nameKey} className={chipClass}>
                    {tagNameByKey?.get(nameKey) ?? nameKey}
                  </span>
                ))
              )}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-1">
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="text-foreground">
              {data.notesCount === 0
                ? "None"
                : `${data.notesCount} ${
                    data.notesCount === 1 ? "note" : "notes"
                  } will be combined`}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-1">
            <dt className="text-muted-foreground">Category</dt>
            <dd className="text-foreground">
              {data.category === undefined ? (
                "None"
              ) : (
                <>
                  {data.category}
                  {categorySource !== undefined && (
                    <span className="text-muted-foreground">
                      {" "}
                      {data.categorySourceId === keepId
                        ? "(kept bookmark's)"
                        : `(from “${displayTitle(categorySource)}”)`}
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          autoFocus
          disabled={merging}
          onClick={onConfirm}
          className={primaryButtonClass}
        >
          {merging ? "Merging…" : "Confirm merge"}
        </button>
        <button
          type="button"
          disabled={merging}
          onClick={onCancel}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DuplicatesView
// ---------------------------------------------------------------------------

interface ConfirmState {
  /** The group object the user saw when choosing — merge consumes it. */
  group: DuplicateGroup<BookmarkItem>;
  keepId: string;
}

interface MergeFailureInfo {
  code: string;
  message: string;
}

type UndoStatus =
  | { status: "idle" }
  /** Seam fired — App's toast owns the rest of the UX. */
  | { status: "requested" }
  | { status: "applying" }
  | { status: "applied"; restored: number }
  | { status: "failed"; code: string; message: string };

interface MergeOutcome {
  keptTitle: string;
  result: MergeSuccess;
  undo: UndoStatus;
}

export function DuplicatesView({
  groups,
  metaById,
  tagNameByKey,
  loading = false,
  onRequestUndo,
  onMerged,
  onActivateItem,
  empty,
  className,
}: DuplicatesViewProps) {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [preview, setPreview] = useState<ConfirmPreview | null>(null);
  const [merging, setMerging] = useState(false);
  /** groupId → kept title: merged cards collapse to a slim "Merged" row. */
  const [mergedGroups, setMergedGroups] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  /** Ids actually removed by merges — stale rows elsewhere lose actions. */
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [failures, setFailures] = useState<
    ReadonlyMap<string, MergeFailureInfo>
  >(() => new Map());
  /** Latest merge's feedback; single banner mirrors the LIFO undo stack. */
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const mergingRef = useRef(false);
  const undoingRef = useRef(false);
  /** Token guarding preview fetches — a newer keep/cancel invalidates older reads. */
  const previewRequestRef = useRef(0);

  const requestKeep = (group: DuplicateGroup<BookmarkItem>, keepId: string) => {
    if (mergingRef.current) return;
    // A fresh choice clears a previous failure banner for that card.
    const id = groupIdOf(group);
    setFailures((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setConfirm({ group, keepId });
    // Fetch the merge preview: kept-first member order, the same
    // getMetaByIds read mergeGroup performs internally.
    const request = ++previewRequestRef.current;
    setPreview({ status: "loading" });
    const ids = [
      keepId,
      ...group.items.filter((item) => item.id !== keepId).map((i) => i.id),
    ];
    getMetaByIds(ids)
      .then((rows) => {
        if (previewRequestRef.current === request) {
          setPreview({ status: "ready", data: buildMergePreview(rows) });
        }
      })
      .catch(() => {
        if (previewRequestRef.current === request) {
          setPreview({ status: "error" });
        }
      });
  };

  const cancelConfirm = () => {
    if (mergingRef.current) return;
    previewRequestRef.current += 1;
    setConfirm(null);
    setPreview(null);
  };

  const runMerge = async (): Promise<void> => {
    const current = confirm;
    if (current === null || mergingRef.current) return;
    mergingRef.current = true;
    setMerging(true);
    try {
      const result = await mergeGroup(current.group, current.keepId);
      const id = groupIdOf(current.group);
      previewRequestRef.current += 1;
      setConfirm(null);
      setPreview(null);
      if (!result.ok) {
        setFailures((prev) =>
          new Map(prev).set(id, {
            code: result.code,
            message: result.message,
          }),
        );
        return;
      }
      const kept = current.group.items.find(
        (item) => item.id === current.keepId,
      );
      const keptTitle = kept === undefined ? current.keepId : displayTitle(kept);
      setMergedGroups((prev) => new Map(prev).set(id, keptTitle));
      setRemovedIds((prev) => new Set([...prev, ...result.removedIds]));
      setOutcome({ keptTitle, result, undo: { status: "idle" } });
      onMerged?.(result, current.group);
    } finally {
      mergingRef.current = false;
      setMerging(false);
    }
  };

  const requestUndo = async (): Promise<void> => {
    if (undoingRef.current) return;
    if (onRequestUndo !== undefined) {
      onRequestUndo();
      setOutcome((prev) =>
        prev === null ? prev : { ...prev, undo: { status: "requested" } },
      );
      return;
    }
    undoingRef.current = true;
    setOutcome((prev) =>
      prev === null ? prev : { ...prev, undo: { status: "applying" } },
    );
    try {
      const result = await undoLatest();
      setOutcome((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              undo: result.ok
                ? { status: "applied", restored: result.restoredIds.length }
                : {
                    status: "failed",
                    code: result.code,
                    message: result.message,
                  },
            },
      );
    } finally {
      undoingRef.current = false;
    }
  };

  const memberTotal = groups.reduce(
    (total, group) => total + group.items.length,
    0,
  );
  const removedCount = outcome?.result.removedIds.length ?? 0;

  return (
    <div
      className={cn("flex min-h-0 flex-col overflow-y-auto", className)}
      aria-busy={loading || merging}
    >
      {outcome !== null && (
        <div
          role="status"
          data-testid="merge-result"
          className="mx-3 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-accent/30 px-3 py-2"
        >
          <p className="text-sm">
            Merged {removedCount}{" "}
            {removedCount === 1 ? "duplicate" : "duplicates"} into{" "}
            <strong>{outcome.keptTitle}</strong>
          </p>
          <p className="text-xs text-muted-foreground">
            {outcome.result.mergedMeta.tags.length}{" "}
            {outcome.result.mergedMeta.tags.length === 1 ? "tag" : "tags"}
            {outcome.result.mergedMeta.notes !== undefined &&
              " · notes combined"}
            {outcome.result.mergedMeta.category !== undefined &&
              ` · category ${outcome.result.mergedMeta.category}`}
          </p>
          <span className="ml-auto flex items-center gap-2">
            {outcome.undo.status === "idle" && (
              <button
                type="button"
                onClick={() => void requestUndo()}
                className={secondaryButtonClass}
              >
                Undo
              </button>
            )}
            {outcome.undo.status === "requested" && (
              <span className="text-xs text-muted-foreground">
                Undo requested
              </span>
            )}
            {outcome.undo.status === "applying" && (
              <span className="text-xs text-muted-foreground">Undoing…</span>
            )}
            {outcome.undo.status === "applied" && (
              <span className="text-xs text-muted-foreground">
                Undo applied — restored {outcome.undo.restored}
              </span>
            )}
            {outcome.undo.status === "failed" && (
              <span role="alert" className="text-xs text-destructive">
                Undo failed ({outcome.undo.code}): {outcome.undo.message}
              </span>
            )}
            <button
              type="button"
              aria-label="Dismiss merge result"
              onClick={() => setOutcome(null)}
              className={secondaryButtonClass}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}

      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">
          Scanning for duplicates…
        </p>
      ) : groups.length === 0 ? (
        (empty ?? (
          <p className="p-4 text-sm text-muted-foreground">
            No duplicates — every bookmark URL is unique.
          </p>
        ))
      ) : (
        <>
          <p className="shrink-0 px-3 pt-3 text-xs text-muted-foreground">
            {groups.length} duplicate {groups.length === 1 ? "group" : "groups"}{" "}
            · {memberTotal} bookmarks
          </p>
          <div className="space-y-3 p-3">
            {groups.map((group) => {
              const id = groupIdOf(group);
              const mergedTitle = mergedGroups.get(id);
              const failure = failures.get(id);
              const confirming =
                confirm !== null && groupIdOf(confirm.group) === id;
              const first = group.items[0];
              const groupTitle =
                first === undefined ? group.key : displayTitle(first);
              const groupDomain =
                first === undefined ? "" : displayDomain(first.url);
              return (
                <section
                  key={id}
                  data-testid="duplicate-group"
                  data-group-key={group.key}
                  data-kind={group.kind}
                  aria-label={`${kindLabel(group.kind)} duplicate group`}
                  className="rounded-md border border-border bg-card"
                >
                  <header
                    title={group.key}
                    className="flex items-center gap-2 border-b border-border px-3 py-2"
                  >
                    <span className={badgeClass(group.kind)}>
                      {kindLabel(group.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {groupTitle}
                    </span>
                    {groupDomain !== "" && (
                      <span
                        className="shrink-0 text-sm text-muted-foreground"
                        title={group.key}
                      >
                        · {groupDomain}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {group.items.length}{" "}
                      {group.items.length === 1 ? "member" : "members"}
                    </span>
                  </header>
                  {mergedTitle !== undefined ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">
                      Merged — kept “{mergedTitle}”
                    </p>
                  ) : (
                    <>
                      <ul className="divide-y divide-border">
                        {group.items.map((item) => {
                          const keepState: MemberKeepState = removedIds.has(
                            item.id,
                          )
                            ? "removed"
                            : confirming
                              ? item.id === confirm.keepId
                                ? "keeping"
                                : "removing"
                              : "idle";
                          return (
                            <MemberRow
                              key={item.id}
                              item={item}
                              meta={metaById?.get(item.id)}
                              tagNameByKey={tagNameByKey}
                              groupTitle={groupTitle}
                              keepState={keepState}
                              merging={merging}
                              onKeep={() => requestKeep(group, item.id)}
                              onActivate={onActivateItem}
                            />
                          );
                        })}
                      </ul>
                      {failure !== undefined && (
                        <p
                          role="alert"
                          className="border-t border-border px-3 py-2 text-sm text-destructive"
                        >
                          Merge failed ({failure.code}): {failure.message}
                        </p>
                      )}
                      {confirming && (
                        <ConfirmPanel
                          group={group}
                          keepId={confirm.keepId}
                          preview={preview}
                          merging={merging}
                          tagNameByKey={tagNameByKey}
                          onConfirm={() => void runMerge()}
                          onCancel={cancelConfirm}
                        />
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
