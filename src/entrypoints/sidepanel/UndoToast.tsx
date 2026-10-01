import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { undoLatest } from "../../undo/restore";

/**
 * Bottom "Undo" toast for the side panel — the user-visible half of the undo
 * stack (`src/undo/{snapshot,restore}.ts`).
 *
 *  - {@link useUndoToastController} owns the toast state: `showToast` puts a
 *    message up and arms an ~8s auto-hide timer (a new toast re-arms it),
 *    `dismiss` hides immediately, and `undo` pops the newest snapshot via
 *    `undoLatest()`. `undo` is re-entry-guarded: a second call while one is
 *    outstanding is ignored, so a double-click cannot pop two snapshots.
 *  - Every undoable action (delete, bulk move) shows its confirmation with
 *    `undoable: true` — the toast then offers an "Undo" button. Tag/category
 *    confirmations report the affected count without an Undo affordance.
 *  - `undoLatest()`'s result is a total union: `{ok:true}` reports success
 *    (naming the Other-bookmarks fallback when it fired), and `{ok:false}`
 *    shows the TYPED failure message. A failed restore keeps its row on the
 *    stack (`restore.ts` pops on success only), so the failure toast keeps
 *    the Undo button — the retry resumes instead of replaying.
 *  - {@link UndoToastProps.busy} is the SHELL's decision-revert round trip:
 *    the Undo control is disabled (and announced `aria-busy`) while the
 *    dispatch that consumed its target owns the toast, instead of accepting
 *    an activation the dispatcher would refuse. The snapshot path never sets
 *    it — that re-entry is the controller's own guard above.
 *  - {@link ToastContext}/{@link useToast} let deeper components (bulk bar,
 *    dialogs, folder actions) report without prop drilling; outside a
 *    provider the hook degrades to a no-op so components stay renderable in
 *    isolation.
 */

/** One toast: the message plus its affordances. */
export interface ToastState {
  message: string;
  /** Offer the Undo button (the action pushed a snapshot). */
  undoable?: boolean;
  /** Failure styling/semantics (`role="alert"`). */
  error?: boolean;
}

/** What consumers need: put a toast up. */
export interface ToastApi {
  showToast(toast: ToastState): void;
}

/** Toast state plus its controls, owned by the app shell. */
export interface UndoToastController extends ToastApi {
  toast: ToastState | null;
  dismiss(): void;
  undo(): Promise<void>;
}

/** Auto-hide delay for every toast (~8s per the spec). */
export const UNDO_TOAST_AUTO_HIDE_MS = 8000;

export const ToastContext = createContext<ToastApi | null>(null);

/** Inert fallback so components render outside a provider (tests, previews). */
const NOOP_TOAST: ToastApi = { showToast: () => {} };

/** The nearest toast API, or a no-op outside a provider. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP_TOAST;
}

/**
 * User-visible text for a rejected promise: an `Error`'s message (every
 * mutation/undo rejection carries one — `MutationError`, `MetaRepoError`,
 * wrapped API failures) or the stringified value.
 */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Toast state machine. The auto-hide timer is cleared on every new toast and
 * on unmount, so a stale timer can never blank a newer message.
 *
 * `onAutoHide` fires SYNCHRONOUSLY when that timer clears the toast — the one
 * transition of the toast slot this controller owns that a caller cannot see
 * through `toast` alone. The shell uses it to retire whatever it keyed to the
 * toast that just left the screen (its generation token and an armed
 * decision-revert target); this hook stays unaware of both, and the generic
 * `undo` path is untouched by it.
 */
export function useUndoToastController(
  autoHideMs: number = UNDO_TOAST_AUTO_HIDE_MS,
  onAutoHide?: () => void,
): UndoToastController {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // In-flight gate: `undoLatest` is serialized internally, but a double-click
  // (or a click landing while a slow restore is outstanding) would still
  // queue a SECOND undo and pop two snapshots. While one call is pending the
  // extra invocation is ignored — the toast updates once it settles.
  const pendingRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (next: ToastState) => {
      clearTimer();
      setToast(next);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setToast(null);
        onAutoHide?.();
      }, autoHideMs);
    },
    [autoHideMs, clearTimer, onAutoHide],
  );

  const undo = useCallback(async () => {
    if (pendingRef.current) return; // a call is already outstanding
    pendingRef.current = true;
    try {
      const result = await undoLatest();
      if (result.ok) {
        showToast({
          message: result.fellBackToOther
            ? "Undone — restored into Other bookmarks."
            : "Undone.",
        });
        return;
      }
      // Typed failure; Undo stays on the toast because the failed snapshot is
      // still on the stack (restore pops on success only) and is retryable.
      showToast({
        message: `Undo failed: ${result.message}`,
        error: true,
        undoable: true,
      });
    } finally {
      pendingRef.current = false;
    }
  }, [showToast]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return useMemo(
    () => ({ toast, showToast, dismiss, undo }),
    [toast, showToast, dismiss, undo],
  );
}

/** Toast context provider around a controller (keeps the API in one object). */
export function ToastProvider({
  controller,
  children,
}: {
  controller: ToastApi;
  children: ReactNode;
}) {
  return (
    <ToastContext.Provider value={controller}>
      {children}
    </ToastContext.Provider>
  );
}

export interface UndoToastProps {
  toast: ToastState | null;
  onUndo: () => void;
  onDismiss: () => void;
  /**
   * A decision revert is in flight: the undo round trip owns the toast slot
   * by then, so the button is disabled and announced busy rather than
   * accepting an activation the dispatcher would refuse. Generic snapshot
   * undos leave it false — their own controller guard governs re-entry.
   */
  busy?: boolean;
}

/** The toast itself — bottom of the panel, message + Undo + dismiss. */
export function UndoToast({ toast, onUndo, onDismiss, busy }: UndoToastProps) {
  const undoBusy = busy === true;
  if (toast === null) return null;
  return (
    <div
      data-testid="undo-toast"
      role={toast.error === true ? "alert" : "status"}
      className={
        "fixed bottom-3 left-1/2 z-50 flex w-[min(24rem,calc(100%-1.5rem))] " +
        "-translate-x-1/2 items-center gap-2 rounded-md border border-border " +
        "bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
      }
    >
      <span className="min-w-0 flex-1 truncate" title={toast.message}>
        {toast.message}
      </span>
      {toast.undoable === true && (
        <button
          type="button"
          onClick={onUndo}
          disabled={undoBusy}
          aria-busy={undoBusy ? true : undefined}
          className={
            "shrink-0 rounded-sm px-2 py-1 text-xs font-medium " +
            "text-primary outline-hidden hover:bg-accent " +
            "focus-visible:ring-2 focus-visible:ring-ring " +
            "disabled:cursor-not-allowed disabled:opacity-50"
          }
        >
          Undo
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className={
          "shrink-0 rounded-sm px-1.5 py-1 text-xs text-muted-foreground " +
          "outline-hidden hover:bg-accent " +
          "focus-visible:ring-2 focus-visible:ring-ring"
        }
      >
        ×
      </button>
    </div>
  );
}
