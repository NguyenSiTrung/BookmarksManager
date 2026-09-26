import { cn } from "../lib/cn";

/**
 * TagChip — a tag pill: a colored dot plus the tag's display name, with an
 * optional remove (×) button. The chip carries an accessible label (its
 * `role="group"` is named `name`), the dot is `aria-hidden`, and the remove
 * button is labelled `Remove tag <name>`.
 *
 * `size="sm"` is the dense variant for BookmarkList rows; the default `md`
 * suits editors and the tag manager.
 */
export interface TagChipProps {
  /** Tag display name (callers map nameKey → `TagDef.name`). */
  name: string;
  /** TagDef color (any CSS color); a neutral dot renders when absent. */
  color?: string;
  /** `sm` for dense list rows, `md` (default) elsewhere. */
  size?: "sm" | "md";
  /** When set, renders a remove (×) button that fires this callback. */
  onRemove?: () => void;
  className?: string;
}

export function TagChip({
  name,
  color,
  size = "md",
  onRemove,
  className,
}: TagChipProps) {
  return (
    <span
      data-slot="tag-chip"
      data-size={size}
      role="group"
      aria-label={name}
      title={name}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary text-secondary-foreground",
        size === "sm" ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 rounded-full",
          size === "sm" ? "size-1.5" : "size-2",
          color === undefined && "bg-muted-foreground",
        )}
        style={
          color === undefined ? undefined : { backgroundColor: color }
        }
      />
      <span className="truncate">{name}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          aria-label={`Remove tag ${name}`}
          onClick={onRemove}
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full outline-hidden",
            "hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
            size === "sm" ? "size-3 text-[10px]" : "size-3.5 text-xs",
          )}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}
