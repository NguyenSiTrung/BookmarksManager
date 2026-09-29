import { Switch as RadixSwitch } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../../ui/lib/cn";
import {
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  WarningIcon,
  XIcon,
} from "../../ui/components/icons";

/**
 * Options-page primitives (track options_redesign_20260929). Small, presentational
 * building blocks shared by the four panels: they carry the redesigned visual
 * language (status dots, tinted alerts, collapsible disclosures, selectable
 * provider cards, Radix switches) while section components keep every behavior
 * and consent contract unchanged.
 */

const focusRing =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background focus-visible:outline-hidden";

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

/**
 * Radix Switch styled to the options tokens. `reason` explains a disabled
 * state — rendered inline so a gated control never looks silently frozen.
 */
export function Switch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <RadixSwitch.Root
      id={props.id}
      aria-label={props["aria-label"]}
      checked={props.checked}
      disabled={props.disabled}
      onCheckedChange={props.onCheckedChange}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full",
        "border border-transparent transition-colors duration-200",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          "block size-4 rounded-full bg-white shadow-sm transition-transform",
          "duration-200 data-[state=checked]:translate-x-4",
          "data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </RadixSwitch.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Alert                                                               */
/* ------------------------------------------------------------------ */

type AlertTone = "success" | "error" | "warning" | "info";

const alertStyles: Record<AlertTone, { className: string; Icon: typeof InfoIcon }> = {
  success: {
    className:
      "border-emerald-600/25 bg-emerald-600/8 text-emerald-800 dark:text-emerald-300",
    Icon: CheckIcon,
  },
  error: {
    className:
      "border-destructive/30 bg-destructive/8 text-destructive dark:text-red-300",
    Icon: XIcon,
  },
  warning: {
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    Icon: WarningIcon,
  },
  info: {
    className: "border-border bg-muted/60 text-muted-foreground",
    Icon: InfoIcon,
  },
};

/**
 * Titled feedback line: icon + tinted inset. `success`/`warning`/`info` are
 * advisory (`role="status"`); `error` interrupts (`role="alert"`).
 */
