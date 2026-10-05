import { defineBackground } from "wxt/utils/define-background";
import { db } from "../db/database";
import { listMeta, listTags } from "../db/meta";
import {
  approveDecision,
  bulkApprove,
  rejectDecision,
  revertBatch,
  revertDecision,
} from "../decisions/apply";
import { normalizeBlocklistEntry } from "../decisions/minimize";
import { prunePopupDecisions } from "../decisions/store";
import { sweepStaleLlmReservations } from "../net/llm-send";
import {
  DECISION_BLOCKLIST_KEY,
  readBlocklist,
} from "../decisions/blocklist";
import {
  analyzeBookmark,
  DecisionPipelineError,
} from "../decisions/pipeline";
import type {
  AnalysisBookmark,
  AnalysisContext,
} from "../decisions/pipeline";
import { planNearDuplicates } from "../decisions/near-duplicate-plan";
import type { NearDuplicatePlan } from "../decisions/near-duplicate-plan";
import { DecisionSettings } from "../decisions/policy";
import { rerankSearch } from "../decisions/rerank";
import {
  cancelJob,
  claimJobOwner,
  enqueueJob,
  getJob,
  pauseInterruptedJobs,
  pauseJob,
  reDriveStaleJobs,
  resumeJob,
  setJobStatus,
} from "../jobs/queue";
import { coordinateJob } from "../jobs/coordinator";
import { estimateJobCost } from "../jobs/estimate";
import {
  armKeepaliveAlarm,
  drainSessionJobs,
  KEEPALIVE_ALARM_NAME,
  markSessionJob,
  readSessionJobIds,
  unmarkSessionJob,
} from "../jobs/keepalive";
import {
  JobRunner,
  createDuplicateScanner,
  createPipelineAnalyzer,
  redactFailure,
} from "../jobs/runner";
import {
  handleDecisionsMessage,
  type DecisionsHandlers,
  type SettingsSnapshot,
} from "../messages/decisions";
import { handleLlmProviderMessage } from "../messages/llm-provider";
import { handleLlmFeatureMessage } from "../messages/llm-features";
import { handleSummarizeMessage } from "../messages/summaries";
import { handleRestructureMessage } from "../messages/restructure";
import { handleSaveMessage } from "../messages/save";
import { createRestructureAssigner } from "../restructure/assign";
import { handleProviderMessage } from "../messages/provider";
import {
  readActiveJevProvider,
  type ActiveJevProvider,
} from "../jev/settings";
import type { Job } from "../schemas/job";
import type { JobCostEstimate as JobCostEstimateType } from "../schemas/job";
import { loadSessionIndex, registerOmnibox } from "../search/omnibox";
import { runQuery } from "../search/run";
import { get, getTree } from "../sync/chrome-bookmarks";
import { flattenTree } from "../sync/tree";
import { registerContextMenus } from "../sync/context-menu";
import { registerBookmarkListeners } from "../sync/listeners";
import { reconcileMetadata } from "../sync/reconcile";
import { seedStarterTags } from "../db/starter-tags";

/**
 * At startup the worker subscribes the five bookmark events (which
 * cascade-delete extension metadata for removed subtrees and invalidate
 * the shared search index, D14), rebuilds the right-click "Save page"/
 * "Save link" context-menu items (`src/sync/context-menu.ts`), runs one
 * metadata reconcile for deletions missed while the service worker was
 * suspended, and pauses interrupted `running`/`pending` jobs in Dexie until an
 * explicit Resume action (FR7), then reaps any legacy
 * synthetic popup backlog beyond the retention bound (improvement I05). It
 * performs no network requests at startup. `chrome` is the lazy-slice house
 * pattern so test stubs work; only `runtime.onMessage` is needed here — the
 * sync modules (including the context-menu slice) declare their own slices. Of
 * the provider protocol, only TEST_PROVIDER can produce egress, and only via
 * the consented gate in `src/net/send.ts`; of the decisions protocol, egress
 * is confined to the analyze/save-suggest/rerank/job handlers, each behind the
 * same gate.
 */
declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { url?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean,
      ): void;
    };
  };
  alarms?: {
    onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  };
};

// ---------------------------------------------------------------------------
// Decisions production wiring
// ---------------------------------------------------------------------------

/** Namespaced `metadata` key for the decisions settings. The blocklist key +
 * reader live in `src/decisions/blocklist.ts` (shared with the egress gate);
 * they are re-exported here for existing callers. */
