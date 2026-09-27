import { defineBackground } from "wxt/utils/define-background";
import { hasConsent } from "../consent/records";
import { db } from "../db/database";
import { listMeta, listTags } from "../db/meta";
import {
  approveDecision,
  bulkApprove,
  rejectDecision,
  revertDecision,
} from "../decisions/apply";
import { normalizeBlocklistEntry } from "../decisions/minimize";
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
import { DecisionSettings } from "../decisions/policy";
import { rerankSearch } from "../decisions/rerank";
import { cancelJob, enqueueJob, getJob, pauseJob, resumeJob } from "../jobs/queue";
import {
  JobRunner,
  createDuplicateScanner,
  createPipelineAnalyzer,
} from "../jobs/runner";
import {
  handleDecisionsMessage,
  type DecisionsHandlers,
  type SettingsSnapshot,
} from "../messages/decisions";
import { handleProviderMessage } from "../messages/provider";
import { PRESETS } from "../net/presets";
import {
  DECISIONS_CONSENT_SCOPE,
  ProviderSettings,
} from "../schemas/provider";
import type { PresetId } from "../schemas/provider";
import type { Job } from "../schemas/job";
import { loadSessionIndex, registerOmnibox } from "../search/omnibox";
import { runQuery } from "../search/run";
import { get, getTree } from "../sync/chrome-bookmarks";
import { flattenTree } from "../sync/tree";
import { registerContextMenus } from "../sync/context-menu";
import { registerBookmarkListeners } from "../sync/listeners";
import { reconcileMetadata } from "../sync/reconcile";

/**
 * At startup the worker subscribes the five bookmark events (which
 * cascade-delete extension metadata for removed subtrees and broadcast
 * `bookmarks-changed` to open pages), rebuilds the right-click "Save page"/
 * "Save link" context-menu items (`src/sync/context-menu.ts`), runs one
 * metadata reconcile for deletions missed while the service worker was
 * suspended, and resumes any `running`/`pending` decision jobs from Dexie so a
 * library scan survives an MV3 worker restart (FR7). It performs no network
 * requests at startup. `chrome` is the lazy-slice house pattern so test stubs
 * work; only `runtime.onMessage` is needed here — the sync modules (including
 * the context-menu slice) declare their own slices. Of the provider protocol,
 * only TEST_PROVIDER can produce egress, and only via the consented gate in
 * `src/net/send.ts`; of the decisions protocol, egress is confined to the
 * analyze/save-suggest/rerank/job handlers, each behind the same gate.
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
};

// ---------------------------------------------------------------------------
// Decisions production wiring
// ---------------------------------------------------------------------------

/** Namespaced `metadata` key for the decisions settings. The blocklist key +
 * reader live in `src/decisions/blocklist.ts` (shared with the egress gate);
 * they are re-exported here for existing callers. */
export const DECISION_SETTINGS_KEY = "decisions:settings";
export { DECISION_BLOCKLIST_KEY, readBlocklist };

/** The consented preset + model the decision services run against. */
interface ActiveProvider {
  readonly preset: PresetId;
  readonly model: string;
}

/**
 * The first preset with a current `jev_decisions` consent grant AND a stored,
 * valid `ProviderSettings` row — the provider the decisions flow runs
 * against. `null` when none is fully enabled; every decisions handler that
 * would egress refuses (`not_enabled`) rather than guessing.
 */
