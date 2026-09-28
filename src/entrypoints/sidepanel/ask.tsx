import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CONSENT_VERSION } from "../../consent/records";
import { db } from "../../db/database";
import { DecisionMessage } from "../../messages/decisions";
import { DECISIONS_CONSENT_SCOPE } from "../../schemas/provider";
import { sendDecisionMessage } from "./ReviewView";

/**
 * The "Ask" half of the side-panel search bar (spec FR10): an opt-in toggle
 * that reranks the current query's local results through the decisions
 * worker's RERANK intent and surfaces a "no match" state.
 *
 * Shape of the module — a state/logic HOOK (`useAskSearch`) plus the pure
 * note-to-text mapper (`askNoteText`); SearchBar renders both:
 *
 *  - {@link useAskSearch} owns everything stateful:
 *     1. **Consent-gated visibility.** The toggle exists only while at
 *        least one provider holds a `jev_decisions` grant — read straight
 *        from `db.consents` via `useLiveQuery` (a row with the current
 *        {@link CONSENT_VERSION}; a stale-version row does not count), so
 *        the toggle appears/disappears as consent is granted/revoked. This
 *        is a VISIBILITY check only; the worker independently re-verifies
 *        consent before any request leaves the device.
 *     2. **Debounced dispatch.** The search input is controlled per
 *        keystroke, but a rerank is a provider request, so edits settle
 *        for {@link ASK_DEBOUNCE_MS} before ONE `RERANK` is sent for the
 *        settled query (toggling Ask on with a query already present
 *        reranks it immediately, via the same debounce).
 *     3. **Stale-reply guard.** Every effect run bumps a request counter
 *        (the `currentPreset`-ref pattern `ProviderSetup` uses); a reply
 *        whose captured id no longer matches is dropped, so a slow reply
 *        for a superseded query — or one landing after Ask was switched
 *        off or consent was revoked — can never overwrite newer state.
 *  - Replies are validated by `sendDecisionMessage`
 *    (`DecisionMessageResult.safeParse`, the ReviewView pattern) and folded
 *    into a quiet {@link AskNote}:
 *     - `rerank_ok` + `sent` → the ids (already LOCAL bookmark ids — the
 *       rerank service maps candidates back before returning) are ordered
 *       by `probability` desc and reported through `onRerankOrder`; the
 *       worker already sorts them, the sort here is a defensive re-derivation.
 *     - `noMatch === true` (every probability under the §10.2 bar) → the
 *       "no match" note, distinct from the search bar's "0 results" count.
 *       The ranked ids are still reported — low confidence reorders, it
 *       does not hide results.
 *     - `{sent:false}` (empty shortlist / all blocklisted) → NO error: the
 *       order falls back to `null` (local relevance order) with a quiet
 *       not-sent note.
 *     - `{ok:false}` → the (already redacted) `message` rendered quietly.
 *       Ask is an assistive feature; a failure never crashes the panel.
 *  - With Ask OFF the hook does nothing observable: no message is sent and
 *    `onRerankOrder` is never invoked, so plain search stays purely local.
 */

/**
 * How long the query must settle before a RERANK is sent. The local search
 * runs per keystroke (free); this keeps one provider request per paused
 * query instead of one per key.
 */
export const ASK_DEBOUNCE_MS = 350;

/** Same contract as ReviewView's unexpected-reply fallback. */
const UNEXPECTED_REPLY_MESSAGE =
  "The extension worker returned an unexpected reply.";

/** The quiet per-query state of the Ask feature. */
export type AskNote =
  /** Ask off, no query, or consent gone — nothing to show. */
  | { kind: "idle" }
  /** A rerank is scheduled/in flight for the current query. */
  | { kind: "asking" }
  /** A rerank landed and its order was reported. */
  | { kind: "ranked" }
  /** The rerank landed but every probability was under the bar. */
  | { kind: "no-match" }
  /** No request was made — the shortlist was empty or all blocklisted. */
  | { kind: "skipped"; reason: "empty" | "blocklisted" }
  /** A redacted failure message, rendered quietly. */
  | { kind: "error"; message: string };

/** The note kinds a completed reply can produce (never idle/asking). */
export type AskReplyNote = Exclude<
  AskNote,
  { kind: "idle" } | { kind: "asking" }
>;

/** The note's display text, or `null` when nothing should render. */
export function askNoteText(note: AskNote): string | null {
  switch (note.kind) {
    case "idle":
      return null;
    case "asking":
      return "Asking Jev…";
    case "ranked":
      return "Ranked by Ask.";
    case "no-match":
      return "No close match — showing the best local guesses.";
    case "skipped":
      return note.reason === "empty"
        ? "Ask found no local results to rank."
        : "Nothing was sent — every result is on the blocklist.";
    case "error":
      return `Ask is unavailable: ${note.message}`;
  }
}

/** Surface {@link useAskSearch} exposes to the search bar. */
export interface AskSearchApi {
  /** True while any provider holds a current `jev_decisions` grant. */
  readonly consent: boolean;
  /** Whether the user switched Ask on (state survives a consent blip). */
  readonly askOn: boolean;
  /** Flip the toggle. */
  readonly toggleAsk: () => void;
  /** The quiet per-query note (`idle` → render nothing). */
  readonly note: AskNote;
}

/**
 * True while any consent row grants `jev_decisions` at the current
 * {@link CONSENT_VERSION}. Origin-agnostic on purpose: the side panel does
 * not know which preset the worker will use, so ANY provider's grant shows
 * the toggle — the worker remains the authority on the actual send. The
 * `.catch` is required: `useLiveQuery` rethrows observable errors.
 */
