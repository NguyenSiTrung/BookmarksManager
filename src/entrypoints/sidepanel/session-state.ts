import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { z } from "zod";

/**
 * Small boolean maps mirrored to `chrome.storage.session` for the side panel's
 * left column (folder-tree expansion, section collapse).
 *
 * The side panel unmounts whenever it closes, and the narrow-mode scope
 * drawer remounts its content every time it opens — both would reset
 * in-memory UI state. `storage.session` is in-memory, cleared when the
 * browser closes, and never `storage.local` (reserved for encrypted
 * provider-key envelopes), so this adds no persisted user-state and no
 * disclosure change; delete-all already clears the session area. Every
 * storage failure degrades to purely local state.
 */

/** The slice of `chrome.storage.session` used here (house pattern: no ambient chrome types). */
interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

declare const chrome: { storage?: { session?: SessionArea } };

const StoredMap = z.record(z.string(), z.boolean());

/** The session storage area, or `null` when it is unavailable. */
function sessionArea(): SessionArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

/**
 * Persisted map under `key`. `null` means "no storage surface" (nothing to
 * hydrate and nothing to write); a missing, malformed, or rejected read is an
 * empty map — corrupt data is dropped rather than half-trusted.
 */
async function readMap(key: string): Promise<Map<string, boolean> | null> {
  const area = sessionArea();
  if (area === null) return null;
  try {
    const parsed = StoredMap.safeParse((await area.get(key))[key]);
    return parsed.success ? new Map(Object.entries(parsed.data)) : new Map();
  } catch {
    return new Map();
  }
}

async function writeMap(
  key: string,
  map: ReadonlyMap<string, boolean>,
  keep: ((id: string) => boolean) | undefined,
): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  const kept: Record<string, boolean> = {};
  for (const [id, value] of map) {
    if (keep === undefined || keep(id)) kept[id] = value;
  }
  try {
    await area.set({ [key]: kept });
  } catch {
    // Session storage unavailable — state stays local to this mount.
  }
}

/**
 * `useState` for a `Map<string, boolean>` that hydrates from, and writes
 * through to, `chrome.storage.session[key]`.
 *
 *  - Hydrates once on mount. Anything set while the read was in flight wins
 *    over the stored value.
 *  - Writes only after hydration (an empty map written first would clobber
 *    the stored state).
 *  - `keep` drops ids on write (pruning entries for things that no longer
 *    exist). It is read through a ref, so a changing predicate alone does not
 *    rewrite storage.
 */
export function usePersistedMap(
  key: string,
  keep?: (id: string) => boolean,
): [ReadonlyMap<string, boolean>, Dispatch<SetStateAction<ReadonlyMap<string, boolean>>>] {
  const [map, setMap] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readMap(key).then((stored) => {
      if (cancelled || stored === null) return;
      setMap((current) => {
        if (stored.size === 0) return current;
        const merged = new Map(stored);
        for (const [id, value] of current) merged.set(id, value);
        return merged;
      });
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const keepRef = useRef(keep);
  useEffect(() => {
    keepRef.current = keep;
  });
  useEffect(() => {
    if (!hydrated) return;
    void writeMap(key, map, keepRef.current);
  }, [hydrated, key, map]);

  return [map, setMap];
}
