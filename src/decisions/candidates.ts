import type { DuplicateCandidate } from "../duplicates/group";
import { extractDomain } from "../search/index";
import type { SearchHit } from "../search/index";
import { ROOT_NODE_ID } from "../sync/chrome-bookmarks";
import type {
  BookmarkItem,
  FlattenedTree,
  FolderNode,
} from "../sync/tree";
import type { BookmarkMeta, TagDef } from "../schemas/meta";
import { planNearDuplicates } from "./near-duplicate-plan";

// The near-duplicate planner owns these bounds; re-exported here so callers
// keep importing the selector's public surface from this module.
export {
  NEAR_DUPLICATE_COMPARISON_LIMIT,
  NEAR_DUPLICATE_PAIR_LIMIT,
  NEAR_DUPLICATE_TITLE_THRESHOLD,
} from "./near-duplicate-plan";
export type { NearDuplicatePlan } from "./near-duplicate-plan";

/**
 * Candidate pre-filters for Jev decision requests (spec FR3, plan §9.1/§9.4).
 *
 * Each exported selector turns library data the caller already has (a
 * flattened tree, tag defs, meta rows, a `runQuery` result) into the small,
 * ranked shortlist a question set may place in `DecisionState`. Ranking is a
 * cheap lexical heuristic — token overlap plus tag⇄domain co-occurrence — so
 * Jev spends its judgment on plausible options instead of the whole library.
 *
 * Contract shared by every selector:
 *
 *  - **Pure and deterministic.** No `chrome`, DOM, React, or `fetch`. The
 *    same input always produces the same output: all rankings end in a stable
 *    tie-break (nameKey / path / id) so snapshots and question option keys
 *    are reproducible.
 *  - **Top-N, not a threshold filter.** With fewer candidates than the cap
 *    the whole pool is returned — including zero-overlap entries. A missing
 *    lexical match does not prove a bad semantic fit, and the `none` folder
 *    option (plus Jev's own judgment) covers the no-fit case.
 *  - **Code-side fields only.** `score`/`titleSimilarity` document *why* a
 *    candidate ranked, for debugging and tests. Nothing here computes or
 *    emits ages, counts, or date comparisons for the state payload (§2.3);
 *    the pipeline decides which fields reach `DecisionState`.
 */

// ---------------------------------------------------------------------------
// Limits and shared input shapes
// ---------------------------------------------------------------------------

/** Max tag candidates per request (one noul each) — spec FR3 / plan §9.1. */
export const TAG_CANDIDATE_LIMIT = 30;

/** Max folder candidates per request (one choice) — spec FR3 / plan §9.1. */
export const FOLDER_CANDIDATE_LIMIT = 50;

/** Max rerank candidates per "Ask" query — spec FR3 / plan §9.4. */
export const RERANK_CANDIDATE_LIMIT = 30;

/**
 * Option key of the always-present "none of these" folder choice. It is a
 * sentinel, never a folder id — question sets add it to their options with
 * their own description text.
 */
export const NONE_FOLDER_OPTION = "none";

/**
 * The bookmark a decision is about, reduced to the metadata the selectors
 * read. `BookmarkItem` satisfies this structurally; `misfiledCandidates`
 * additionally needs the node's `parentId`, so it takes `BookmarkItem`.
 */
export interface CandidateSubject {
  title: string;
  url: string;
}

/**
 * Library context for the tag selector's domain-overlap signal: which tags
 * are already used on the subject's domain. `DuplicateCandidate` is reused
 * as the minimal `{id, url}` bookmark shape; `metas` supply the nameKeys.
 * The subject itself may appear in `bookmarks`/`metas` — its own tags count
 * toward domain usage like any other row.
 */
export interface TagCandidateContext {
  readonly bookmarks: readonly DuplicateCandidate[];
  readonly metas: readonly BookmarkMeta[];
}

/** Minimal bookmark shape the near-duplicate scan reads. */
export interface NearDuplicateSource extends DuplicateCandidate {
  title: string;
}

// ---------------------------------------------------------------------------
// Candidate types
// ---------------------------------------------------------------------------

/**
 * One tag offered to a "is the bookmark mainly about this?" noul.
 * `nameKey` is the stable option identity (it survives renames — the same
 * key `BookmarkMeta.tags` stores); `name`/`description` are display text.
 */