export const DECISION_SETTINGS_KEY = "decisions:settings";
export { DECISION_BLOCKLIST_KEY, readBlocklist };

/** The consented provider + model the decision services run against. */
type ActiveProvider = ActiveJevProvider;

/**
 * The first provider — a preset or the custom endpoint — with a current
 * `jev_decisions` consent grant AND a stored, valid `ProviderSettings` row,
 * i.e. the provider the decisions flow runs against. `null` when none is
 * fully enabled; every decisions handler that would egress refuses
 * (`not_enabled`) rather than guessing.
 */
async function activeProvider(): Promise<ActiveProvider | null> {
  return readActiveJevProvider();
}

/**
 * The active provider, or a typed refusal. Every decisions handler that
 * would egress starts with this gate — the panel renders the message
 * verbatim, so the refusal says what to do, not what broke.
 */
async function requireActiveProvider(): Promise<ActiveProvider> {
  const provider = await activeProvider();
  if (provider === null) {
    throw new DecisionPipelineError(
      "invalid_input",
      "No provider is enabled for decisions; enable one in Options first.",
    );
  }
  return provider;
}

/** The persisted decision policy settings, or all-toggles-off when unset. */
async function readDecisionSettings(): Promise<DecisionSettings> {
  try {
    const row = await db.metadata.get(DECISION_SETTINGS_KEY);
    const parsed = DecisionSettings.safeParse(row?.value);
    return parsed.success ? parsed.data : DecisionSettings.parse({});
  } catch {
    return DecisionSettings.parse({});
  }
}

/** The current settings + blocklist snapshot the Options UI reads. */
async function settingsSnapshot(): Promise<SettingsSnapshot> {
  const [settings, blocklist] = await Promise.all([
    readDecisionSettings(),
    readBlocklist(),
  ]);
  return { settings, blocklist };
}

/** Persist the policy settings (validated by the message schema already). */
async function writeDecisionSettings(
  settings: DecisionSettings,
): Promise<SettingsSnapshot> {
  await db.metadata.put({ key: DECISION_SETTINGS_KEY, value: settings });
  return settingsSnapshot();
}

/**
 * Persist the user blocklist, normalized to canonical hosts and de-duplicated
 * (mirrors `normalizeBlocklistEntry`'s contract); entries that cannot name a
 * host are dropped rather than failing the whole write.
 */
async function writeBlocklist(
  entries: readonly string[],
): Promise<SettingsSnapshot> {
  const normalized: string[] = [];
  for (const raw of entries) {
    const host = normalizeBlocklistEntry(raw);
    if (host !== null && !normalized.includes(host)) normalized.push(host);
  }
  await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: normalized });
  return settingsSnapshot();
}

/** Build the `AnalysisContext` from the live tree + extension metadata. */
async function loadAnalysisContext(): Promise<AnalysisContext> {
  const [rawTree, tagDefs, metas, settings] = await Promise.all([
    getTree(),
    listTags(),
    listMeta(),
    readDecisionSettings(),
  ]);
  const tree = flattenTree(rawTree);
  const corpus = {
    bookmarks: [...tree.bookmarks.values()].map((node) => ({
      id: node.id,
      url: node.url,
    })),
    metas,
  };
  return { tagDefs, corpus, tree, settings };
}

/** Resolve one live bookmark node to the pipeline's `AnalysisBookmark`. */
async function resolveBookmark(id: string): Promise<AnalysisBookmark> {
  const node = (await get(id))[0];
  if (node === undefined || node.url === undefined) {
    throw new DecisionPipelineError(
      "invalid_input",
      `No bookmark exists for id ${JSON.stringify(id)}.`,
    );
  }
  return {
    id: node.id,
    title: node.title,
    url: node.url,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
  };
}

/**
 * Resolve a job's persisted work set against the live tree. Ids that no
 * longer exist are skipped; the runner's strict id match then fails closed,
 * so a partially-deleted work set is never silently re-sliced.
 */
async function resolveWorkSet(
  bookmarkIds: readonly string[],
): Promise<AnalysisBookmark[]> {
  const tree = flattenTree(await getTree());
  const bookmarks: AnalysisBookmark[] = [];
  for (const id of bookmarkIds) {
    const node = tree.bookmarks.get(id);
    if (node === undefined) continue;
    bookmarks.push({
      id: node.id,
      title: node.title,
      url: node.url,
      ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    });
  }
  return bookmarks;
}

