import { normalizeUrl } from "../duplicates/normalize";
import { extractDomain } from "../search/index";
import type {
  NearDuplicatePair,
  NearDuplicateSide,
  NearDuplicateSource,
} from "./candidates";

/**
 * Bounded, deterministic near-duplicate planning (audit-hardening Phase 5
 * Task 4, improvement I06).
 *
 * The selector's earlier implementation bucketed by domain and compared
 * *every* unordered pair inside each bucket, and built its exclusion set by
 * enumerating every intra-`groupDuplicates` pair. Both are O(k²) in the size
 * of a single domain bucket, so one dominant domain (or one large
 * normalized-duplicate group) turns a library-wide scan quadratic.
 *
 * This module keeps the observable pair semantics for libraries small enough
 * to scan exhaustively, but bounds the work of large ones:
 *
 *  - Local-duplicate exclusion is a constant-time test per pair (`same raw
 *    URL` or `same normalized URL`) instead of a precomputed pair set, so a
 *    5000-member duplicate group costs one `normalizeUrl` call per item.
 *  - When the exhaustive within-domain pair count exceeds
 *    {@link NEAR_DUPLICATE_COMPARISON_LIMIT}, candidate pairs are generated
 *    from an inverted title-token index rather than every pair, and the
 *    total number of candidate attempts is capped at that limit. Every
 *    attempt counts — including pairs later dropped as local duplicates or
 *    seen twice via a shared token.
 *  - Emitted pairs are capped at {@link NEAR_DUPLICATE_PAIR_LIMIT} after a
 *    similarity/ID sort.
 *
 * `truncated` is `true` whenever the bounded path ran or the output cap
 * dropped qualifying pairs: under bounded evaluation the result is a
 * deterministic, bounded shortlist — never a claim of the globally
 * exhaustive top-K.
 *
 * The module imports only *types* from `candidates.ts`; `candidates.ts`
 * imports this module's runtime, so there is no runtime import cycle.
 */

/**
 * Jaccard similarity two title token sets must reach (inclusive) before a
 * same-domain pair is worth a Jev score question. 0.5 means "the majority of
 * the combined vocabulary is shared".
 */
export const NEAR_DUPLICATE_TITLE_THRESHOLD = 0.5;

/** Max near-duplicate pairs a plan may emit. */
export const NEAR_DUPLICATE_PAIR_LIMIT = 500;

/**
 * Max candidate pairs the planner may examine (attempts, including ones it
 * later filters or sees twice) before it stops generating candidates.
 */
export const NEAR_DUPLICATE_COMPARISON_LIMIT = 50_000;

/** The bounded near-duplicate shortlist plus its work accounting. */
export interface NearDuplicatePlan {
  /** Similarity-ranked pairs, capped at {@link NEAR_DUPLICATE_PAIR_LIMIT}. */
  pairs: NearDuplicatePair[];
  /** Candidate attempts performed while planning. */
  comparisons: number;
  /**
   * `true` when bounded evaluation or the output cap limited the result —
   * the plan is a bounded shortlist, not an exhaustive top-K.
   */
  truncated: boolean;
}

/** A bookmark reduced to the fields the planner reads, plus derived keys. */
interface Prepared {
  id: string;
  title: string;
  url: string;
  domain: string;
  /** `normalizeUrl(url)`, or `null` when the URL cannot normalize. */
  normKey: string | null;
}

/**
 * Plan the near-duplicate pairs for `bookmarks`. Pure and deterministic:
 * input ordering never changes the result, and all rankings end in stable
 * ID tie-breaks.
 */
