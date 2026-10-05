import { listMeta, listTags, META_CHANGED_CHANNEL } from "../db/meta";
import { getTree } from "../sync/chrome-bookmarks";
import { flattenTree } from "../sync/tree";
import { openBookmarkUrl } from "../sync/tabs";
import type { OpenUrlDisposition } from "../sync/tabs";
import { isOpenableUrl } from "./openable";
import { buildSearchHandle, runQuery } from "./run";
import type { SearchIndexHandle } from "./run";

/**
 * The `bm` omnibox keyword (PROJECT_PLAN §5.1 Phase 3). Zero egress and
 * zero persistence: queries resolve against {@link sharedSearchIndex}, a
 * worker-lifetime index built lazily on first demand and invalidated on
 * bookmark/meta change events (D14). Session state (`session`,
 * `contents`) still drops on `onInputEntered`/`onInputCancelled` — the
 * typed query lives only for the interaction.
 *
 * Suggestions (`chrome.omnibox.SuggestResult`) are capped at
 * {@link OMNIBOX_LIMIT} and parse as a small XML dialect supporting
 * `<match>`/`<dim>`/`<url>` — every user-derived string (title, URL) is
 * XML-escaped via {@link escapeXml} before interpolation, or a bookmark
 * named `<dim>` would become live markup. `content` is the hit URL; when
 * the entered text IS an emitted content string Chrome hands it back
 * verbatim, so `onInputEntered` openable-checks it again before opening.
 *
 * Safety: unopenable URLs (`javascript:`, `data:`) are filtered out of
 * suggestions entirely and re-rejected at open time — entered text that
 * isn't a suggestion opens the TOP hit only when that hit is openable.
 * All four listeners are total: any failure (missing surface, rejected
 * load, dead `chrome.tabs`) is swallowed to an empty suggest / no-op open.
 * Nothing here logs — the omnibox must never leak query or bookmark data
 * into the console.
 */

export const OMNIBOX_LIMIT = 8;

/**
 * The omnibox index never indexes `notes` (D14): notes are long-form text
 * whose tokens dominate the index for little suggestion value — title,
 * tags, domain, and url carry every useful hit. The panel's live index
 * keeps the full field set; this session-scoped view does not.
 */
const OMNIBOX_INDEXED_FIELDS = ["title", "tags", "domain", "url"];

/** `chrome.omnibox.SuggestResult`, redeclared so this module is chrome-free. */
export interface SuggestResult {
  /** What Chrome passes back to `onInputEntered` — the hit URL here. */
  content: string;
  /** XML-dialect description line; user-derived parts are escaped. */
  description: string;
}

interface OmniboxEvent<A extends unknown[]> {
  addListener(callback: (...args: A) => void): void;
}

/**
 * The subset of `chrome.omnibox` this module needs. Declared structurally
 * (not via `@types/chrome`) so tests inject a fake and the MV3 worker's
 * lazy global lookup stays decoupled from the type surface.
 */
export interface OmniboxSurface {
  setDefaultSuggestion?(suggestion: { description: string }): void;
  onInputStarted: OmniboxEvent<[]>;
  onInputChanged: OmniboxEvent<
    [text: string, suggest: (results: SuggestResult[]) => void]
  >;
  onInputEntered: OmniboxEvent<
    [text: string, disposition: string]
  >;
  onInputCancelled: OmniboxEvent<[]>;
}

/**
 * Injectable dependencies — production wires the real loaders/openers,
 * tests drive fakes. `load` builds the session index; `open` performs the
 * tab operation for a disposition.
 */
