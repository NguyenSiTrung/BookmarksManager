import { useEffect, useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { MOVE_PRESELECT_THRESHOLD } from "../../decisions/policy";
import { db } from "../../db/database";
import type { DecisionRow } from "../../decisions/store";
import type { Category } from "../../schemas/bookmark";
import { tagNameKey } from "../../schemas/meta";
import { humanizeCategory } from "../../ui/components/category-select";
import { InfoIcon } from "../../ui/components/icons";

/**
 * Jev save suggestions for the quick-save form (spec FR10).
 *
 * This is the read/render half of the flow. `App` owns the write half: once
 * the user focuses Tags or presses Suggest it sends one `SAVE_SUGGEST` message (consent-gated,
 * best-effort) under a synthetic `popup:<uuid>` bookmark id and tracks the
 * reply's outcome as {@link SuggestionStatus}. The reply itself carries only
 * counts — the suggestions arrive asynchronously as `db.decisions` rows whose
 * `bookmarkIds` contain that id, persisted by the worker's `saveSuggest`
 * handler. This component live-queries those rows and renders them:
 *
 * - `move` at `confidence >= MOVE_PRESELECT_THRESHOLD` (0.7) → asks the parent
 *   to pre-select `targetFolderId` once. The parent suppresses the call when
 *   the user already touched the picker or the folder no longer exists; a
 *   sub-threshold `move` never reaches the callback at all.
 * - `add_tags` → one clickable chip per tag nameKey (`+ tag`); clicking stages
 *   the tag through the parent's normal chip merge (deduped by `tagNameKey`).
 *   A tag the user already staged hides its suggestion twin.
 * - `set_category` → one clickable chip applying the category; suppressed
 *   entirely once `category` is non-empty (a user choice is never invited to
 *   be silently re-decided — nothing applies without a click anyway).
 *
 * The layer is assistive-only: no consent, a rejected sendMessage, an
 * `ok:false` reply, or an unreadable `decisions` table all degrade to quiet
 * absence. A blocklisted page (`sent:false, reason:"blocklisted"`) renders a
 * plain "not sent" note, never an error.
 */

/** Where the SAVE_SUGGEST round-trip stands, for the quiet notes. */
export type SuggestionStatus =
  /** Request in flight or not yet attempted — render nothing. */
  | "idle"
  /** The worker answered `sent:true`; suggestions may stream in via Dexie. */
  | "sent"
  /** `sent:false, reason:"blocklisted"` — render the "not sent" note. */
  | "blocklisted"
  /** No consent, a refused/invalid reply, or a failure — render nothing. */
  | "unavailable";

export interface SuggestionsProps {
  /** The synthetic `popup:<uuid>` id SAVE_SUGGEST was sent under. */
  bookmarkId: string;
  /** Outcome of the request, as reported by the parent. */
  status: SuggestionStatus;
  /** Tag nameKeys already staged by the user — matching suggestions hide. */
  appliedTagKeys: ReadonlySet<string>;
  /** Currently selected category (`""` = none). */
  category: Category | "";
  /** Pre-select `targetFolderId`; the parent may ignore it (user touched). */
  onFolderSuggestion(targetFolderId: string): void;
  /** Merge one suggested tag label into the staged chips. */
  onAcceptTag(label: string): void;
  /** Apply the suggested category. */
  onAcceptCategory(category: Category): void;
}

interface TagSuggestion {
  key: string;
  label: string;
}

/**
 * Rows correlated to this popup's synthetic bookmark id — read via the
 * `*bookmarkIds` multiEntry index (U06), not a scan of the reviewable set.
 * The in-memory filter keeps the same `pending` + `unsure` status set the
 * review surface shows (`listReviewable`), NOT `pending` alone: a multi-tag
 * draft's confidence is the MINIMUM over its selected tags, so one tag the
 * model scored in `[0.5, 0.75)` drags the whole row to `unsure` — filtering
 * to `pending` would hide every tag, including strong ones. The popup is
 * proposal-only (each chip is opt-in), so the review status must not gate
 * chip visibility; the row's tags are already the per-tag `noul >= 0.5`
 * selection.
 */
function useSuggestionRows(bookmarkId: string): DecisionRow[] {
  return useLiveQuery(
    () =>
      db.decisions
        .where("bookmarkIds")
        .equals(bookmarkId)
        .filter(
          (row) => row.status === "pending" || row.status === "unsure",
        )
        .sortBy("createdAt")
        .catch((): DecisionRow[] => []),
    [bookmarkId],
    [],
  );
}

/** The strongest `move` row at or above the pre-select threshold, if any. */
function pickPreselect(
  rows: readonly DecisionRow[],
): (DecisionRow & { kind: "move" }) | null {
  let best: (DecisionRow & { kind: "move" }) | null = null;
  for (const row of rows) {
    if (row.kind !== "move" || row.confidence < MOVE_PRESELECT_THRESHOLD) {
      continue;
    }
    if (best === null || row.confidence > best.confidence) best = row;
  }
  return best;
}

/** Distinct suggested tag labels, minus anything the user already staged. */
function pickTagSuggestions(
  rows: readonly DecisionRow[],
  appliedTagKeys: ReadonlySet<string>,
): TagSuggestion[] {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "add_tags") continue;
    for (const tag of row.tags) {
      const key = tagNameKey(tag);
      if (key === "" || appliedTagKeys.has(key) || byKey.has(key)) continue;
      const label = tag.trim();
      byKey.set(key, label === "" ? key : label);
    }
  }
  return [...byKey.entries()].map(([key, label]) => ({ key, label }));
}

