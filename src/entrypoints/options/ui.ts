/**
 * Shared class recipes for the Options page. They read the shadcn theme
 * tokens from `src/ui/styles.css`; under `.options-root` those tokens carry
 * the redesigned palette (warm neutrals, teal accent, tinted shadows), and
 * light/dark still follows `prefers-color-scheme`.
 */
const focusRing =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background focus-visible:outline-hidden";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 " +
  "text-sm font-medium transition-all duration-150 active:scale-[0.98] " +
  "disabled:pointer-events-none disabled:opacity-50";

export const primaryButtonClass =
  `${buttonBase} ${focusRing} bg-primary text-primary-foreground shadow-sm ` +
  "hover:bg-primary/85";

export const dangerButtonClass =
  `${buttonBase} ${focusRing} bg-destructive text-white hover:bg-destructive/90`;

export const secondaryButtonClass =
  `${buttonBase} ${focusRing} border border-border bg-card ` +
  "text-foreground hover:border-primary/40 hover:bg-accent";

/** Quiet destructive action — inline revoke/clear affordances. */
export const ghostDangerButtonClass =
  `${buttonBase} ${focusRing} border border-destructive/30 ` +
  "text-destructive hover:bg-destructive/10";

export const smallButtonClass =
  "inline-flex items-center gap-1 rounded-md border border-border bg-card " +
  "px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden " +
  "disabled:pointer-events-none disabled:opacity-50";

export const inputClass =
  "w-full rounded-lg border border-input bg-card px-3 py-2 text-sm " +
  "shadow-xs transition-colors placeholder:text-muted-foreground/70 " +
  "hover:border-primary/40 focus-visible:border-primary " +
  "focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-hidden";

/** One Options panel card: elevated surface on the page background. */
export const cardClass =
  "rounded-xl border border-border bg-card p-4 text-card-foreground " +
  "shadow-card sm:p-6";

/** The destructive "Danger zone" variant of {@link cardClass}. */
export const dangerCardClass =
  "rounded-xl border border-destructive/30 bg-card p-4 text-card-foreground " +
  "shadow-card sm:p-6";

/** Inset callout inside a card (disclosures, budget). */
export const insetClass =
  "rounded-lg border border-border bg-muted/50 p-4 text-sm";

export const sectionHeadingClass =
  "text-base font-semibold tracking-tight text-foreground";

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
    ? `${badgeBase} border-primary/30 bg-primary/10 text-primary`
    : `${badgeBase} border-border bg-muted text-muted-foreground`;
}
