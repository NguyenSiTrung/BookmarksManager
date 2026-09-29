import type { ReactElement } from "react";
import { cn } from "../lib/cn";

/**
 * A centred "nothing here" block: a title, one line of guidance and at most
 * one next-step button. Static content, so it has no live-region role.
 */
export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: { label: string; onSelect(): void };
  className?: string;
}

export function EmptyState({
  title,
  hint,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-1 px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium break-words">{title}</p>
      {hint !== undefined && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {action !== undefined && (
        <button
          type="button"
          onClick={action.onSelect}
          className="mt-3 rounded-sm border border-border bg-background px-3 py-1.5 text-xs outline-hidden hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
