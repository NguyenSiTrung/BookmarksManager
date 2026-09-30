import { useId } from "react";
import { Category } from "../../schemas/bookmark";
import { cn } from "../lib/cn";

/**
 * CategorySelect — a controlled `<select>` over the `Category` enum
 * values plus a "None" option that clears the category.
 *
 * Clear semantics follow `MetaPatch.category` (`src/db/meta.ts`): choosing
 * "None" calls `onChange(null)`, which both `patchMeta` and
 * `bulkSetCategory` read as "clear the category" (whereas `undefined`
 * means "leave untouched" there — so `null` is emitted, not `undefined`).
 *
 * A native select is used instead of a Radix menu so the control is a real
 * `combobox` with platform keyboard behaviour; styling matches the input
 * classes used elsewhere (`border-input`, `bg-background`, `ring-ring`).
 */
export interface CategorySelectProps {
  /** Current category; `undefined`/`null` renders as "None". */
  value?: Category | null;
  /** Chosen category, or `null` for "None". */
  onChange?: (category: Category | null) => void;
  /** Optional visible label bound to the select (else `aria-label`). */
  label?: string;
  /** Override the generated select id (for external labels). */
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Extra classes merged onto the `<select>` itself (last wins). */
  selectClassName?: string;
}

/** "docs" → "Docs" — the enum is single lowercase words. */
export function humanizeCategory(category: Category): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export function CategorySelect({
  value,
  onChange,
  label,
  id,
  disabled,
  className,
  selectClassName,
}: CategorySelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <span
      data-slot="category-select"
      className={cn("inline-flex items-center gap-2", className)}
    >
      {label !== undefined && (
        <label htmlFor={selectId} className="text-sm text-muted-foreground">
          {label}
        </label>
      )}
      <select
        id={selectId}
        aria-label={label === undefined ? "Category" : undefined}
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          onChange?.(next === "" ? null : (next as Category));
        }}
        className={cn(
          "rounded-md border border-input bg-background px-2 py-1 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          selectClassName,
        )}
      >
        <option value="">None</option>
        {Category.options.map((category) => (
          <option key={category} value={category}>
            {humanizeCategory(category)}
          </option>
        ))}
      </select>
    </span>
  );
}
