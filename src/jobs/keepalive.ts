import { getJob } from "./queue";

/**
 * J03 keepalive: a job started in THIS browser session survives service-worker
 * eviction. MV3 kills an idle worker around 30s; a mid-scan eviction would
 * otherwise leave the row `running` until the next explicit Resume (P06's
 * cold-start sweep pauses it). `chrome.storage.session` is the discriminator:
 * it survives worker restarts but is cleared when the browser session ends —
 * a marker present at startup means "same session, resume me", an empty
 * marker store means "cold start, P06 applies".
 *
 * Two pieces:
 *  - `markSessionJob` records the job id in the session area and arms the
 *    periodic `chrome.alarms` alarm (the only reliable MV3 timer across
 *    eviction). `drivePersistedJob` marks on claim and unmarks once the row
 *    leaves `pending`/`running`.
 *  - `chrome.alarms.onAlarm` → {@link drainSessionJobs}: marked rows still
 *    `pending`/`running` are re-driven through the normal claim+run path
 *    (same-process dedupe makes a redundant re-drive free); rows that went
 *    terminal or paused lose their marker — a paused row stays user-held.
 *
 * Every storage/alarm surface is optional and every failure degrades to the
 * P06 behavior (pause on restart, explicit Resume required) — a lost marker
 * is always the safe direction.
 */

const SESSION_JOBS_KEY = "jobs:sessionKeepalive";

/** Name of the periodic alarm that re-drives marked same-session jobs. */
export const KEEPALIVE_ALARM_NAME = "jobs-keepalive";

/** MV3 `chrome.alarms` minimum period is 30s. */
const KEEPALIVE_PERIOD_MINUTES = 0.5;

/** The `chrome.storage.session` slice used here (house pattern: narrowed surface). */
interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The `chrome.alarms` slice used here. */
interface AlarmsApi {
  create(
    name: string,
    info: { periodInMinutes?: number },
  ): Promise<void> | void;
  clear(name: string): Promise<boolean> | void;
}

declare const chrome: {
  storage?: { session?: SessionArea };
  alarms?: AlarmsApi;
};

function sessionArea(): SessionArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

function alarmsApi(): AlarmsApi | null {
  try {
    return chrome.alarms ?? null;
  } catch {
    return null;
  }
}

/**
 * Job ids marked as driven in this session. A missing or malformed record is
 * an empty set — corrupt markers are dropped rather than half-trusted.
 */
export async function readSessionJobIds(): Promise<string[]> {
  const area = sessionArea();
  if (area === null) return [];
  try {
    const value = (await area.get(SESSION_JOBS_KEY))[SESSION_JOBS_KEY];
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

async function writeSessionJobIds(ids: readonly string[]): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  try {
    await area.set({ [SESSION_JOBS_KEY]: [...ids] });
  } catch {
    // Session storage unavailable — the job degrades to P06 pause-on-restart.
  }
}

/**
 * Arm the periodic keepalive alarm. `create` with the same name replaces the
 * existing alarm, so this is idempotent. No-op where alarms are unavailable.
 */
export async function armKeepaliveAlarm(): Promise<void> {
  const alarms = alarmsApi();
  if (alarms === null) return;
  try {
    await alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
    });
  } catch {
    // Alarms unavailable — next mark retries; drain still works on restart.
  }
}

/**
 * Record `id` as driven in this session and arm the alarm. Called by
 * `drivePersistedJob` after it wins the owner claim — every same-session
 * drive point (start, resume, watchdog re-drive) funnels through there.
 */
export async function markSessionJob(id: string): Promise<void> {
  const ids = await readSessionJobIds();
  if (ids.includes(id)) return;
  await writeSessionJobIds([...ids, id]);
  await armKeepaliveAlarm();
}

/**
 * Drop `id`'s marker; when no markers remain the alarm is cleared so an idle
 * worker is not held alive for nothing. Concurrent read-modify-write can at
 * worst lose a marker — the job then degrades to P06, never unsafe.
 */
export async function unmarkSessionJob(id: string): Promise<void> {
  const ids = await readSessionJobIds();
  if (!ids.includes(id)) return;
  const next = ids.filter((existing) => existing !== id);
  await writeSessionJobIds(next);
  if (next.length === 0) {
    const alarms = alarmsApi();
    if (alarms === null) return;
    try {
      await alarms.clear(KEEPALIVE_ALARM_NAME);
    } catch {
      // A stray alarm just no-ops the next drain.
    }
  }
}

/**
 * Re-drive every marked job still `pending`/`running` and prune markers for
 * rows that settled (terminal, paused, or deleted). Called on the keepalive
 * alarm tick and once at worker start — a just-evicted worker resumes its
 * marked jobs immediately rather than waiting out the period.
 *
 * Launches are fire-and-forget, never awaited: `relaunch` resolves only
 * when the whole drive completes, and `resumeJobs` itself is gated by the
 * startup message barrier — an awaited drain would hold the extension's
 * entire message surface (including Pause/Resume) hostage for the job's
 * remaining duration, and serialize marked jobs B..N behind job A's full
 * run on every tick. `relaunch` is the production `runPersistedJob`: the
 * coordinator dedupes a job this worker already drives, and a row this
 * worker no longer owns loses the claim race instead of double-running.
 */
export async function drainSessionJobs(
  relaunch: (jobId: string) => Promise<void>,
): Promise<void> {
  const ids = await readSessionJobIds();
  for (const id of ids) {
    let live = false;
    try {
      const job = await getJob(id);
      live = job?.status === "pending" || job?.status === "running";
    } catch {
      live = false;
    }
    if (!live) {
      await unmarkSessionJob(id);
      continue;
    }
    try {
      // Kick the drive, don't await it — the row's own finally unmarks on
      // settle, and a failed drive degrades to `failed` (J02) before its
      // rethrown error reaches this catch.
      void relaunch(id).catch(() => {});
    } catch {
      // A synchronous launch failure never stalls the rest of the sweep.
    }
  }
}
