import { useLiveQuery } from "dexie-react-hooks";
import { CONSENT_VERSION } from "../../consent/records";
import { db } from "../../db/database";
import { CONSENT_SCOPE } from "../../schemas/provider";

/**
 * True when any consent row at the current {@link CONSENT_VERSION} exists for
 * a real scope. The synthetic `jev_test` scope (the "Test connection" click)
 * does not count: it sends nothing about bookmarks. Origin- and
 * scope-agnostic on purpose, like the Ask toggle's read — the worker stays
 * the authority on what actually sends. The `.catch` is required because
 * `useLiveQuery` rethrows observable errors.
 */
export function readAiConnected(): Promise<boolean> {
  return db.consents
    .toArray()
    .then((rows) =>
      rows.some(
        (row) =>
          row.consentVersion === CONSENT_VERSION &&
          row.scope !== CONSENT_SCOPE,
      ),
    )
    .catch((): boolean => false);
}

/** Live "an AI provider is connected" flag; `false` until Dexie answers. */
export function useAiConnected(): boolean {
  return useLiveQuery(readAiConnected, []) === true;
}