export function planNearDuplicates(
  bookmarks: readonly NearDuplicateSource[],
): NearDuplicatePlan {
  // "Same domain" is a precondition — bucket once, and derive the per-item
  // keys the exclusion test needs while we are here.
  const byDomain = new Map<string, Prepared[]>();
  let exhaustiveComparisons = 0;
  for (const item of bookmarks) {
    const domain = extractDomain(item.url);
    if (domain === "") continue;
    const prepared: Prepared = {
      id: item.id,
      title: item.title,
      url: item.url,
      domain,
      normKey: normalizeUrl(item.url),
    };
    const bucket = byDomain.get(domain);
    if (bucket === undefined) {
      byDomain.set(domain, [prepared]);
    } else {
      bucket.push(prepared);
    }
  }

  // Sum the exhaustive within-domain pair count without enumerating pairs.
  // Stop counting once the limit is passed — only the comparison matters.
  for (const bucket of byDomain.values()) {
    const size = bucket.length;
    if (size > 1) exhaustiveComparisons += (size * (size - 1)) / 2;
    if (exhaustiveComparisons > NEAR_DUPLICATE_COMPARISON_LIMIT) break;
  }

  return exhaustiveComparisons <= NEAR_DUPLICATE_COMPARISON_LIMIT
    ? exhaustivePlan(byDomain)
    : boundedPlan(byDomain);
}

/** Full pairwise scan — the historical semantics, used under both caps. */
function exhaustivePlan(byDomain: ReadonlyMap<string, Prepared[]>): NearDuplicatePlan {
  const pairs: NearDuplicatePair[] = [];
  let comparisons = 0;
  for (const [domain, bucket] of byDomain) {
    for (let i = 0; i < bucket.length; i++) {
      const first = bucket[i];
      if (first === undefined) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        const second = bucket[j];
        if (second === undefined) continue;
        comparisons++;
        const pair = evaluate(first, second, domain);
        if (pair !== undefined) pairs.push(pair);
      }
    }
  }
  sortPairs(pairs);
  return {
    pairs: pairs.slice(0, NEAR_DUPLICATE_PAIR_LIMIT),
    comparisons,
    truncated: pairs.length > NEAR_DUPLICATE_PAIR_LIMIT,
  };
}

/**
 * Inverted-index candidate generation with a hard attempt budget. Buckets
 * and posting lists are iterated in stable ID order so the budget is spent
 * identically for any input ordering.
 */
function boundedPlan(byDomain: ReadonlyMap<string, Prepared[]>): NearDuplicatePlan {
  const pairs: NearDuplicatePair[] = [];
  const seen = new Set<string>();
  let comparisons = 0;

  const domains = [...byDomain.keys()].sort(compareStrings);
  outer: for (const domain of domains) {
    const bucket = byDomain.get(domain);
    if (bucket === undefined) continue;
    const sorted = [...bucket].sort((a, b) => compareStrings(a.id, b.id));

    // Inverted title-token index. A pair worth >= threshold always shares a
    // token (Jaccard >= 0.5 needs a shared token when both sides have any),
    // so this finds every qualifying pair except identical tokenless titles
    // — handled below.
    const postings = new Map<string, Prepared[]>();
    const tokenless: Prepared[] = [];
    for (const item of sorted) {
      const tokens = tokenSet(item.title);
      if (tokens.size === 0) {
        tokenless.push(item);
        continue;
      }
      for (const token of tokens) {
        const list = postings.get(token);
        if (list === undefined) {
          postings.set(token, [item]);
        } else {
          list.push(item);
        }
      }
    }

    const tokens = [...postings.keys()].sort(compareStrings);
    for (const token of tokens) {
      const list = postings.get(token);
      if (list === undefined) continue;
      for (let i = 0; i < list.length; i++) {
        const first = list[i];
        if (first === undefined) continue;
        for (let j = i + 1; j < list.length; j++) {
          const second = list[j];
          if (second === undefined) continue;
          if (comparisons >= NEAR_DUPLICATE_COMPARISON_LIMIT) break outer;
          comparisons++;
          consider(pairs, seen, first, second, domain);
        }
      }
    }

    // Identical tokenless titles (e.g. "!!!") reach similarity 1 without a
    // shared token; group them by normalized title so they still pair.
    const tokenlessGroups = new Map<string, Prepared[]>();
    for (const item of tokenless) {
      const key = normalizeTitle(item.title);
      const group = tokenlessGroups.get(key);
      if (group === undefined) {
        tokenlessGroups.set(key, [item]);
      } else {
        group.push(item);
      }
    }
    for (const group of tokenlessGroups.values()) {
      for (let i = 0; i < group.length; i++) {
        const first = group[i];
        if (first === undefined) continue;
        for (let j = i + 1; j < group.length; j++) {
          const second = group[j];
          if (second === undefined) continue;
          if (comparisons >= NEAR_DUPLICATE_COMPARISON_LIMIT) break outer;
          comparisons++;
          consider(pairs, seen, first, second, domain);
        }
      }
    }
  }

  sortPairs(pairs);
  return {
    pairs: pairs.slice(0, NEAR_DUPLICATE_PAIR_LIMIT),
    comparisons,
    // Bounded evaluation always limited coverage relative to exhaustive.
    truncated: true,
  };
}