/**
 * Construct the job runner for `provider`, wiring BOTH the per-bookmark
 * pipeline analyzer and the near-duplicate pair scanner. The scanner is
 * mandatory: a `library_scan` fails closed without it, so leaving it out
 * would silently skip the FR7 pair phase.
 */
async function buildRunner(
  provider: ActiveProvider,
  kind: Job["kind"],
): Promise<JobRunner> {
  const [context, userBlocklist] = await Promise.all([
    loadAnalysisContext(),
    readBlocklist(),
  ]);
  // Restructure jobs assign proposed folders via Jev (FR8); everything else
  // keeps the analyze/scan pipeline.
  if (kind === "restructure") {
    return new JobRunner({
      analyze: createRestructureAssigner({
        providerId: provider.providerId,
        model: provider.model,
        userBlocklist,
      }),
    });
  }
  return new JobRunner({
    analyze: createPipelineAnalyzer({
      context,
      providerId: provider.providerId,
      model: provider.model,
      userBlocklist,
    }),
    scanDuplicates: createDuplicateScanner({
      providerId: provider.providerId,
      model: provider.model,
      userBlocklist,
    }),
  });
}

/**
 * Run (or resume) one persisted job against the live work set. Exported for
 * the worker-wiring tests (the `productionHandlers` precedent).
 *
 * Only a LIVE row (`running`/`pending`) is ever driven: a pause/cancel that
 * landed between the caller's flip and this read wins — re-entering the
 * runner would otherwise flip the row back to `running` and drive egress
 * the user explicitly halted. ANY failure while driving — a caller-side
 * `JobRunnerError`, a work-set resolution blow-up, a runner construction
 * fault — degrades the row to `failed` with a redacted code (J02), never
 * an untyped rejection that leaves an immortal `running` row behind.
 */

/** How often the J02 watchdog sweeps for ownerless `running` rows. */
const JOB_WATCHDOG_INTERVAL_MS = 60_000;
export function runPersistedJob(jobId: string): Promise<void> {
  return coordinateJob(jobId, () => drivePersistedJob(jobId));
}

async function drivePersistedJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job === undefined) return;
  if (job.status !== "running" && job.status !== "pending") return;
  const provider = await activeProvider();
  if (provider === null) return; // no consented provider — leave the job be
  const owner = await claimJobOwner(jobId);
  if (owner === undefined) return; // pause/cancel during provider setup wins
  // J03: this worker now owns the drive — the session marker survives an
  // eviction so the keepalive drain (or the next worker start) re-drives it.
  await markSessionJob(jobId);
  try {
    // Work-set resolution and runner construction are INSIDE the try: any
    // unexpected failure must degrade this job to `failed` with a redacted
    // code (J02) rather than leak an untyped rejection that leaves an
    // immortal `running` row. An empty resolved set is NOT an early exit —
    // the runner decides the terminal state (deleted work set → completed).
    const bookmarks = await resolveWorkSet(job.bookmarkIds ?? []);
    const runner = await buildRunner(provider, job.kind);
    await runner.run(jobId, { bookmarks, ownerGeneration: owner.ownerGeneration });
  } catch (error) {
    try {
      await setJobStatus(
        jobId,
        "failed",
        { error: redactFailure(error) },
        undefined,
        owner.ownerGeneration,
      );
    } catch {
      // Raced a concurrent transition — the row keeps whatever won.
    }
    // Marking `failed` must not swallow the caller's typed refusal: the ROW
    // keeps only the redacted code while the surface still receives the
    // original error it needs to answer `request_not_allowed` (or any other
    // typed outcome) — a failed row AND a propagated refusal, not either/or.
    throw error;
  } finally {
    // Keepalive owns only `pending`/`running` rows: once the drive settles
    // to terminal or paused the marker is dropped so the alarm is cleared
    // (a paused row stays user-held — explicit Resume re-marks it).
    try {
      const row = await getJob(jobId);
      if (row === undefined || (row.status !== "running" && row.status !== "pending")) {
        await unmarkSessionJob(jobId);
      }
    } catch {
      // A stale marker just no-ops the next drain — never block the drive.
    }
  }
}

