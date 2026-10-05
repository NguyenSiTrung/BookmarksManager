import MiniSearch from "minisearch";
import type { Query } from "minisearch";
import { groupDuplicates } from "../duplicates/group";
import type { DuplicateCandidate } from "../duplicates/group";
import type { Category } from "../schemas/bookmark";
import { parseQuery } from "./query";
import type {
  DateBound,
  IsFlag,
  ParsedQuery,
  QueryFilter,
  QueryWarning,
} from "./query";
import type { SearchHit, SearchIndex } from "./index";
import {
  buildTagNameMap,
  createSearchIndex,
  toSearchDocument,
  toSourceBookmark,
} from "./index";
import type { BookmarkMeta, TagDef } from "../schemas/meta";
import type { FlattenedTree } from "../sync/tree";

/**
 * Query executor for the search language (spec §1–§2). `runQuery` runs a
 * `ParsedQuery` — or a raw query string, which is parsed with
 * {@link parseQuery} — against a `SearchIndex` and returns the matching
 * `SearchHit`s plus the parser warnings so the UI can render them inline.
 * Pure: no `chrome`, DOM, or React — safe in workers, entrypoints, tests.
 *
 * Matching semantics:
 *
 *  - **Positive free-text terms** are ANDed by MiniSearch with the index
 *    defaults (prefix + fuzzy). A `term.text` containing spaces — possible
 *    when a quoted segment was embedded in a larger token (`a"b c"d`) — is
 *    passed through verbatim; its words AND like separate terms.
 *  - **`exact` terms** (a fully quoted token) must match the literal
 *    phrase. MiniSearch has no positional index, so the phrase words are
 *    matched as exact tokens (a per-subquery `prefix: false, fuzzy: false`
 *    — MiniSearch's word-level "quoted" behavior) and each hit is then
 *    verified: the words must co-occur in one indexed field AND the literal
 *    phrase must appear in that field's stored text — `title`, `url`,
 *    `domain`, and `tags` (checked via `tagKeys`, the lowercase nameKeys).
 *    A phrase whose words share only `notes` is kept unverified: `notes` is
 *    indexed but not stored, so adjacency cannot be disproved — recall over
 *    precision. The same predicate decides exclusion for negated phrases.
 *  - **Negated terms** exclude: each is searched on its own (exact ones
 *    verified like above) and its hits are subtracted from the result.
 *  - **Filters:** `tag:` values AND (a doc must carry every one);
 *    `folder:`/`domain:`/`category:` values OR within their key; different
 *    keys always AND; `negated` inverts the individual filter.
 *    `before:`/`after:` bounds resolve in LOCAL time — `after:` includes
 *    the period (`dateAdded >=` its start), `before:` excludes it
 *    (`dateAdded <` its start); a bookmark with no `dateAdded` never
 *    matches a positive date filter and always matches a negated one.
 *    `is:duplicate` checks `ctx.duplicateIds`; `is:untagged` means an
 *    empty `tagKeys` list. A `folder:` value containing `/` matches a
 *    contiguous ancestor-title path (`folder:dev/rust` needs "Dev","Rust"
 *    adjacent in that order); a `domain:` value matches the host or any
 *    subdomain, ignoring a leading `www.` on either side.
 *
 * Ordering (spec §1): a query with at least one positive free-text term is
 * relevance-ordered (MiniSearch score). Otherwise — filter-only, all-
 * negated, or empty queries — hits follow the library's tree order, given
 * by the caller as `ctx.treeOrder`; ids absent from it sort last, in index
 * order.
 */

/**
 * A live index plus the context `runQuery` needs — the shape index-owning
 * hooks (`useSearchIndex`) and one-shot builders (omnibox session index)
 * hand to view resolution.
 */
export interface SearchIndexHandle {
  /** The live index. */
  index: SearchIndex;
  /** Per-query context for `runQuery`. */
  ctx: RunQueryContext;
}