export interface OmniboxDeps {
  load(): Promise<SearchIndexHandle | null>;
  open(url: string, disposition: OpenUrlDisposition): unknown;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escape the five characters Chrome's omnibox description dialect treats
 * as markup. Applied to every user-derived string — titles and URLs are
 * attacker-controllable (import a bookmark named `<match>` and unescaped
 * markup lands in Chrome UI).
 */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/**
 * Map a query to `SuggestResult`s: top `limit` OPENABLE hits, each with
 * `content` = URL and an escaped `title — <url>url</url>` description.
 * Openable-filtering here means an unopenable bookmark is never even
 * selectable — defense in depth alongside the open-time re-check.
 */
export function toSuggestions(
  handle: SearchIndexHandle,
  text: string,
  limit = OMNIBOX_LIMIT,
): SuggestResult[] {
  const out: SuggestResult[] = [];
  for (const hit of runQuery(handle.index, text, handle.ctx).hits) {
    if (!isOpenableUrl(hit.url)) continue;
    out.push({
      content: hit.url,
      description: `${escapeXml(hit.title)} — <url>${escapeXml(hit.url)}</url>`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the session index from the live tree + meta rows (notes are
 * excluded from the index, D14). Total: any failure (dead bookmarks
 * surface, closed DB) yields `null`, which the listeners translate to
 * "no suggestions".
 */
export async function loadSessionIndex(): Promise<SearchIndexHandle | null> {
  try {
    const [rawTree, metas, tagDefs] = await Promise.all([
      getTree(),
      listMeta(),
      listTags(),
    ]);
    return buildSearchHandle(
      flattenTree(rawTree),
      metas,
      tagDefs,
      OMNIBOX_INDEXED_FIELDS,
    );
  } catch {
    return null;
  }
}

/** Chrome disposition → our open slice; unknown values open foreground. */
function mapDisposition(disposition: string): OpenUrlDisposition {
  if (disposition === "currentTab") return "current";
  if (disposition === "newBackgroundTab") return "background";
  return "foreground";
}

/** The openable top hit for free text, or `null`. Never throws. */
function topOpenableUrl(
  handle: SearchIndexHandle | null,
  text: string,
): string | null {
  try {
    if (handle === null) return null;
    const hit = runQuery(handle.index, text, handle.ctx).hits[0];
    return hit !== undefined && isOpenableUrl(hit.url) ? hit.url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared worker-lifetime index (D14)
// ---------------------------------------------------------------------------

/**
 * One cached index build for the worker's lifetime. Omnibox sessions used
 * to rebuild the tree+meta index per interaction; the shared handle is
 * built lazily on first demand and REUSED across sessions until an event
 * bumps {@link indexGeneration} — bookmark changes land via
 * {@link invalidateSearchIndex} (called by the sync listeners) and meta
 * changes via the {@link META_CHANGED_CHANNEL} BroadcastChannel (posted
 * by the meta repository, reachable from any extension context).
 */
let indexGeneration = 0;
let sharedIndex: {
  generation: number;
  promise: Promise<SearchIndexHandle | null>;
} | null = null;
let metaChangedListener: BroadcastChannel | null | undefined;

/**
 * Mark the shared index stale. The next {@link sharedSearchIndex} call
 * rebuilds lazily — a handle issued before the bump is never served by a
 * later call (generation checked on access, not eagerly dropped).
 */
export function invalidateSearchIndex(): void {
  indexGeneration += 1;
}

/**
 * Subscribe once to the meta-changed channel. Constructed lazily (the
 * first shared build) so importing this module in a context without
 * BroadcastChannel stays a no-op.
 */
function ensureMetaChangedListener(): void {
  if (metaChangedListener !== undefined) return;
  try {
    metaChangedListener = new BroadcastChannel(META_CHANGED_CHANNEL);
    metaChangedListener.onmessage = invalidateSearchIndex;
  } catch {
    metaChangedListener = null;
  }
}

/**
 * The worker-lifetime session index. Build is lazy: the first caller
 * after a generation bump pays for `loadSessionIndex`, everyone else
 * awaits the same promise. `ensure` inside {@link registerOmnibox} uses
 * this as the default `deps.load`.
 */
export function sharedSearchIndex(): Promise<SearchIndexHandle | null> {
  ensureMetaChangedListener();
  if (sharedIndex === null || sharedIndex.generation !== indexGeneration) {
    const generation = indexGeneration;
    const promise = loadSessionIndex().catch((): null => null);
    sharedIndex = { generation, promise };
    // A failed build resolves `null` — drop it so the next call retries
    // instead of serving dead suggestions for the whole generation.
    void promise.then((handle) => {
      if (handle === null && sharedIndex?.promise === promise) {
        sharedIndex = null;
      }
    });
  }
  return sharedIndex.promise;
}

/** Lazy `chrome.omnibox` lookup — absent on Firefox and in tests. */
function omniboxApi(): OmniboxSurface | undefined {
  try {
    return (globalThis as { chrome?: { omnibox?: OmniboxSurface } }).chrome
      ?.omnibox;
  } catch {
    return undefined;
  }
}

/**
 * Wire the four omnibox listeners. `omnibox` defaults to the lazy global
 * (callers pass nothing in the worker, a fake in tests); a missing surface
 * is a no-op so registration is safe on any browser.
 *
 * Session lifecycle:
 *   started   → drop any stale session, kick a fresh build, set the static
 *               default suggestion
 *   changed   → await the (possibly in-flight) session, suggest ≤8 hits;
 *               builds lazily if the start event was missed
 *   entered   → drop the session; open the entered URL if openable, else
 *               the query's top openable hit; never throws
 *   cancelled → drop the session
 */
export function registerOmnibox(
  omnibox: OmniboxSurface | undefined = omniboxApi(),
  deps: Partial<OmniboxDeps> = {},
): void {
  if (omnibox === undefined) return;
  const load = deps.load ?? sharedSearchIndex;
  const open =
    deps.open ??
    ((url: string, disposition: OpenUrlDisposition): void => {
      void openBookmarkUrl(url, disposition);
    });

  /** In-flight or resolved session handle; `null` between sessions. */
  let session: Promise<SearchIndexHandle | null> | null = null;
  /**
   * Content strings emitted this session. `onInputEntered` receives the
   * picked suggestion's `content` verbatim, so membership here is what
   * distinguishes "user selected a suggestion" from "free text" — the URL
   * guard alone can't (the denylist passes bare words like "fish").
   */
  let contents = new Set<string>();

  const ensure = (): Promise<SearchIndexHandle | null> => {
    session ??= Promise.resolve()
      .then(load)
      .catch((): null => null);
    return session;
  };

  const drop = (): void => {
    session = null;
    contents = new Set();
  };

  omnibox.onInputStarted.addListener(() => {
    try {
      drop();
      void ensure();
      omnibox.setDefaultSuggestion?.({
        description: "Search bookmarks — Enter opens the top result",
      });
    } catch {
      // Total: a bad surface must never break the listener contract.
    }
  });

  omnibox.onInputChanged.addListener((text, suggest) => {
    void ensure()
      .then((handle) => {
        try {
          const results = handle === null ? [] : toSuggestions(handle, text);
          contents = new Set(results.map((result) => result.content));
          suggest(results);
        } catch {
          // A throwing suggest callback (dead channel) is swallowed.
        }
      })
      .catch(() => {
        try {
          suggest([]);
        } catch {
          // Swallow: totality beats an empty dropdown.
        }
      });
  });

  omnibox.onInputEntered.addListener((text, disposition) => {
    const pending = session;
    const emitted = contents.has(text);
    drop();
    void (async () => {
      try {
        const trimmed = text.trim();
        if (trimmed === "") return;
        let target: string | null;
        if (emitted && isOpenableUrl(trimmed)) {
          target = trimmed;
        } else {
          // Free text (or an unemitted/unopenable string): resolve the top
          // hit. `pending ?? load()` covers a missed start event.
          const handle = await (pending ??
            Promise.resolve()
              .then(load)
              .catch((): null => null));
          target = topOpenableUrl(handle, trimmed);
        }
        if (target === null) return;
        await open(target, mapDisposition(disposition));
      } catch {
        // Total: omnibox opens are best-effort, never thrown into Chrome.
      }
    })();
  });

  omnibox.onInputCancelled.addListener(() => {
    drop();
  });
}