/**
 * Save-suggest runs the pipeline as a PROPOSAL-only flow (plan §9.1/FR10):
 * the analyzed "bookmark" is a not-yet-saved page behind a synthetic
 * `popup:` id with no tree node to mutate, and its
 * `set_category`/`add_tags`/`move` outputs are chips the user accepts in the
 * popup — never auto-applied actions. Running under the user's real
 * settings would let `evaluatePolicy` return `auto_apply`, and the guarded
 * apply would then fail `stale`/`bookmark_gone` on the synthetic id,
 * turning the whole suggestion into `apply_failed` and hiding the chips.
 * The full `DecisionSettings` value with every toggle off forces the policy
 * into `preselect`/`review`/`unsure`, so `persistDraft` always lands the
 * rows `pending`/`unsure` and never reaches `approveDecision`. The real
 * analyze path (`analyzeById`, library jobs) keeps the user's settings and
 * still auto-applies per §10.2.
 */
const SAVE_SUGGEST_SETTINGS: DecisionSettings = {
  autoApply: { add_tags: false, set_category: false },
};

/**
 * Injectable seams for the production handlers: defaults are the real thing,
 * tests substitute fakes.
 */
export interface ProductionHandlersDeps {
  /**
   * Relaunch a resumed job's runner. `resumeJob` flips the row to
   * `running`, but the paused job's loop already returned at its batch
   * boundary — without a relaunch nothing drives the row until the next
   * worker restart. Injectable so the wiring is testable without a live
   * provider.
   */
  readonly relaunchJob?: (jobId: string) => Promise<void>;
  /**
   * Best-effort retention sweep run after each save-suggest succeeds
   * (improvement I05). Defaults to the real {@link prunePopupDecisions};
   * injectable so the fail-soft contract — a sweep that rejects must never
   * break popup saving — is pinned without stubbing the storage layer.
   */
  readonly prunePopup?: () => Promise<number>;
}

/**
 * The production decisions handlers: real services, the Jev-bound job runner,
 * and the settings/blocklist store. Keys and the Jev client never leave this
 * module — the protocol only ever sees these redacted results. Exported for
 * the worker-wiring tests; `defineBackground` below is the only runtime
 * caller.
 */
