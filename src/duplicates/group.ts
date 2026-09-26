import { normalizeUrl } from "./normalize";

/**
 * Minimal item shape the grouper needs: a stable unique `id` and the raw
 * `url` string. Callers pass richer bookmark objects — the generic preserves
 * their type in the returned groups. `id` is assumed unique per input item.
 * Callers should pass bookmark items only (filter out folder nodes first —
 * they carry no `url`).
 */
export interface DuplicateCandidate {
  id: string;
  url: string;
}

export type DuplicateGroupKind = "exact" | "normalized";

export interface DuplicateGroup<
  T extends DuplicateCandidate = DuplicateCandidate,
> {
  /** Raw URL for exact groups; normalized key for normalized groups. */
  key: string;
  kind: DuplicateGroupKind;
  /** Members in input order. */
  items: T[];
}

/**
 * Bucket bookmarks into duplicate groups. Pure — no DOM, no `chrome`.
 *
 * Two passes over the input:
 * 1. "exact" — raw `url` string equality. Any bucket with 2+ items is
 *    always emitted, keyed by the raw URL.
 * 2. "normalized" — {@link normalizeUrl} key equality (items whose URL is
 *    invalid or non-http(s) produce no key and skip this pass). A bucket
 *    with 2+ items is emitted keyed by the normalized URL, EXCEPT when its
 *    member set is identical to an exact group already emitted — reporting
 *    the same set twice would be noise.
 *
 * Overlap rule: exact and normalized groups may overlap. When several exact
 * groups share one normalized key (e.g. an http pair and an https pair), the
 * normalized group is their union; when a normalized bucket strictly
 * contains an exact group's members, both are emitted. Only the
 * members-identical case suppresses the normalized group.
 *
 * Singletons are never emitted. Output ordering is stable and deterministic:
 * all exact groups first, then all normalized groups; within each kind,
 * groups are ordered by when their key was first seen while scanning the
 * input (Map insertion order). Items within a group keep input order.
 */
export function groupDuplicates<T extends DuplicateCandidate>(
  bookmarks: readonly T[],
): DuplicateGroup<T>[] {
  const exactBuckets = new Map<string, T[]>();
  const normalizedBuckets = new Map<string, T[]>();

  for (const item of bookmarks) {
    addToBucket(exactBuckets, item.url, item);
    const key = normalizeUrl(item.url);
    if (key !== null) {
      addToBucket(normalizedBuckets, key, item);
    }
  }

  const exactGroups: DuplicateGroup<T>[] = [];
  for (const [key, items] of exactBuckets) {
    if (items.length >= 2) {
      exactGroups.push({ key, kind: "exact", items });
    }
  }

  const exactIdSets = exactGroups.map(
    (group) => new Set(group.items.map((item) => item.id)),
  );

  const normalizedGroups: DuplicateGroup<T>[] = [];
  for (const [key, items] of normalizedBuckets) {
    if (items.length < 2) {
      continue;
    }
    const alreadyExact = exactIdSets.some(
      (ids) =>
        ids.size === items.length &&
        items.every((item) => ids.has(item.id)),
    );
    if (!alreadyExact) {
      normalizedGroups.push({ key, kind: "normalized", items });
    }
  }

  return [...exactGroups, ...normalizedGroups];
}

function addToBucket<T>(buckets: Map<string, T[]>, key: string, item: T): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [item]);
  } else {
    bucket.push(item);
  }
}
