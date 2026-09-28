import { db } from "../db/database";
import { LlmProviderRecord } from "../schemas/llm";
import { deleteCredential } from "../security/credentials";

/**
 * LLM provider configuration persistence (worker-side). Records live in the
 * shared `metadata` table under `llmProvider:<providerId>` — the provider id
 * resolved by `src/llm/providers.ts` (`preset:<id>` or `custom:<baseUrl>`).
 * A separate `llmActiveProvider` row points at the provider features use;
 * saving a provider makes it active (configuring implies selecting).
 *
 * Records carry settings, masked display suffix, and discovered capability
 * tier only — raw credentials live exclusively in `src/security/credentials`.
 */

const PROVIDER_KEY_PREFIX = "llmProvider:";
const ACTIVE_KEY = "llmActiveProvider";

function providerRowKey(providerId: string): string {
  return `${PROVIDER_KEY_PREFIX}${providerId}`;
}

/**
 * Read one provider's persisted record. `metadata.value` is untyped at
 * storage — every read re-validates through `LlmProviderRecord`, so a
 * malformed or hostile row fails closed to `null`.
 */
export async function readLlmProvider(
  providerId: string,
): Promise<LlmProviderRecord | null> {
  const row = await db.metadata.get(providerRowKey(providerId));
  const parsed = LlmProviderRecord.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** Persist a provider record and mark it the active provider. */
export async function saveLlmProvider(
  record: LlmProviderRecord,
): Promise<void> {
  const parsed = LlmProviderRecord.parse(record);
  await db.transaction("rw", db.metadata, async () => {
    await db.metadata.put({
      key: providerRowKey(parsed.providerId),
      value: parsed,
    });
    await db.metadata.put({ key: ACTIVE_KEY, value: parsed.providerId });
  });
}

/**
 * The currently active provider's record, or `null` when none is configured
 * (or the pointer names a provider whose record is missing/malformed).
 */
export async function readActiveLlmProvider(): Promise<LlmProviderRecord | null> {
  const pointer = await db.metadata.get(ACTIVE_KEY);
  const providerId =
    typeof pointer?.value === "string" ? pointer.value : null;
  if (providerId === null) {
    return null;
  }
  return readLlmProvider(providerId);
}

/**
 * Remove one provider's persisted state: settings record, stored credential
 * (`credential:<providerId>`), pending budget reservations, and the active
 * pointer when it named this provider. Consent grants and host permission
 * are released by the revoke flow in the message layer; usage rows are kept
 * as audit history.
 */
export async function deleteLlmProvider(providerId: string): Promise<void> {
  await db.transaction(
    "rw",
    db.metadata,
    db.llmReservations,
    async () => {
      await db.metadata.delete(providerRowKey(providerId));
      const pointer = await db.metadata.get(ACTIVE_KEY);
      if (pointer?.value === providerId) {
        await db.metadata.delete(ACTIVE_KEY);
      }
      await db.llmReservations
        .where("providerId")
        .equals(providerId)
        .delete();
    },
  );
  await deleteCredential(providerId);
}
