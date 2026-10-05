import { Component, type ReactNode } from "react";
import { db } from "../../db/database";

/**
 * Crash containment for the three extension pages (spec U10). A React
 * render error no longer blanks the surface silently: the boundary swaps
 * in a Reload fallback AND reports the error through `reportClientError`
 * — a `console.error` plus a bounded diagnostics row in `db.metadata` —
 * so the failure is visible after the fact, not swallowed.
 *
 * `installClientErrorReporting(surface)` wires the same channel for
 * `unhandledrejection`: a promise that rejects without a `.catch`
 * otherwise vanishes with no trace on an extension page. Reporting is
 * fail-soft — a diagnostics write that itself fails must never throw into
 * an already-degraded surface.
 *
 * Redaction rule: only the error name and a bounded message are stored —
 * never the stack, which can carry file paths and page URLs.
 */

const MAX_MESSAGE = 300;
const MAX_RECORDS = 10;
export const CLIENT_ERRORS_KEY = "diagnostics:clientErrors";

export interface ClientErrorRecord {
  at: string;
  surface: string;
  name: string;
  message: string;
}

function describe(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const message =
    error instanceof Error ? error.message : String(error);
  return { name, message: message.slice(0, MAX_MESSAGE) };
}

/**
 * Report a client-side failure: console (the only live channel an
 * extension page has) plus a bounded record ring in `db.metadata`, newest
 * last. Never throws.
 */
export async function reportClientError(
  surface: string,
  error: unknown,
): Promise<void> {
  const { name, message } = describe(error);
  console.error(`[${surface}] ${name}: ${message}`);
  try {
    const row = await db.metadata.get(CLIENT_ERRORS_KEY);
    const records = Array.isArray(row?.value)
      ? (row.value as ClientErrorRecord[])
      : [];
    records.push({
      at: new Date().toISOString(),
      surface,
      name,
      message,
    });
    await db.metadata.put({
      key: CLIENT_ERRORS_KEY,
      value: records.slice(-MAX_RECORDS),
    });
  } catch {
    // A diagnostics write failure is not a second failure to report.
  }
}

/**
 * Surface uncaught errors on this page through `reportClientError`:
 * `unhandledrejection` covers stray promise rejections and `"error"`
 * covers synchronous throws in event handlers — the two disjoint uncaught
 * classes on a page. Install once per entrypoint, before the app mounts.
 */
export function installClientErrorReporting(surface: string): void {
  window.addEventListener("unhandledrejection", (event) => {
    void reportClientError(surface, event.reason);
  });
  window.addEventListener("error", (event) => {
    void reportClientError(surface, event.error ?? event.message);
  });
}

interface ErrorBoundaryProps {
  /** Names the entrypoint in reports and the fallback copy. */
  surface: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    void reportClientError(this.props.surface, error);
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <div
          role="alert"
          className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-center shadow-sm"
        >
          <h1 className="text-base font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The {this.props.surface} view hit an unexpected error. It was
            recorded for debugging — reload to continue.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/85 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
