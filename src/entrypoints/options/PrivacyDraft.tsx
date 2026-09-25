import policy from "../../../store/privacy-policy.md?raw";

/**
 * The extension's draft privacy policy, bundled at build time via a Vite raw
 * import — zero network requests, available until a public policy URL exists
 * (spec §3). Rendered as plain text; no markdown library needed.
 */
export function PrivacyDraft() {
  return (
    <section aria-labelledby="privacy-draft-heading" className="mt-8">
      <h2 id="privacy-draft-heading" className="text-lg font-medium">
        Extension privacy policy (local draft)
      </h2>
      <p className="mt-1 text-sm text-gray-700">
        Bundled with the extension — reading it here needs no network
        connection.
      </p>
      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-gray-300 p-3 text-xs">
        {policy}
      </pre>
    </section>
  );
}