export function productionHandlers(
  deps: ProductionHandlersDeps = {},
): DecisionsHandlers {
  const relaunchJob = deps.relaunchJob ?? runPersistedJob;
  const prunePopup = deps.prunePopup ?? prunePopupDecisions;
  return {
    async analyzeById(bookmarkId) {
      const provider = await requireActiveProvider();
      const [bookmark, context, userBlocklist] = await Promise.all([
        resolveBookmark(bookmarkId),
        loadAnalysisContext(),
        readBlocklist(),
      ]);
      return analyzeBookmark({
        bookmark,
        context,
        providerId: provider.providerId,
        model: provider.model,
        userBlocklist,
      });
    },
    async saveSuggest(bookmark) {
      const provider = await requireActiveProvider();
      const [context, userBlocklist] = await Promise.all([
        loadAnalysisContext(),
        readBlocklist(),
      ]);
      // Save-suggest also asks for a folder placement (plan §9.1/FR10) — and
      // always under the proposal-only settings, so the user's auto-apply
      // toggles can never fire against the synthetic `popup:` id.
      const result = await analyzeBookmark({
        bookmark,
        context: { ...context, settings: SAVE_SUGGEST_SETTINGS },
        providerId: provider.providerId,
        model: provider.model,
        checks: ["categorize", "tags", "placement"],
        userBlocklist,
      });
      // Bound the synthetic backlog AFTER this save's rows are committed
      // (improvement I05). This is also the "next-save" legacy sweep for rows
      // an older build left behind. Fail-soft by contract: a sweep failure must
      // never turn a successful save-suggest into an error — the reply (the
      // chips) still stands, and the next save/startup retries the cleanup.
      try {
        await prunePopup();
      } catch {
        // Best-effort retention; the popup save is already persisted.
      }
      return result;
    },
    async rerank(query) {
      const provider = await requireActiveProvider();
      const handle = await loadSessionIndex();
      if (handle === null) return { sent: false, reason: "empty" };
      const { hits } = runQuery(handle.index, query, handle.ctx);
      const userBlocklist = await readBlocklist();
      return rerankSearch({
        query,
        hits,
        providerId: provider.providerId,
        model: provider.model,
        userBlocklist,
      });
    },
    approve: (id) => approveDecision(id),
    reject: (id) => rejectDecision(id),
    revert: (id) => revertDecision(id),
    bulkApprove: (ids) => bulkApprove([...ids]),
    revertBatch: (ids) => revertBatch([...ids]),
    async startJob(kind, bookmarkIds) {
      // Refuse BEFORE enqueueing: `runPersistedJob` returns silently when
      // no provider is active — right for a restart resume, wrong for an
      // explicit user start, which would strand a "Queued" row forever
      // with no error surfaced. The panel renders the refusal verbatim.
      await requireActiveProvider();
      const ids = [...bookmarkIds];
      // Resolve the work set once: a library scan's bounded pair plan and
      // the pre-run estimate both fold over the same minimized rows.
      // Best-effort like `resolveLibraryScanPlan` — a read failure falls
      // back to no plan and no estimate, never blocks the start.
      const workSet = await resolveWorkSet(ids).catch(() => undefined);
      let plan: NearDuplicatePlan | undefined;
      try {
        plan =
          kind === "library_scan" && workSet !== undefined
            ? planNearDuplicates(workSet)
            : undefined;
      } catch {
        plan = undefined;
      }
      // The estimate reuses the persisted plan rather than re-planning, and
      // is itself best-effort: a failure omits it, never blocks the start.
      let estimate: JobCostEstimateType | undefined;
      try {
        estimate =
          workSet === undefined
            ? undefined
            : estimateJobCost({
                bookmarks: workSet,
                kind,
                ...(plan === undefined ? {} : { plan }),
              });
      } catch {
        estimate = undefined;
      }
      const job = await enqueueJob({
        kind,
        bookmarkIds: ids,
        ...(plan === undefined ? {} : { nearDuplicatePlan: plan }),
      });
      // Fire-and-forget: the row is the source of truth, so the UI can show
      // progress immediately and a restart resumes from the committed batch.
      void runPersistedJob(job.id).catch(() => {
        // The runner marks the job `failed` itself; a transport/context
        // failure here leaves it for the next worker start to retry.
      });
      return { job, estimate };
    },
    pauseJob: (id) => pauseJob(id),
    async resumeJob(id) {
      // Capture user intent before waiting on provider/setup or a held batch.
      // A later pause/cancel must not be undone by this older resume request.
      const requested = await getJob(id);
      // Refuse BEFORE the flip, exactly like startJob: with no provider the
      // relaunch below would return silently and the flipped row would
      // claim "Running" forever with nothing driving it.
      await requireActiveProvider();
      const job = await resumeJob(id, undefined, requested?.controlRevision);
      if (job.status !== "running") return job;
      // The flipped row alone is not enough (see ProductionHandlersDeps):
      // relaunch the runner, fire-and-forget exactly like startJob above.
      void relaunchJob(job.id).catch(() => {
        // The runner marks the job `failed` itself; a transport/context
        // failure here leaves it for the next worker start to retry.
      });
      return job;
    },
    cancelJob: (id) => cancelJob(id),
    getSettings: () => settingsSnapshot(),
    setSettings: (settings) => writeDecisionSettings(settings),
    setBlocklist: (blocklist) => writeBlocklist(blocklist),
  };
}

// ---------------------------------------------------------------------------
// Local job recovery on startup
// ---------------------------------------------------------------------------

/**
 * Recover interrupted jobs without provider/native reads or egress. Both
 * `running` and the enqueue-to-drive `pending` window require explicit Resume.
 * Existing paused/terminal jobs stay unchanged; committed batches remain the
 * resume boundary. Same-session eviction recovery is a separate keepalive
 * path, not authorization to send on a cold start.
 */
export async function resumeJobs(): Promise<void> {
  try {
    // J03: session markers discriminate a same-session worker restart from
    // a cold start — `chrome.storage.session` survives eviction but not a
    // browser restart. Marked jobs stay live (the sweep skips them) and are
    // re-driven immediately rather than waiting out the alarm period; every
    // unmarked `pending`/`running` row is paused exactly as before (P06).
    const keepaliveIds = new Set(await readSessionJobIds());
    await pauseInterruptedJobs(undefined, keepaliveIds);
    if (keepaliveIds.size > 0) {
      await drainSessionJobs(runPersistedJob);
      // The alarm survived the same eviction the marker did, but re-arm
      // anyway — the drain may have pruned the last marker and cleared it.
      if ((await readSessionJobIds()).length > 0) await armKeepaliveAlarm();
    }
  } catch {
    // Recovery failure never falls back to driving the jobs.
  }
}