/** Extra per-query context `runQuery` needs beyond the index. */
export interface RunQueryContext {
  /**
   * Bookmark ids in library tree order (e.g. `flattenTree` order). Defines
   * the result order for queries without positive free-text terms; hits
   * whose id is absent sort after all ordered ids, in index order.
   */
  treeOrder: readonly string[];
  /**
   * Ids belonging to a duplicate group — backs `is:duplicate`. Compute once
   * per corpus change with {@link collectDuplicateIds} and reuse across
   * keystrokes; when absent, `is:duplicate` matches nothing.
   */
  duplicateIds?: ReadonlySet<string>;
}

/**
 * One-shot handle builder for surfaces that own a whole index rather than
 * subscribing to a live one — the omnibox session build and tests. Maps
 * every bookmark through {@link toSourceBookmark} (the same source mapping
 * `useSearchIndex` uses), adds all documents to a fresh index, and derives
 * `ctx` (`treeOrder` + `duplicateIds`) from the same tree.
 */
export function buildSearchHandle(
  tree: FlattenedTree,
  metas: readonly BookmarkMeta[],
  tagDefs: readonly TagDef[],
  indexedFields?: readonly string[],
): SearchIndexHandle {
  const tagNames = buildTagNameMap(tagDefs);
  const metaById = new Map(metas.map((meta) => [meta.id, meta]));
  const index = createSearchIndex(indexedFields);
  index.addAll(
    [...tree.bookmarks.values()].map((item) =>
      toSearchDocument(toSourceBookmark(tree, item, metaById.get(item.id)), tagNames)
    ),
  );
  const bookmarks = [...tree.bookmarks.values()];
  return {
    index,
    ctx: {
      treeOrder: bookmarks.map((item) => item.id),
      duplicateIds: collectDuplicateIds(bookmarks),
    },
  };
}

export interface RunQueryResult {
  /** Matching documents: relevance order for text queries, tree order else. */
  hits: SearchHit[];
  /** Parser warnings for the query, echoed through for inline display. */
  warnings: QueryWarning[];
}

/**
 * All member ids of every duplicate group over `candidates` — the set
 * `ctx.duplicateIds` expects. Wraps {@link groupDuplicates}: callers pass
 * the same `{ id, url }` items they'd group (bookmark rows qualify).
 */
export function collectDuplicateIds(
  candidates: readonly DuplicateCandidate[],
): Set<string> {
  const ids = new Set<string>();
  for (const group of groupDuplicates(candidates)) {
    for (const item of group.items) {
      ids.add(item.id);
    }
  }
  return ids;
}

/**
 * Runs `query` against `index`. `query` may be a raw string (parsed here —
 * the warnings come back on the result) or a `ParsedQuery` from a caller
 * that already parsed for autocomplete/display.
 */
