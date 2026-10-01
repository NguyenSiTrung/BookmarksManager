import { useEffect, useRef } from "react";
import { Favicon } from "../../ui/components/favicon";

/**
 * The quick-save popup's hero: it confirms WHICH page is being saved (favicon
 * and domain) and lets the title be corrected in place. The URL itself is
 * rarely edited, so it lives behind the form's "Details" disclosure instead of
 * taking a full-width field here.
 *
 * When the active tab offered nothing saveable (`urlEditable`, e.g. a new-tab
 * page) the URL field replaces the domain line right here, so the empty state
 * is "paste a link" rather than a disabled Save with the cause tucked away.
 *
 * The title input is focused once the prefill settles so "open popup, press
 * Enter" saves the page without touching the mouse; in URL mode the URL field
 * takes focus instead, since that is the only thing left to provide. Focus is
 * placed with the caret at the end of the value rather than selecting it, and
 * the input uses the same quiet fill when focused as on hover — no border or
 * ring — so the popup does not open looking like a boxed text field.
 */

export interface PageCardProps {
  title: string;
  /** Hostname of the typed URL, or `null` when it does not parse. */
  host: string | null;
  /** The typed URL, used only to ask Chrome for the favicon. */
  url: string;
  disabled?: boolean;
  /** Show a URL input in place of the domain line. */
  urlEditable?: boolean;
  onTitleChange(value: string): void;
  onUrlChange?(value: string): void;
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
  urlEditable = false,
  onTitleChange,
  onUrlChange,
}: PageCardProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = (urlEditable ? urlRef : titleRef).current;
    el?.focus();
    // Place the caret at the end instead of selecting the whole title.
    // Programmatic `.focus()` on a text input selects its contents in
    // Chrome, which reads as "this text is already selected" the moment the
    // popup opens. Collapsing to the end keeps "open popup, press Enter to
    // save" working (typing appends, Enter submits) without the inverted
    // highlight.
    const end = el?.value.length ?? 0;
    el?.setSelectionRange(end, end);
    // Focus once on mount; `urlEditable` is fixed for the popup's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          className="-mx-1.5 w-[calc(100%+0.75rem)] truncate rounded-md bg-transparent px-1.5 py-0.5 text-[15px] leading-snug font-semibold outline-hidden transition-colors placeholder:font-normal hover:bg-secondary focus:bg-secondary disabled:opacity-100"
        />
        {urlEditable ? (
          <>
            <label htmlFor="popup-url" className="sr-only">
              URL
            </label>
            <input
              ref={urlRef}
              id="popup-url"
              value={url}
              disabled={disabled}
              spellCheck={false}
              placeholder="Paste a link to save"
              onChange={(event) => onUrlChange?.(event.target.value)}
              className="mt-1.5 h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-hidden transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-70"
            />
          </>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{host}</p>
        )}
      </div>
    </section>
  );
}
