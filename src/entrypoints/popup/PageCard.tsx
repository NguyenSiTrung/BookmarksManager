import { useEffect, useRef } from "react";
import { Favicon } from "../../ui/components/favicon";

/**
 * The quick-save popup's hero: it confirms WHICH page is being saved (favicon
 * and domain) and lets the title be corrected in place. The URL itself is
 * rarely edited, so it lives behind the form's "Details" disclosure instead of
 * taking a full-width field here.
 *
 * The title input is focused once the prefill settles so "open popup, press
 * Enter" saves the page without touching the mouse.
 */

export interface PageCardProps {
  title: string;
  /** Hostname of the typed URL, or `null` when it does not parse. */
  host: string | null;
  /** The typed URL, used only to ask Chrome for the favicon. */
  url: string;
  disabled?: boolean;
  onTitleChange(value: string): void;
}

/** Hostname of a typed URL, or `null` when it is empty or does not parse. */
export function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url.trim());
    return hostname === "" ? null : hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function PageCard({
  title,
  host,
  url,
  disabled = false,
  onTitleChange,
}: PageCardProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <section
      aria-label="Page to save"
      className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-card"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary"
      >
        <Favicon
          pageUrl={host === null ? "" : url.trim()}
          size={32}
          className="size-5 rounded-xs"
        />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor="popup-title" className="sr-only">
          Title
        </label>
        <input
          ref={titleRef}
          id="popup-title"
          value={title}
          disabled={disabled}
          placeholder="Untitled page"
          onChange={(event) => onTitleChange(event.target.value)}
          className="-mx-1.5 w-[calc(100%+0.75rem)] truncate rounded-md bg-transparent px-1.5 py-0.5 text-[15px] leading-snug font-semibold outline-hidden transition-colors placeholder:font-normal hover:bg-secondary focus:bg-background focus:ring-2 focus:ring-ring/40 disabled:opacity-100"
        />
        <p className="truncate text-xs text-muted-foreground">
          {host ?? "No valid URL yet"}
        </p>
      </div>
    </section>
  );
}