export interface TagCandidate {
  /** The tag's case-insensitive uniqueness key — the option key. */
  nameKey: string;
  /** Display name, shown to Jev in the noul instructions. */
  name: string;
  /** The tag's meaning text, when the def carries one. */
  description?: string;
  /**
   * Code-side ranking detail: keyword-token overlap plus the number of
   * same-domain bookmarks already carrying the tag. Never sent to Jev.
   */
  score: number;
}

/**
 * One folder offered to a placement/misfiled choice question. `id` is the
 * option key; `path` (ancestor titles plus the folder's own) becomes the
 * option's description once joined (e.g. `"Bookmarks bar / Dev / Rust"`).
 */
export interface FolderCandidate {
  /** Folder node id — the option key. */
  id: string;
  /** Ancestor titles topmost-first plus this folder's own title. */
  path: string[];
  /** Code-side ranking detail: path-token overlap with the subject. */
  score: number;
  /**
   * Present only in `misfiledCandidates` results: `true` on the bookmark's
   * current folder (the "already correctly filed" option).
   */
  current?: boolean;
}

/**
 * The folder option list for placement and misfiled questions: a ranked
 * shortlist plus the guaranteed `none` fallback. Option keys are
 * `[...candidates.map(c => c.id), none]`.
 */
export interface FolderCandidateSet {
  /** Similarity-ranked folders; `id` is the option key, `path` the description. */
  candidates: FolderCandidate[];
  /** Always `NONE_FOLDER_OPTION` — the choice never forces a bad folder. */
  none: typeof NONE_FOLDER_OPTION;
}

/** One side of a near-duplicate pair: the metadata Jev compares. */
export interface NearDuplicateSide {
  id: string;
  title: string;
  url: string;
  /** Hostname via `extractDomain` — the domain both sides share. */
  domain: string;
}

/**
 * A same-domain, similar-titled bookmark pair the local duplicate detector
 * could NOT settle — the input to one "do `a` and `b` point to the same
 * content?" score question. `a.id < b.id` canonically, so a pair is
 * orientation-free.
 */
export interface NearDuplicatePair {
  a: NearDuplicateSide;
  b: NearDuplicateSide;
  /** Code-side detail: the Jaccard similarity that qualified the pair. */
  titleSimilarity: number;
}

/**
 * One MiniSearch hit offered to a "does `bookmark` match `query`?" noul —
 * the same metadata shape a `bookmark` state field carries.
 */
export interface RerankCandidate {
  id: string;
  title: string;
  url: string;
  domain: string;
}


/**
 * Precomputed library index for candidate selection (P-01a): built once per
 * `AnalysisContext` so per-bookmark candidate selection runs in O(T + F)
 * instead of re-scanning all corpus bookmarks, metas, and folders per item.
 */
export interface PrecomputedAnalysisIndex {
  /** domain -> (tagNameKey -> count of corpus bookmarks on that domain carrying the tag). */
  readonly domainTagFreq: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Unique tagDefs in library order with pre-tokenized name+description sets. */
  readonly tagEntries: readonly {
    readonly def: TagDef;
    readonly tokens: ReadonlySet<string>;
  }[];
  /** Eligible folders with precomputed full path, pathKey, and token sets. */
  readonly folderEntries: readonly {
    readonly id: string;
    readonly path: string[];
    readonly pathKey: string;
    readonly tokens: ReadonlySet<string>;
  }[];
}

/**
 * Build a {@link PrecomputedAnalysisIndex} in a single pass over `tagDefs`,
 * `corpus`, and `tree`, and seed the per-input WeakMap caches.
 */
export function buildPrecomputedAnalysisIndex(input: {
  readonly tagDefs: readonly TagDef[];
  readonly corpus: TagCandidateContext;
  readonly tree: FlattenedTree;
}): PrecomputedAnalysisIndex {
  const domainTagFreq = buildDomainTagFreq(input.corpus);
  const tagEntries = buildTagEntries(input.tagDefs);
  const folderEntries = buildFolderEntries(input.tree);
  domainTagFreqCache.set(input.corpus, domainTagFreq);
  tagEntriesCache.set(input.tagDefs, tagEntries);
  folderEntriesCache.set(input.tree, folderEntries);
  return { domainTagFreq, tagEntries, folderEntries };
}
// ---------------------------------------------------------------------------
// Tag selector
// ---------------------------------------------------------------------------