export function Alert(props: {
  tone: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  const { className, Icon } = alertStyles[props.tone];
  return (
    <p
      role={props.tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        className,
        props.className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{props.children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Field                                                               */
/* ------------------------------------------------------------------ */

/**
 * Label + control + hint/error stack. `error` replaces the hint when set and
 * wires `aria-invalid`/`aria-describedby` expectations via a stable id.
 */
export function Field(props: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const hintId = props.htmlFor !== undefined ? `${props.htmlFor}-hint` : undefined;
  const errorId = props.htmlFor !== undefined ? `${props.htmlFor}-error` : undefined;
  return (
    <div className={props.className}>
      <label
        htmlFor={props.htmlFor}
        className="block text-sm font-medium text-foreground"
      >
        {props.label}
      </label>
      <div className="mt-1.5">{props.children}</div>
      {props.error != null && props.error !== "" ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
          {props.error}
        </p>
      ) : props.hint != null ? (
        <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* StatusBadge                                                         */
/* ------------------------------------------------------------------ */

/** Pill with a live dot: `on` renders the teal "active" treatment. */
export function StatusBadge(props: {
  on: boolean;
  onText?: string;
  offText?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
        "text-xs font-medium",
        props.on
          ? "border-primary/30 bg-primary/10 text-primary dark:text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          props.on ? "bg-primary" : "bg-muted-foreground/50",
        )}
      />
      {props.on ? (props.onText ?? "Active") : (props.offText ?? "Not set up")}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Chip                                                                */
/* ------------------------------------------------------------------ */

/** Monospaced token chip, optionally removable (blocklist entries, key ids). */
export function Chip(props: {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 py-0.5 pr-1 pl-2 font-mono text-xs">
      {props.children}
      {props.onRemove !== undefined && (
        <button
          type="button"
          aria-label={props.removeLabel ?? "Remove"}
          onClick={props.onRemove}
          className={cn(
            "rounded p-0.5 text-muted-foreground transition-colors",
            "hover:bg-destructive/10 hover:text-destructive",
            focusRing,
          )}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* ProviderCard                                                        */
/* ------------------------------------------------------------------ */

/**
 * Selectable card wrapping a radio input: icon + name + one-line description
 * + optional trailing status. Replaces the bare-label radio rows — a provider
 * choice should explain what it is, not just name it.
 */
export function ProviderCard(props: {
  name: string;

  value: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Accessible name for the radio (defaults to title + description). */
  inputLabel?: string;
  aside?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-xl border",
        "border-border bg-card p-3 transition-all duration-150",
        "hover:border-primary/40 hover:bg-accent/50",
        "has-checked:border-primary has-checked:bg-accent/60 has-checked:shadow-card",
        "has-focus-visible:ring-2 has-focus-visible:ring-ring",
        props.disabled === true && "pointer-events-none opacity-50",
      )}
    >
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
        aria-label={props.inputLabel ?? props.title}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
          "border border-input transition-colors",
          "group-has-checked:border-primary group-has-checked:bg-primary",
        )}
      >
        <CheckIcon className="size-2.5 text-primary-foreground opacity-0 transition-opacity group-has-checked:opacity-100" />
      </span>
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">
            {props.title}
          </span>
          {props.aside}
        </span>
        {props.description !== undefined && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {props.description}
          </span>
        )}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Disclosure                                                          */
/* ------------------------------------------------------------------ */

/**
 * Collapsible disclosure panel for the verbatim consent text. Open while a
 * provider is unconfigured (the text must be read before enabling), folded
 * once active so it stops dominating the card — still one click away.
 */
export function Disclosure(props: {
  title: string;
  subtitle?: string;
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Accessible name for the panel region (tests + screen readers locate the
   * disclosure body by it — e.g. "TypeSafe data disclosure").
   */
  regionLabel?: string;
  children: ReactNode;
}) {
  return (
    <details
      open={props.open}
      onToggle={(event) =>
        props.onOpenChange?.(event.currentTarget.open)
      }
      className="group rounded-lg border border-border bg-muted/40"
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-3",
          "rounded-lg px-4 py-3 outline-hidden select-none",
          "focus-visible:ring-2 focus-visible:ring-ring",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {props.title}
          </span>
          {props.subtitle !== undefined && (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {props.subtitle}
            </span>
          )}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <div
        role={props.regionLabel !== undefined ? "region" : undefined}
        aria-label={props.regionLabel}
        className="border-t border-border px-4 py-3 text-sm"
      >
        {props.children}
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* SetupChecklist                                                      */
/* ------------------------------------------------------------------ */

export type ChecklistState = "done" | "current" | "pending";

/**
 * Guided setup strip: ordered steps rendered done/current/pending, each
 * optionally clickable to jump to the panel that completes it. This is the
 * device that makes the consent chain legible — connect → consent →
 * automate reads as one flow instead of three scattered screens.
 */
export function SetupChecklist(props: {
  steps: readonly {
    id: string;
    title: string;
    description: string;
    state: ChecklistState;
    onGo?: () => void;
  }[];
}) {
  return (
    <ol
      aria-label="Setup progress"
      className="grid gap-2 sm:grid-cols-3"
    >
      {props.steps.map((step, index) => {
        const inner = (
          <>
            <span className="flex items-center gap-2">
              {step.state === "done" ? (
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <CheckIcon className="size-3" />
                </span>
              ) : (
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full",
                    "border text-xs font-medium",
                    step.state === "current"
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {index + 1}
                </span>
              )}
              <span
                className={cn(
                  "text-sm font-medium",
                  step.state === "pending"
                    ? "text-muted-foreground"
                    : "text-foreground",
                )}
              >
                {step.title}
              </span>
            </span>
            <span className="mt-1 block pl-7 text-xs text-muted-foreground">
              {step.description}
            </span>
          </>
        );
        return (
          <li key={step.id}>
            {step.onGo !== undefined ? (
              <button
                type="button"
                onClick={step.onGo}
                className={cn(
                  "w-full rounded-xl border border-border bg-card p-3",
                  "text-left transition-colors hover:border-primary/40",
                  "hover:bg-accent/50",
                  step.state === "current" && "border-primary/50 bg-accent/40",
                  focusRing,
                )}
              >
                {inner}
              </button>
            ) : (
              <div
                className={cn(
                  "rounded-xl border border-border bg-card p-3",
                  step.state === "current" && "border-primary/50 bg-accent/40",
                )}
              >
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
