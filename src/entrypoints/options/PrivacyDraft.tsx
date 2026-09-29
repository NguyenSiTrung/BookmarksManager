import policy from "../../../store/privacy-policy.md?raw";
import { cardClass, sectionHeadingClass } from "./ui";

/**
 * The extension's draft privacy policy, bundled at build time via a Vite raw
 * import — zero network requests, available until a public policy URL exists
 * (spec §3). Rendered as plain text; no markdown library needed. Collapsed by
 * default: it is long, and reference text should not push the actionable
 * provider cards apart.
 */
export function PrivacyDraft() {
  return (
    <section aria-labelledby="privacy-draft-heading" className={cardClass}>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <h2 id="privacy-draft-heading" className={sectionHeadingClass}>
            Extension privacy policy (local draft)
          </h2>
          <span
            aria-hidden="true"
            className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          >
            ▾
          </span>
        </summary>
        <p className="mt-2 text-sm text-muted-foreground">
          Bundled with the extension — reading it here needs no network
          connection.
        </p>
        <pre
          tabIndex={0}
          className="mt-2 max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
        >
          {policy}
        </pre>
      </details>
    </section>
  );
}