/**
 * The top {@link TAG_CANDIDATE_LIMIT} existing tags for `subject`, ranked by
 * (a) keyword overlap — shared lowercase word tokens between the tag's
 * name+description and the subject's title, domain, and URL path — plus
 * (b) domain overlap: the number of `corpus` bookmarks on the subject's
 * domain whose meta row already carries the tag. Ties break by `nameKey`.
 */
export function tagCandidates(
  subject: CandidateSubject,
  tagDefs: readonly TagDef[],
  corpus: TagCandidateContext,
  precomputed?: PrecomputedAnalysisIndex,
): TagCandidate[] {
  const { domain, tokens: wanted } = parseSubject(subject);
  const entries = precomputed?.tagEntries ?? getTagEntries(tagDefs);
  if (entries.length === 0) return [];
  const freq =
    domain === ""
      ? undefined
      : (precomputed?.domainTagFreq ?? getDomainTagFreq(corpus)).get(domain);

  const scored: TagCandidate[] = [];
  for (const { def, tokens: tagTokens } of entries) {
    const score = overlap(wanted, tagTokens) + (freq?.get(def.nameKey) ?? 0);
    scored.push({
      nameKey: def.nameKey,
      name: def.name,
      ...(def.description === undefined
        ? {}
        : { description: def.description }),
      score,
    });
  }

  scored.sort(
    (x, y) => y.score - x.score || compareStrings(x.nameKey, y.nameKey),
  );
  return scored.slice(0, TAG_CANDIDATE_LIMIT);
}

// ---------------------------------------------------------------------------
// Folder selectors (placement on save, misfiled scan)
// ---------------------------------------------------------------------------

/**
 * The top {@link FOLDER_CANDIDATE_LIMIT} folders for `subject`, ranked by
 * token overlap between the folder's full path (`path` + own title) and the
 * subject's title/domain/URL-path tokens. Ties break by path, then id.
 *
 * Folders that cannot accept children are never suggested: the synthetic
 * root (`"0"`) and managed folders (`isManaged` — Chrome rejects moves into
 * them, so proposing one would fail at apply time). Fixed roots like the
 * bookmarks bar remain eligible — they are real filing targets.
 */
export function folderCandidates(
  subject: CandidateSubject,
  tree: FlattenedTree,
  precomputed?: PrecomputedAnalysisIndex,
): FolderCandidateSet {
  return folderCandidatesForTokens(parseSubject(subject).tokens, tree, precomputed);
}

/**
 * The folder candidate set for the misfiled scan: identical to
 * {@link folderCandidates}, except the bookmark's *current* folder is always
 * present and marked `current: true` — it is the "no move needed" option.
 * If the current folder did not rank it is appended beyond the cap rather
 * than displacing a ranked candidate; if it did, it keeps its ranked slot.
 * The current folder is included even when managed (it is the status quo,
 * not a move target). When `item.parentId` is absent or resolves to no
 * folder in `tree` (e.g. a subtree slice), this degrades to the plain set.
 */
export function misfiledCandidates(
  item: BookmarkItem,
  tree: FlattenedTree,
  precomputed?: PrecomputedAnalysisIndex,
): FolderCandidateSet {
  const wanted = parseSubject(item).tokens;
  const set = folderCandidatesForTokens(wanted, tree, precomputed);
  const currentId = item.parentId;
  if (currentId === undefined || currentId === ROOT_NODE_ID) return set;
  const current = tree.folders.get(currentId);
  if (current === undefined) return set;

  const index = set.candidates.findIndex((c) => c.id === current.id);
  const existing = index < 0 ? undefined : set.candidates[index];
  if (existing !== undefined) {
    set.candidates[index] = { ...existing, current: true };
  } else {
    set.candidates.push({
      ...toFolderCandidate(current, wanted),
      current: true,
    });
  }
  return set;
}

// ---------------------------------------------------------------------------
// Near-duplicate selector
// ---------------------------------------------------------------------------

