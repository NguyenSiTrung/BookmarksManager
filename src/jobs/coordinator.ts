/**
 * Production scans have one MV3-worker owner. Keep its exact promise until
 * it settles (including the last batch's durable writes), not just until a
 * pause changes the row. Durable generations in the queue fence stale writes
 * after restart; this map prevents concurrent paid work in the live worker.
 */
const owners = new Map<string, Promise<void>>();

export interface CoordinateJobOptions {
  /**
   * When true, replace an existing in-memory owner promise instead of joining
   * it (B-15: the stale-running watchdog preempts a wedged owner so a fresh
   * generation can claim and drive the job).
   */
  readonly preempt?: boolean;
}

export function coordinateJob(
  jobId: string,
  drive: () => Promise<void>,
  options?: CoordinateJobOptions,
): Promise<void> {
  if (!options?.preempt) {
    const existing = owners.get(jobId);
    if (existing !== undefined) return existing;
  }
  const owner = Promise.resolve().then(drive).finally(() => {
    if (owners.get(jobId) === owner) owners.delete(jobId);
  });
  owners.set(jobId, owner);
  return owner;
}

/** A manual resume waits for the paused batch, even when that batch failed. */
export async function waitForJob(jobId: string): Promise<void> {
  try {
    await owners.get(jobId);
  } catch {
    // Resume re-reads the durable row; a failed owner must release the waiter.
  }
}
