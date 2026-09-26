import { useState } from "react";
import { cn } from "../lib/cn";

/**
 * `<Favicon>` renders a page's favicon through Chrome's built-in
 * `_favicon` renderer:
 *
 *   chrome-extension://<id>/_favicon/?pageUrl=<enc>&size=<n>
 *
 * The MV3 `favicon` permission makes Chrome serve the icon itself — the
 * extension needs no host access and issues no request of its own. On a
 * load error (unknown host, icon still uncached) a neutral globe glyph is
 * rendered instead; lucide-react is intentionally not a dependency, so the
 * placeholder is a minimal inline SVG.
 *
 * `chrome` follows the house lazy-slice pattern (see
 * `src/sync/chrome-bookmarks.ts`): only `runtime.getURL` is declared, and it
 * is resolved at render time — not at module load — so `vi.stubGlobal`
 * works in tests.
 */
declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

export interface FaviconProps {
  /** Absolute URL of the page whose favicon should be shown. */
  pageUrl: string;
  /** Icon edge in px; Chrome serves 16 or 32. Defaults to 32. */
  size?: number;
  className?: string;
}

/** Builds the `_favicon/` renderer URL with an encoded `pageUrl` and `size`. */
function faviconUrl(pageUrl: string, size: number): string {
  const base = chrome.runtime.getURL("_favicon/");
  const params = new URLSearchParams({ pageUrl, size: String(size) });
  return `${base}?${params.toString()}`;
}

/** Inline globe glyph shown when Chrome has no cached icon for the page. */
function FaviconPlaceholder({
  size,
  className,
}: {
  size: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="Favicon placeholder"
      className={cn(
        "inline-flex items-center justify-center text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
    </span>
  );
}

export function Favicon({ pageUrl, size = 32, className }: FaviconProps) {
  const src = faviconUrl(pageUrl, size);
  // Keyed by src: a new pageUrl/size automatically retries the <img>.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) {
    return <FaviconPlaceholder size={size} className={className} />;
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      className={className}
      onError={() => setFailedSrc(src)}
    />
  );
}