/**
 * Same-domain, similar-titled bookmark pairs for Jev's "same content?" score
 * — exactly the pairs the local duplicate detector *cannot* settle.
 *
 * A pair qualifies when:
 *  - both URLs share one non-empty `extractDomain` host (opaque-scheme or
 *    unparseable URLs have no domain and can never pair), and
 *  - their titles reach {@link NEAR_DUPLICATE_TITLE_THRESHOLD} — Jaccard
 *    over lowercase word-token sets, or 1.0 when the normalized title
 *    strings are identical, and
 *  - the pair is not locally settled: the same raw URL (an exact group) or
 *    the same `normalizeUrl` key (a normalized group) as `groupDuplicates`
 *    would emit.
 *
 * This is the compatible wrapper over {@link planNearDuplicates}: it returns
 * the planned pairs only, dropping the plan's work accounting. Output is
 * deterministic — similarity desc, then canonical `(a.id, b.id)`, with each
 * pair's `a` the lexicographically smaller id — and bounded by
 * {@link NEAR_DUPLICATE_PAIR_LIMIT} (500). Parity with the historical
 * behavior holds only up to that cap: a library whose qualifying pairs exceed
 * it returns the top 500 even when the exhaustive scan ran (e.g. 316
 * identical-title, distinct-URL bookmarks = 49,770 comparisons, under the
 * comparison limit, but only 500 pairs returned where the pre-hardening
 * implementation returned all 49,770). Whether output or work was limited is
 * reported by the plan's `truncated` flag — this wrapper discards it; Task 5
 * persists it on the scan job.
 */
export function nearDuplicatePairs(
  bookmarks: readonly NearDuplicateSource[],
): NearDuplicatePair[] {
  return planNearDuplicates(bookmarks).pairs;
}

// ---------------------------------------------------------------------------
// Rerank selector
// ---------------------------------------------------------------------------

/**
 * The top {@link RERANK_CANDIDATE_LIMIT} results of a `runQuery` call —
 * the "Ask" shortlist Jev reranks one noul per candidate (plan §9.4). The
 * caller runs the query; this just bounds and projects the hits, preserving
 * `runQuery`'s own ordering (relevance for text queries, tree order
 * otherwise).
 */