export function runQuery(
  index: SearchIndex,
  query: string | ParsedQuery,
  ctx: RunQueryContext,
): RunQueryResult {
  const parsed = typeof query === "string" ? parseQuery(query) : query;

  // Split terms: positive ones form one ANDed MiniSearch query (plain terms
  // first, exact subqueries last so their narrower `match` entries win the
  // result merge for terms shared with fuzzy subqueries); negated ones each
  // produce an exclusion id set.
  const plainTerms: string[] = [];
  const exactSubs: Query[] = [];
  const phrases: { words: string[]; lower: string }[] = [];
  const excluded = new Set<string>();

  for (const term of parsed.terms) {
    if (term.negated) {
      const words = termWords(term.text);
      const hits = index.search(
        term.exact ? exactTermQuery(term.text) : term.text,
      );
      for (const hit of hits) {
        if (
          !term.exact ||
          phraseVerified(hit as SearchHit, words, term.text.toLowerCase())
        ) {
          excluded.add(String(hit.id));
        }
      }
    } else if (term.exact) {
      exactSubs.push(exactTermQuery(term.text));
      const words = termWords(term.text);
      if (words.length > 1) {
        phrases.push({ words, lower: term.text.toLowerCase() });
      }
    } else {
      plainTerms.push(term.text);
    }
  }

  const plan = planFilters(parsed.filters);
  const dupIds = ctx.duplicateIds;
  const accept = (hit: SearchHit): boolean =>
    !excluded.has(String(hit.id)) &&
    filtersOk(hit, plan, dupIds) &&
    phrases.every((p) => phraseVerified(hit, p.words, p.lower));

  let hits: SearchHit[];
  if (plainTerms.length + exactSubs.length > 0) {
    // Relevance path: MiniSearch returns score order already.
    const querySpec: Query = {
      combineWith: "AND",
      queries: [...plainTerms, ...exactSubs],
    };
    hits = (index.search(querySpec) as SearchHit[]).filter(accept);
  } else {
    // Term-free path: wildcard returns every doc in index order; re-sort by
    // the caller's tree order. The sort is stable, so ids missing from
    // treeOrder keep index order at the end.
    hits = (index.search(MiniSearch.wildcard) as SearchHit[]).filter(accept);
    const rank = new Map<string, number>();
    ctx.treeOrder.forEach((id, i) => {
      if (!rank.has(id)) rank.set(id, i);
    });
    hits.sort(
      (a, b) =>
        (rank.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  return { hits, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Same split MiniSearch's default tokenizer applies to text and queries. */
const TOKEN_SPLIT = /[\n\r\p{Z}\p{P}]+/u;

/**
 * The words `term.text` tokenizes to under MiniSearch defaults, lowercased
 * like `processTerm` produces — i.e. the terms the index actually matches.
 */
function termWords(text: string): string[] {
  const words: string[] = [];
  for (const word of text.split(TOKEN_SPLIT)) {
    if (word !== "") words.push(word.toLowerCase());
  }
  return words;
}

/**
 * A subquery matching `text` word-wise with exact tokens only — prefix and
 * fuzzy are disabled for just this branch. `combineWith: "AND"` keeps the
 * words conjunctive when nested inside the outer AND combination.
 */
function exactTermQuery(text: string): Query {
  return { combineWith: "AND", queries: [text], prefix: false, fuzzy: false };
}

/**
 * Stored-field text a literal phrase can be re-verified against. `tags`
 * maps to the lowercase `tagKeys` (the nameKeys track display names);
 * `notes` and any unknown field are indexed-but-unstored → undefined.
 */
function storedFieldText(hit: SearchHit, field: string): string | undefined {
  switch (field) {
    case "title":
      return hit.title;
    case "url":
      return hit.url;
    case "domain":
      return hit.domain;
    case "tags":
      return hit.tagKeys.join(" ");
    default:
      return undefined;
  }
}

/**
 * Whether `hit` contains the literal phrase `lower`. The exact subquery
 * already required every word to match as a verbatim token; for multi-word
 * phrases the words must also share one field, and that field must either
 * hold the literal phrase or be unverifiable (`notes`). A missing `match`
 * entry can't disprove anything → keep.
 */
function phraseVerified(
  hit: SearchHit,
  words: string[],
  lower: string,
): boolean {
  const unique = [...new Set(words)];
  if (unique.length <= 1) return true;

  let common: string[] | undefined;
  for (const word of unique) {
    const fields = hit.match[word];
    if (fields === undefined) return true;
    common =
      common === undefined
        ? [...fields]
        : common.filter((field) => fields.includes(field));
    if (common.length === 0) return false;
  }
  for (const field of common ?? []) {
    const text = storedFieldText(hit, field);
    if (text === undefined || text.toLowerCase().includes(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Filters pre-compiled for evaluation: OR-groups for the repeated-value
 * keys (`folder`/`domain`/`category`), all-required lists for `tag`, and
 * per-filter entries where `before:`/`after:`/`is:` AND individually.
 */
interface FilterPlan {
  tagsPos: string[];
  tagsNeg: string[];
  folderPos: string[][];
  folderNeg: string[][];
  domainPos: string[];
  domainNeg: string[];
  categoryPos: Category[];
  categoryNeg: Category[];
  dates: { after: boolean; start: number; negated: boolean }[];
  flags: { value: IsFlag; negated: boolean }[];
}

function planFilters(filters: readonly QueryFilter[]): FilterPlan {
  const plan: FilterPlan = {
    tagsPos: [],
    tagsNeg: [],
    folderPos: [],
    folderNeg: [],
    domainPos: [],
    domainNeg: [],
    categoryPos: [],
    categoryNeg: [],
    dates: [],
    flags: [],
  };
  for (const filter of filters) {
    switch (filter.key) {
      case "tag":
        (filter.negated ? plan.tagsNeg : plan.tagsPos).push(
          filter.value.trim().toLowerCase(),
        );
        break;
      case "folder":
        (filter.negated ? plan.folderNeg : plan.folderPos).push(
          folderSegments(filter.value),
        );
        break;
      case "domain":
        (filter.negated ? plan.domainNeg : plan.domainPos).push(
          normalizeDomain(filter.value),
        );
        break;
      case "category":
        (filter.negated ? plan.categoryNeg : plan.categoryPos).push(
          filter.value,
        );
        break;
      case "before":
      case "after":
        plan.dates.push({
          after: filter.key === "after",
          start: boundStart(filter.value),
          negated: filter.negated,
        });
        break;
      case "is":
        plan.flags.push({ value: filter.value, negated: filter.negated });
        break;
    }
  }
  return plan;
}

/** `folder:` value → lowercased, trimmed, non-empty path segments. */
function folderSegments(value: string): string[] {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    const cleaned = segment.trim().toLowerCase();
    if (cleaned !== "") segments.push(cleaned);
  }
  return segments;
}

/** `domain:` value → lowercased, one leading `www.` ignored. */
function normalizeDomain(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice("www.".length) : lower;
}

/** `DateBound` → the LOCAL start of its period, in ms since epoch. */
function boundStart(bound: DateBound): number {
  const month = bound.precision === "year" ? 1 : bound.month;
  const day = bound.precision === "day" ? bound.day : 1;
  // `setFullYear` (not the constructor) so years < 100 don't get the 1900
  // offset; `setHours` normalizes the epoch's local time-of-day to 00:00.
  const d = new Date(0);
  d.setFullYear(bound.year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `segments` occur contiguously, in order, among the ancestor titles. */
function folderPathMatch(
  folderTitles: readonly string[],
  segments: readonly string[],
): boolean {
  if (segments.length === 0 || segments.length > folderTitles.length) {
    return false;
  }
  const lower = folderTitles.map((title) => title.toLowerCase());
  for (let i = 0; i + segments.length <= lower.length; i++) {
    let ok = true;
    for (let j = 0; j < segments.length; j++) {
      if (lower[i + j] !== segments[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Host `domain` equals `value` or is a subdomain of it (post-www-strip). */
function domainMatch(domain: string, value: string): boolean {
  if (value === "" || domain === "") return false;
  return domain === value || domain.endsWith(`.${value}`);
}

function filtersOk(
  hit: SearchHit,
  plan: FilterPlan,
  duplicateIds: ReadonlySet<string> | undefined,
): boolean {
  return (
    plan.tagsPos.every((tag) => hit.tagKeys.includes(tag)) &&
    plan.tagsNeg.every((tag) => !hit.tagKeys.includes(tag)) &&
    (plan.folderPos.length === 0 ||
      plan.folderPos.some((segs) =>
        folderPathMatch(hit.folderTitles, segs),
      )) &&
    plan.folderNeg.every(
      (segs) => !folderPathMatch(hit.folderTitles, segs),
    ) &&
    (plan.domainPos.length === 0 ||
      plan.domainPos.some((d) => domainMatch(hit.domain, d))) &&
    plan.domainNeg.every((d) => !domainMatch(hit.domain, d)) &&
    (plan.categoryPos.length === 0 ||
      (hit.category !== undefined &&
        plan.categoryPos.includes(hit.category))) &&
    plan.categoryNeg.every((c) => hit.category !== c) &&
    plan.dates.every((d) => dateOk(d, hit.dateAdded)) &&
    plan.flags.every((f) => flagOk(f, hit, duplicateIds))
  );
}

function dateOk(
  d: { after: boolean; start: number; negated: boolean },
  dateAdded: number | undefined,
): boolean {
  const base =
    dateAdded !== undefined &&
    (d.after ? dateAdded >= d.start : dateAdded < d.start);
  return d.negated ? !base : base;
}

function flagOk(
  f: { value: IsFlag; negated: boolean },
  hit: SearchHit,
  duplicateIds: ReadonlySet<string> | undefined,
): boolean {
  const base =
    f.value === "duplicate"
      ? (duplicateIds?.has(String(hit.id)) ?? false)
      : hit.tagKeys.length === 0;
  return f.negated ? !base : base;
}