function readAskConsent(): Promise<boolean> {
  return db.consents
    .toArray()
    .then((rows) =>
      rows.some(
        (row) =>
          row.scope === DECISIONS_CONSENT_SCOPE &&
          row.consentVersion === CONSENT_VERSION,
      ),
    )
    .catch((): boolean => false);
}

/**
 * The Ask state machine for one search bar. `query` is the controlled
 * search input's value; `onRerankOrder` (optional — the App call site
 * works unchanged without it) receives the reranked bookmark-id order, or
 * `null` whenever the local relevance order applies (Ask off, no query,
 * not-sent, or a new rerank pending). It is invoked ONLY when the verdict
 * actually changes, so an absent/inline callback never churns renders.
 */
export function useAskSearch(
  query: string,
  onRerankOrder?: (ids: readonly string[] | null) => void,
  debounceMs: number = ASK_DEBOUNCE_MS,
): AskSearchApi {
  // undefined = read pending; the toggle stays hidden until Dexie answers.
  const consentRead = useLiveQuery(readAskConsent);
  const consent = consentRead === true;

  const [askOn, setAskOn] = useState(false);
  /**
   * The note the LAST accepted reply produced, tagged with the query it
   * answers. Untimed state is derived in render (below) from it, so no
   * effect ever writes state synchronously: an active query shows `asking`
   * until a reply tagged with THIS query lands.
   */
  const [replyNote, setReplyNote] = useState<{
    query: string;
    note: AskReplyNote;
  } | null>(null);

  /**
   * Stale-reply guard: bumped on every effect run, so a reply carries the
   * id of the query it was sent for and anything newer invalidates it.
   */
  const requestRef = useRef(0);
  /** Latest `onRerankOrder` (identity may churn per parent render). */
  const orderRef = useRef(onRerankOrder);
  /** Whether the last report was a non-null order — gates null reports. */
  const orderReportedRef = useRef(false);

  useEffect(() => {
    orderRef.current = onRerankOrder;
  }, [onRerankOrder]);

  /** Report an order verdict exactly once per change (null = local order). */
  const reportOrder = useCallback(
    (ids: readonly string[] | null): void => {
      orderReportedRef.current = ids !== null;
      orderRef.current?.(ids);
    },
    [],
  );

  /**
   * Fall back to the local order — reported ONLY when a reranked order was
   * reported before, so a failure/skip for the first query of a session
   * never churns the callback (local order already applies).
   */
  const reportLocalOrder = useCallback((): void => {
    if (orderReportedRef.current) reportOrder(null);
  }, [reportOrder]);

  /** Send one RERANK for `query` and fold the validated reply. */
  const runRerank = useCallback(
    async (query: string, requestId: number): Promise<void> => {
      // `query` is non-empty (the effect guards trim), so parse cannot
      // throw; sendDecisionMessage never throws and always returns a
      // protocol-shaped result.
      const reply = await sendDecisionMessage(
        DecisionMessage.parse({ type: "RERANK", query }),
      );
      if (requestId !== requestRef.current) return; // superseded — drop
      if (!reply.ok) {
        reportLocalOrder();
        setReplyNote({ query, note: { kind: "error", message: reply.message } });
        return;
      }
      if (reply.code !== "rerank_ok") {
        reportLocalOrder();
        setReplyNote({
          query,
          note: { kind: "error", message: UNEXPECTED_REPLY_MESSAGE },
        });
        return;
      }
      const summary = reply.result;
      if (!summary.sent) {
        reportLocalOrder();
        setReplyNote({
          query,
          note: {
            kind: "skipped",
            reason: summary.reason === "blocklisted" ? "blocklisted" : "empty",
          },
        });
        return;
      }
      // Local ids, ordered by probability desc (stable sort keeps the
      // worker's own tie order).
      const ids = [...summary.results]
        .sort((a, b) => b.probability - a.probability)
        .map((entry) => entry.id);
      reportOrder(ids);
      setReplyNote({
        query,
        note:
          summary.noMatch === true
            ? { kind: "no-match" }
            : { kind: "ranked" },
      });
    },
    [reportLocalOrder, reportOrder],
  );

  /** A query this hook may rerank: Ask on, consent present, non-blank. */
  const active = askOn && consent && query.trim() !== "";

  useEffect(() => {
    if (!active) {
      // Reset: invalidate any in-flight reply and restore local order —
      // but only if a reranked order was ever reported, so the effect's
      // mount run (and every keystroke with Ask off) stays silent.
      requestRef.current += 1;
      reportLocalOrder();
      return;
    }
    // A fresh query invalidates the previous order (it belongs to other
    // results) and every older in-flight reply; the debounced send below
    // carries this run's id. The dispatch carries the TRIMMED query — the
    // provider never sees stray whitespace, and the reply is tagged with
    // the same trimmed form the render-time note compares against.
    const requestId = ++requestRef.current;
    const settled = query.trim();
    reportLocalOrder();
    const timer = setTimeout(() => {
      void runRerank(settled, requestId);
    }, debounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, debounceMs, query, reportLocalOrder, runRerank]);

  // Derived (render-time) note: idle when inactive, the accepted reply's
  // note while it still answers the current query (compared TRIMMED — the
  // raw input may hold trailing whitespace the dispatch never sent), else
  // "asking".
  const note: AskNote = !active
    ? { kind: "idle" }
    : replyNote !== null && replyNote.query === query.trim()
      ? replyNote.note
      : { kind: "asking" };

  const toggleAsk = useCallback((): void => {
    setAskOn((on) => !on);
  }, []);

  return { consent, askOn, toggleAsk, note };
}