export function rerankCandidates(
  hits: readonly SearchHit[],
): RerankCandidate[] {
  return hits.slice(0, RERANK_CANDIDATE_LIMIT).map((hit) => ({
    id: String(hit.id),
    title: hit.title,
    url: hit.url,
    domain: hit.domain,
  }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The same split MiniSearch's default tokenizer applies to text. */
const TOKEN_SPLIT = /[\n\r\p{Z}\p{P}]+/u;

/** Lowercase word tokens of `text` — title, URL piece, tag, or path segment. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(TOKEN_SPLIT)) {
    const token = raw.toLowerCase();
    if (token !== "") out.add(token);
  }
  return out;
}

/** |a ∩ b| on token sets. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

/**
 * The subject's keyword vocabulary: lowercase tokens of its title, its
 * domain (`extractDomain` — www.-stripped host), and its URL path. The URL
 * contributes real signal when titles are thin ("…/rust/async-book").
 */
function parseSubject(subject: CandidateSubject): {
  readonly domain: string;
  readonly tokens: ReadonlySet<string>;
} {
  const out = new Set(tokenSet(subject.title));
  let domain = "";
  try {
    const parsed = new URL(subject.url);
    const hostname = parsed.hostname;
    domain = hostname.startsWith("www.")
      ? hostname.slice("www.".length)
      : hostname;
    for (const t of tokenSet(domain)) out.add(t);
    for (const t of tokenSet(parsed.pathname)) out.add(t);
  } catch {
    // Unparseable URL — title + empty-domain tokens still stand.
  }
  return { domain, tokens: out };
}

const domainTagFreqCache = new WeakMap<
  TagCandidateContext,
  ReadonlyMap<string, ReadonlyMap<string, number>>
>();

const tagEntriesCache = new WeakMap<
  readonly TagDef[],
   PrecomputedAnalysisIndex["tagEntries"]
>();

const folderEntriesCache = new WeakMap<
  FlattenedTree,
  PrecomputedAnalysisIndex["folderEntries"]
>();

function buildDomainTagFreq(
  corpus: TagCandidateContext,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const freq = new Map<string, Map<string, number>>();
  if (corpus.metas.length === 0 || corpus.bookmarks.length === 0) {
    return freq;
  }
  const domainById = new Map<string, string>();
  for (const b of corpus.bookmarks) {
    domainById.set(b.id, extractDomain(b.url));
  }
  for (const meta of corpus.metas) {
    const domain = domainById.get(meta.id);
    if (domain === undefined || domain === "") continue;
    let counts = freq.get(domain);
    if (counts === undefined) {
      counts = new Map<string, number>();
      freq.set(domain, counts);
    }
    for (const key of new Set(meta.tags)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return freq;
}

function getDomainTagFreq(
  corpus: TagCandidateContext,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const cached = domainTagFreqCache.get(corpus);
  if (cached !== undefined) return cached;
  const built = buildDomainTagFreq(corpus);
  domainTagFreqCache.set(corpus, built);
  return built;
}

function buildTagEntries(
  tagDefs: readonly TagDef[],
): PrecomputedAnalysisIndex["tagEntries"] {
  const seen = new Set<string>();
  const entries: { readonly def: TagDef; readonly tokens: ReadonlySet<string> }[] = [];
  for (const def of tagDefs) {
    // nameKeys are unique per library; on malformed input the first def wins.
    if (seen.has(def.nameKey)) continue;
    seen.add(def.nameKey);
    const tokens = tokenSet(def.name);
    if (def.description !== undefined) {
      for (const t of tokenSet(def.description)) tokens.add(t);
    }
    entries.push({ def, tokens });
  }
  return entries;
}

function getTagEntries(
  tagDefs: readonly TagDef[],
): PrecomputedAnalysisIndex["tagEntries"] {
  const cached = tagEntriesCache.get(tagDefs);
  if (cached !== undefined) return cached;
  const built = buildTagEntries(tagDefs);
  tagEntriesCache.set(tagDefs, built);
  return built;
}

function buildFolderEntries(
  tree: FlattenedTree,
): PrecomputedAnalysisIndex["folderEntries"] {
  const entries: {
    readonly id: string;
    readonly path: string[];
    readonly pathKey: string;
    readonly tokens: ReadonlySet<string>;
  }[] = [];
  for (const folder of tree.folders.values()) {
    if (!eligibleFolder(folder)) continue;
    const path = fullPath(folder);
    const tokens = new Set<string>();
    for (const segment of path) {
      for (const t of tokenSet(segment)) tokens.add(t);
    }
    entries.push({
      id: folder.id,
      path,
      pathKey: pathKey(path),
      tokens,
    });
  }
  return entries;
}

function getFolderEntries(
  tree: FlattenedTree,
): PrecomputedAnalysisIndex["folderEntries"] {
  const cached = folderEntriesCache.get(tree);
  if (cached !== undefined) return cached;
  const built = buildFolderEntries(tree);
  folderEntriesCache.set(tree, built);
  return built;
}

function folderCandidatesForTokens(
  wanted: ReadonlySet<string>,
  tree: FlattenedTree,
  precomputed?: PrecomputedAnalysisIndex,
): FolderCandidateSet {
  const entries = precomputed?.folderEntries ?? getFolderEntries(tree);
  const scored = entries.map((entry) => ({
    id: entry.id,
    path: [...entry.path],
    pathKey: entry.pathKey,
    score: overlap(wanted, entry.tokens),
  }));
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      compareStrings(x.pathKey, y.pathKey) ||
      compareStrings(x.id, y.id),
  );
  return {
    candidates: scored
      .slice(0, FOLDER_CANDIDATE_LIMIT)
      .map(({ id, path, score }) => ({ id, path, score })),
    none: NONE_FOLDER_OPTION,
  };
}

/** Folders that can actually receive a moved/created bookmark. */
function eligibleFolder(folder: FolderNode): boolean {
  return folder.id !== ROOT_NODE_ID && !folder.isManaged;
}

/** `path` (ancestor titles) + own title → the folder's full display path. */
function fullPath(folder: FolderNode): string[] {
  return [...folder.path, folder.title];
}

/** A folder's ranked form: full path plus its token-overlap score. */
function toFolderCandidate(
  folder: FolderNode,
  wanted: ReadonlySet<string>,
): FolderCandidate {
  const path = fullPath(folder);
  const tokens = new Set<string>();
  for (const segment of path) {
    for (const t of tokenSet(segment)) tokens.add(t);
  }
  return { id: folder.id, path, score: overlap(wanted, tokens) };
}

/** Sortable, separator-safe rendering of a path for tie-breaking. */
function pathKey(path: readonly string[]): string {
  return path.join("\u001f");
}

/** Code-unit compare — deterministic across locales. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