/** Record one candidate attempt: dedupe, exclude local dupes, score. */
function consider(
  pairs: NearDuplicatePair[],
  seen: Set<string>,
  first: Prepared,
  second: Prepared,
  domain: string,
): void {
  const key = pairKey(first.id, second.id);
  if (seen.has(key)) return;
  seen.add(key);
  const pair = evaluate(first, second, domain);
  if (pair !== undefined) pairs.push(pair);
}

/** Score and canonicalize one candidate pair, or `undefined` if it fails. */
function evaluate(
  first: Prepared,
  second: Prepared,
  domain: string,
): NearDuplicatePair | undefined {
  if (locallyCaught(first, second)) return undefined;
  const similarity = titleSimilarity(first.title, second.title);
  if (similarity < NEAR_DUPLICATE_TITLE_THRESHOLD) return undefined;
  const [a, b] = first.id <= second.id ? [first, second] : [second, first];
  return { a: toSide(a, domain), b: toSide(b, domain), titleSimilarity: similarity };
}

/**
 * Constant-time membership test for the pairs the local detector already
 * settles: same raw URL (an exact group) or same {@link normalizeUrl} key
 * (a normalized group). This is equivalent to the historical
 * enumerate-every-intra-group-pair set, without the O(k²) build.
 */
function locallyCaught(first: Prepared, second: Prepared): boolean {
  if (first.url === second.url) return true;
  return first.normKey !== null && first.normKey === second.normKey;
}

function toSide(item: Prepared, domain: string): NearDuplicateSide {
  return { id: item.id, title: item.title, url: item.url, domain };
}

/** Similarity desc, then canonical `(a.id, b.id)` — deterministic. */
function sortPairs(pairs: NearDuplicatePair[]): void {
  pairs.sort(
    (x, y) =>
      y.titleSimilarity - x.titleSimilarity ||
      compareStrings(x.a.id, y.a.id) ||
      compareStrings(x.b.id, y.b.id),
  );
}

/** Orientation-free id pair key — the attempt-dedupe membership test. */
function pairKey(x: string, y: string): string {
  const [a, b] = x <= y ? [x, y] : [y, x];
  return JSON.stringify([a, b]);
}

/** The same split MiniSearch's default tokenizer applies to text. */
const TOKEN_SPLIT = /[\n\r\p{Z}\p{P}]+/u;

/** Lowercase word tokens of `text`. */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(TOKEN_SPLIT)) {
    const token = raw.toLowerCase();
    if (token !== "") out.add(token);
  }
  return out;
}

/** Trim/collapse/lowercase a title for the identical-title shortcut. */
function normalizeTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Title similarity: 1.0 when normalized titles are identical (covers
 * tokenless titles like "!!!"), otherwise Jaccard over lowercase word-token
 * sets; 0 when a side has no tokens.
 */
function titleSimilarity(a: string, b: string): number {
  if (normalizeTitle(a) === normalizeTitle(b)) return 1;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) shared++;
  }
  return shared / (ta.size + tb.size - shared);
}

/** Code-unit compare — deterministic across locales. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