/** The strongest `set_category` suggestion — suppressed once a category is set. */
function pickCategorySuggestion(
  rows: readonly DecisionRow[],
  category: Category | "",
): Category | null {
  if (category !== "") return null;
  let best: Category | null = null;
  let bestConfidence = -1;
  for (const row of rows) {
    if (row.kind !== "set_category" || row.confidence <= bestConfidence) {
      continue;
    }
    bestConfidence = row.confidence;
    best = row.category;
  }
  return best;
}

export function Suggestions({
  bookmarkId,
  status,
  appliedTagKeys,
  category,
  onFolderSuggestion,
  onAcceptTag,
  onAcceptCategory,
}: SuggestionsProps) {
  const rows = useSuggestionRows(bookmarkId);

  const preselect = useMemo(() => pickPreselect(rows), [rows]);
  const tagSuggestions = useMemo(
    () => pickTagSuggestions(rows, appliedTagKeys),
    [rows, appliedTagKeys],
  );
  const categorySuggestion = useMemo(
    () => pickCategorySuggestion(rows, category),
    [rows, category],
  );

  // The folder pre-select is the only suggestion applied without a click;
  // the parent's callback decides whether the picker is still untouched.
  useEffect(() => {
    if (preselect !== null) onFolderSuggestion(preselect.targetFolderId);
  }, [preselect, onFolderSuggestion]);

  if (status === "blocklisted") {
    return (
      <p
        data-testid="suggestions-not-sent"
        role="status"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <InfoIcon className="size-3.5 shrink-0" />
        Suggestions not sent — this page is on the blocklist.
      </p>
    );
  }

  if (tagSuggestions.length === 0 && categorySuggestion === null) {
    return null;
  }

  const chipClass =
    "rounded-full border border-dashed border-primary/40 px-2 py-0.5 text-xs font-medium text-primary outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div
      data-testid="save-suggestions"
      role="status"
      className="flex flex-wrap items-center gap-1.5"
    >
      <span className="text-xs text-muted-foreground">Suggested</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {tagSuggestions.map((tag) => (
          <button
            key={tag.key}
            type="button"
            aria-label={`Add suggested tag ${tag.label}`}
            title={`Add suggested tag ${tag.label}`}
            onClick={() => onAcceptTag(tag.label)}
            className={chipClass}
          >
            + {tag.label}
          </button>
        ))}
        {categorySuggestion !== null && (
          <button
            type="button"
            aria-label={`Set category to ${humanizeCategory(categorySuggestion)}`}
            title={`Set category to ${humanizeCategory(categorySuggestion)}`}
            onClick={() => onAcceptCategory(categorySuggestion)}
            className={chipClass}
          >
            Category: {humanizeCategory(categorySuggestion)}
          </button>
        )}
      </div>
    </div>
  );
}
