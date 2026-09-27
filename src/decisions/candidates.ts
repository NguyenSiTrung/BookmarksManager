import { groupDuplicates } from "../duplicates/group";
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
 * Jaccard similarity two title token sets must reach (inclusive) before a
 * same-domain pair is worth a Jev score question. 0.5 means "the majority of
 * the combined vocabulary is shared" — loose enough to catch reworded dupes,
 * strict enough to skip merely-same-topic pages.
 */
export const NEAR_DUPLICATE_TITLE_THRESHOLD = 0.5;

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
): TagCandidate[] {
  const wanted = subjectTokens(subject);
  const domainUse = domainTagCounts(subject, corpus);

  const seen = new Set<string>();
  const scored: TagCandidate[] = [];
  for (const def of tagDefs) {
    // nameKeys are unique per library; on malformed input the first def wins.
    if (seen.has(def.nameKey)) continue;
    seen.add(def.nameKey);
    const tagTokens = tokenSet(def.name);
    for (const t of tokenSet(def.description ?? "")) tagTokens.add(t);
    const score = overlap(wanted, tagTokens) + (domainUse.get(def.nameKey) ?? 0);
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
): FolderCandidateSet {
  const wanted = subjectTokens(subject);
  const scored: FolderCandidate[] = [];
  for (const folder of tree.folders.values()) {
    if (!eligibleFolder(folder)) continue;
    scored.push(toFolderCandidate(folder, wanted));
  }
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      compareStrings(pathKey(x.path), pathKey(y.path)) ||
      compareStrings(x.id, y.id),
  );
  return {
    candidates: scored.slice(0, FOLDER_CANDIDATE_LIMIT),
    none: NONE_FOLDER_OPTION,
  };
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
): FolderCandidateSet {
  const set = folderCandidates(item, tree);
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
      ...toFolderCandidate(current, subjectTokens(item)),
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
 *  - the pair does NOT appear inside any `groupDuplicates` output. Because
 *    exclusion runs the real detector, every exact-URL or normalized-URL
 *    duplicate pair is dropped with the same semantics the local scan uses.
 *
 * Output is deterministic: pairs sort by similarity (desc) then `(a.id,
 * b.id)`, and each pair's `a` is the lexicographically smaller id.
 */
export function nearDuplicatePairs(
  bookmarks: readonly NearDuplicateSource[],
): NearDuplicatePair[] {
  // Every unordered pair inside an emitted duplicate group is already
  // answered locally — collect them for exclusion.
  const caught = new Set<string>();
  for (const group of groupDuplicates(bookmarks)) {
    const ids = group.items.map((item) => item.id);
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      if (a === undefined) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j];
        if (b === undefined) continue;
        caught.add(pairKey(a, b));
      }
    }
  }

  // "Same domain" is a precondition — bucket once, then compare within.
  const byDomain = new Map<string, NearDuplicateSource[]>();
  for (const item of bookmarks) {
    const domain = extractDomain(item.url);
    if (domain === "") continue;
    const bucket = byDomain.get(domain);
    if (bucket === undefined) {
      byDomain.set(domain, [item]);
    } else {
      bucket.push(item);
    }
  }

  const pairs: NearDuplicatePair[] = [];
  for (const [domain, bucket] of byDomain) {
    for (let i = 0; i < bucket.length; i++) {
      const first = bucket[i];
      if (first === undefined) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        const second = bucket[j];
        if (second === undefined) continue;
        if (caught.has(pairKey(first.id, second.id))) continue;
        const similarity = titleSimilarity(first.title, second.title);
        if (similarity < NEAR_DUPLICATE_TITLE_THRESHOLD) continue;
        const [a, b] =
          first.id <= second.id ? [first, second] : [second, first];
        pairs.push({
          a: toSide(a, domain),
          b: toSide(b, domain),
          titleSimilarity: similarity,
        });
      }
    }
  }

  pairs.sort(
    (x, y) =>
      y.titleSimilarity - x.titleSimilarity ||
      compareStrings(x.a.id, y.a.id) ||
      compareStrings(x.b.id, y.b.id),
  );
  return pairs;
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
function subjectTokens(subject: CandidateSubject): ReadonlySet<string> {
  const out = new Set(tokenSet(subject.title));
  for (const t of tokenSet(extractDomain(subject.url))) out.add(t);
  try {
    for (const t of tokenSet(new URL(subject.url).pathname)) out.add(t);
  } catch {
    // Unparseable URL — title + empty-domain tokens still stand.
  }
  return out;
}

/**
 * nameKey → number of `corpus` bookmarks on the subject's domain whose meta
 * row carries the tag. Empty when the subject has no real domain.
 */
function domainTagCounts(
  subject: CandidateSubject,
  corpus: TagCandidateContext,
): ReadonlyMap<string, number> {
  const domain = extractDomain(subject.url);
  const counts = new Map<string, number>();
  if (domain === "") return counts;
  const domainById = new Map<string, string>();
  for (const b of corpus.bookmarks) {
    domainById.set(b.id, extractDomain(b.url));
  }
  for (const meta of corpus.metas) {
    if (domainById.get(meta.id) !== domain) continue;
    for (const key of new Set(meta.tags)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
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

/**
 * Orientation-free id pair key — the exclusion-set membership test.
 * JSON encoding keeps the two ids unambiguous without magic separators.
 */
function pairKey(x: string, y: string): string {
  const [a, b] = x <= y ? [x, y] : [y, x];
  return JSON.stringify([a, b]);
}

function toSide(item: NearDuplicateSource, domain: string): NearDuplicateSide {
  return { id: item.id, title: item.title, url: item.url, domain };
}

/**
 * Title similarity for the near-dupe precondition: 1.0 when the normalized
 * titles are identical (covers tokenless titles like "!!!"), otherwise
 * Jaccard over lowercase word-token sets; 0 when a side has no tokens.
 */
function titleSimilarity(a: string, b: string): number {
  const na = a.trim().toLowerCase().replace(/\s+/g, " ");
  const nb = b.trim().toLowerCase().replace(/\s+/g, " ");
  if (na === nb) return 1;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const shared = overlap(ta, tb);
  return shared / (ta.size + tb.size - shared);
}

/** Code-unit compare — deterministic across locales. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