export default defineBackground(() => {
  // Sync wiring: listeners keep `bookmarkMeta` in step with the native tree
  // while the worker is alive; the one-shot reconcile reaps rows for ids that
  // vanished while it was suspended. Both are fire-and-forget — a sync
  // failure must never take down the provider message handler below.
  registerBookmarkListeners();
  // Right-click save items. Idempotent per worker start (removeAll + create,
  // and a WeakMap-keyed onClicked listener), and it clears any stale badge
  // left by a worker evicted mid-confirmation. Total: a partial `chrome`
  // surface degrades to a no-op rather than taking down the handler below.
  registerContextMenus();
  // `bm` omnibox keyword: session-scoped local index, ≤8 escaped
  // suggestions, disposition routing via the typed tabs slice. A missing
  // `chrome.omnibox` surface (Firefox, tests) degrades to a no-op, and all
  // listeners are total so a failure can never take down the worker.
  registerOmnibox();
  void reconcileMetadata().catch(() => {
    // Best-effort cleanup; the next worker start retries.
  });
  // One-shot starter-tag pack for empty libraries (local only). Fire-and-forget
  // like the reconcile above; a failure leaves the library empty and retries
  // on the next worker start only if the seed flag was never written.
  void seedStarterTags().catch(() => {
    // Best-effort; see seedStarterTags' own total catch.
  });
  // P06: startup is local-only. Explicit messages wait for recovery so an
  // early Start/Resume cannot be paused by an older startup sweep.
  const startupRecovery = resumeJobs();
  // Improvement I05: reap a legacy synthetic popup backlog left by earlier
  // builds that had no retention bound. Fire-and-forget like the reconcile
  // above — a sweep failure must never take down the worker, and the next
  // start (or save-suggest) retries.
  void prunePopupDecisions().catch(() => {
    // Best-effort; the next worker start or save-suggest retries.
  });
  // A03: settle `active` reservations a dead worker left behind — local
  // only, under the same conservative rule a late response would have used.
  // Fire-and-forget like the sweeps above; a failure retries next start.
  void sweepStaleLlmReservations().catch(() => {
    // Best-effort; the next worker start retries.
  });
  // J02 watchdog: a `running` row silent past the stale window lost its
  // owner — the interval re-drives it through the normal claim+run path
  // (the owner-generation fence makes a false positive cheap: a live owner
  // exits at its next durable boundary). Local only, fire-and-forget like
  // the sweeps above.
  setInterval(() => {
    void reDriveStaleJobs(runPersistedJob).catch(() => {
      // Best-effort; the next interval retries.
    });
  }, JOB_WATCHDOG_INTERVAL_MS);

  // J03 keepalive: the alarm is a browser-level MV3 event — it fires even
  // after worker eviction, waking the worker, and each tick re-drives the
  // jobs this session marked (drain also prunes settled/deleted markers).
  // Missing `chrome.alarms` (Firefox, tests) degrades to the P06 behavior.
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      void drainSessionJobs(runPersistedJob).catch(() => {
        // Best-effort; the next tick retries.
      });
    }
  });

  const decisionsHandlers = productionHandlers();

  // MV3 async-response pattern: the listener returns `true` synchronously to
  // keep the sendResponse channel open, then resolves it once a handler
  // finishes. The decisions handler runs first and owns every message whose
  // `type` it declares; for anything else it returns `undefined` and the
  // provider handler answers, unchanged. Both handlers are total (they never
  // throw), so sendResponse runs exactly once.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void startupRecovery.then(() =>
      handleDecisionsMessage(message, sender, decisionsHandlers)).then(
      (response) => {
        if (response !== undefined) {
          sendResponse(response);
          return;
        }
        void handleLlmProviderMessage(message, sender).then((llmResponse) => {
          if (llmResponse !== undefined) {
            sendResponse(llmResponse);
            return;
          }
          void handleLlmFeatureMessage(message, sender).then(
            (featureResponse) => {
              if (featureResponse !== undefined) {
                sendResponse(featureResponse);
                return;
              }
              void handleSummarizeMessage(message, sender).then(
                (summaryResponse) => {
                  if (summaryResponse !== undefined) {
                    sendResponse(summaryResponse);
                    return;
                  }
                  void handleRestructureMessage(message, sender, {
                    runJob: runPersistedJob,
                  }).then((restructureResponse) => {
                    if (restructureResponse !== undefined) {
                      sendResponse(restructureResponse);
                      return;
                    }
                    void handleSaveMessage(message, sender).then(
                      (saveResponse) => {
                        if (saveResponse !== undefined) {
                          sendResponse(saveResponse);
                          return;
                        }
                        void handleProviderMessage(message, sender).then(
                          sendResponse,
                        );
                      },
                    );
                  });
                },
              );
            },
          );
        });
      },
    );
    return true;
  });
});
