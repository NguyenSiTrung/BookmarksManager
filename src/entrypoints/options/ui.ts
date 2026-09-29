/**
 * Shared class recipes for the Options page. They read the shadcn theme
 * tokens from `src/ui/styles.css`, so light and dark mode follow
 * `prefers-color-scheme` with no per-component `dark:` overrides.
 */
const focusRing =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background focus-visible:outline-hidden";

const buttonBase =
  "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm " +
  "font-medium shadow-xs transition-colors disabled:pointer-events-none " +
  "disabled:opacity-50";

export const primaryButtonClass =
  `${buttonBase} ${focusRing} bg-primary text-primary-foreground hover:bg-primary/90`;

export const dangerButtonClass =
  `${buttonBase} ${focusRing} bg-destructive text-white hover:bg-destructive/90`;

export const secondaryButtonClass =
  `${buttonBase} ${focusRing} border border-border bg-background ` +
  "text-foreground hover:bg-accent";

export const smallButtonClass =
  "rounded-md border border-border bg-background px-2.5 py-1 text-xs " +
  "font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50";

export const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "shadow-xs focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden";

/** One Options section: a titled card. */
export const cardClass =
  "rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs sm:p-6";

/** The destructive "Danger zone" variant of {@link cardClass}. */
export const dangerCardClass =
  "rounded-xl border border-destructive/40 bg-card p-4 text-card-foreground " +
  "shadow-xs sm:p-6";

/** Inset callout inside a card (disclosures, budget). */
export const insetClass =
  "rounded-lg border border-border bg-muted/40 p-4 text-sm";

export const sectionHeadingClass = "text-base font-semibold tracking-tight";

/** A selectable card wrapping a radio input (`has-checked` styles the pick). */
export const radioCardClass =
  "flex cursor-pointer items-center gap-2 rounded-lg border border-border " +
  "px-3 py-2 text-sm transition-colors hover:bg-accent/50 " +
  "has-checked:border-primary has-checked:bg-accent " +
  "has-focus-visible:ring-2 has-focus-visible:ring-ring";

export const radioGroupClass = "mt-2 grid gap-2 sm:grid-cols-2";

const badgeBase =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium";

/** Small status pill; `on` is the positive (enabled / connected) state. */
export function statusBadgeClass(on: boolean): string {
  return on
    ? `${badgeBase} border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400`
    : `${badgeBase} border-border bg-muted text-muted-foreground`;
}