async function activeProvider(): Promise<ActiveProvider | null> {
  for (const preset of Object.keys(PRESETS) as PresetId[]) {
    try {
      if (!(await hasConsent(DECISIONS_CONSENT_SCOPE, preset))) continue;
      const row = await db.metadata.get(preset);
      const parsed = ProviderSettings.safeParse(row?.value);
      if (parsed.success) return { preset, model: parsed.data.model };
    } catch {
      // A broken row / lookup just skips this preset.
    }
  }
  return null;
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
async function buildRunner(provider: ActiveProvider): Promise<JobRunner> {
  const [context, userBlocklist] = await Promise.all([
    loadAnalysisContext(),
    readBlocklist(),
  ]);
  return new JobRunner({
    analyze: createPipelineAnalyzer({
      context,
      preset: provider.preset,
      model: provider.model,
      userBlocklist,
    }),
    scanDuplicates: createDuplicateScanner({
      preset: provider.preset,
      model: provider.model,
      userBlocklist,
    }),
  });
}

/** Run (or resume) one persisted job against the live work set. */
async function runPersistedJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job === undefined) return;
  const provider = await activeProvider();
  if (provider === null) return; // no consented provider — leave the job be
  const bookmarks = await resolveWorkSet(job.bookmarkIds ?? []);
  if (bookmarks.length === 0) return;
  const runner = await buildRunner(provider);
  await runner.run(jobId, { bookmarks });
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
 * Injectable seams for the production handlers (the `ResumeJobsDeps`
 * pattern): defaults are the real thing, tests substitute fakes.
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
        preset: provider.preset,
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
      return analyzeBookmark({
        bookmark,
        context: { ...context, settings: SAVE_SUGGEST_SETTINGS },
        preset: provider.preset,
        model: provider.model,
        checks: ["categorize", "tags", "placement"],
        userBlocklist,
      });
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
        preset: provider.preset,
        model: provider.model,
        userBlocklist,
      });
    },
    approve: (id) => approveDecision(id),
    reject: (id) => rejectDecision(id),
    revert: (id) => revertDecision(id),
    bulkApprove: (ids) => bulkApprove([...ids]),
    async startJob(kind, bookmarkIds) {
      // Refuse BEFORE enqueueing: `runPersistedJob` returns silently when
      // no provider is active — right for a restart resume, wrong for an
      // explicit user start, which would strand a "Queued" row forever
      // with no error surfaced. The panel renders the refusal verbatim.
      await requireActiveProvider();
      const job = await enqueueJob({ kind, bookmarkIds: [...bookmarkIds] });
      // Fire-and-forget: the row is the source of truth, so the UI can show
      // progress immediately and a restart resumes from the committed batch.
      void runPersistedJob(job.id).catch(() => {
        // The runner marks the job `failed` itself; a transport/context
        // failure here leaves it for the next worker start to retry.
      });
      return job;
    },
    pauseJob: (id) => pauseJob(id),
    async resumeJob(id) {
      const job = await resumeJob(id);
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
// Job resume on startup
// ---------------------------------------------------------------------------

/** The pieces of startup resume that touch Jev, injected so it is testable. */
export interface ResumeJobsDeps {
  /** Resolve a job's persisted work set against the live tree. */
  resolveWorkSet(job: Job): Promise<readonly AnalysisBookmark[]>;
  /** Run (or resume) one job. */
  runJob(job: Job, bookmarks: readonly AnalysisBookmark[]): Promise<unknown>;
}

/**
 * Resume every interrupted job from Dexie — a worker restart leaves a job
 * `running` (evicted mid-flight) or `pending` (evicted between `enqueueJob`
 * and the first `setJobStatus("running")`); the runner continues either from
 * the last committed batch. A `paused` job is NOT resumed: it only reaches
 * that status via an explicit user action, and restarting it would silently
 * resume egress/cost the user halted — it stays paused until the user resumes
 * it. Terminal jobs are ignored, a job whose work set resolves empty is
 * skipped, and any per-job failure is swallowed so one broken job can never
 * stop the others (or reject — the caller runs this fire-and-forget).
 */
export async function resumeJobs(deps: ResumeJobsDeps): Promise<void> {
  let jobs: Job[];
  try {
    jobs = await db.jobs.where("status").anyOf("running", "pending").toArray();
  } catch {
    return;
  }
  for (const job of jobs) {
    try {
      const bookmarks = await deps.resolveWorkSet(job);
      if (bookmarks.length === 0) continue;
      await deps.runJob(job, bookmarks);
    } catch {
      // Best-effort: the next worker start retries.
    }
  }
}

/** Production resume dependencies: the real work-set resolver + job runner. */
function productionResumeDeps(): ResumeJobsDeps {
  return {
    resolveWorkSet: (job) => resolveWorkSet(job.bookmarkIds ?? []),
    runJob: (job) => runPersistedJob(job.id),
  };
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
  // FR7: resume decision jobs left mid-flight by an MV3 worker restart.
  // Fire-and-forget, like the reconcile above, so a resume failure never
  // takes down the message handlers.
  void resumeJobs(productionResumeDeps()).catch(() => {
    // Best-effort; the next worker start retries.
  });

  const decisionsHandlers = productionHandlers();

  // MV3 async-response pattern: the listener returns `true` synchronously to
  // keep the sendResponse channel open, then resolves it once a handler
  // finishes. The decisions handler runs first and owns every message whose
  // `type` it declares; for anything else it returns `undefined` and the
  // provider handler answers, unchanged. Both handlers are total (they never
  // throw), so sendResponse runs exactly once.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleDecisionsMessage(message, sender, decisionsHandlers).then(
      (response) => {
        if (response !== undefined) {
          sendResponse(response);
          return;
        }
        void handleProviderMessage(message, sender).then(sendResponse);
      },
    );
    return true;
  });
});
