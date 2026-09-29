import { minimizeBookmark } from "../../src/decisions/minimize";
import { createJevClient, JevClientError } from "../../src/jev/client";
import type { JevClient, JevTransport } from "../../src/jev/client";
import { categorize } from "../../src/jev/tasks/categorize";
import { misfiled } from "../../src/jev/tasks/misfiled";
import { nearDuplicate } from "../../src/jev/tasks/near-duplicate";
import { placement } from "../../src/jev/tasks/placement";
import { rerank } from "../../src/jev/tasks/rerank";
import { tags } from "../../src/jev/tasks/tags";
import { PRESETS } from "../../src/net/presets";
import { RELEASE_JEV_MODELS } from "../../src/decisions/release-policy";
import type { PresetId } from "../../src/schemas/provider";
import type { SentBookmark } from "../../src/schemas/decision-state";
import type { EvalAnswer, EvalObservation } from "../../src/eval/metrics";
import type { EvalCase, EvalCorpus } from "../../src/eval/schema";

/**
 * Live-eval provider plumbing — Phase 6. Everything here runs in plain
 * node under vitest: no chrome APIs, no consent gate, no key storage.
 * Keys arrive from the environment only and are never logged; recorded
 * errors carry the `JevClientError.code` (a short enum string) and never
 * the message, so response bodies and key material cannot leak into the
 * report artifacts.
 */

/** The release-pinned request/response model ids per preset (plan §FR1). */
export interface EvalProviderSpec {
  readonly preset: PresetId;
  /** The model id sent in every request. */
  readonly requestModel: string;
  /**
   * The exact response `model` ids accepted — moving aliases
   * (`jev-latest`, `jev-preview`, `typesafe/jev-latest`) are deliberately
   * absent. The provider's actual id is recorded either way.
   */
  readonly acceptedModelIds: readonly string[];
  /** The environment variable carrying this provider's API key. */
  readonly envKey: "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY";
}

export const EVAL_PROVIDERS: readonly EvalProviderSpec[] = [
  {
    preset: "typesafe",
    requestModel: RELEASE_JEV_MODELS.typesafe.request,
    acceptedModelIds: RELEASE_JEV_MODELS.typesafe.responseIds,
    envKey: "TYPESAFE_API_KEY",
  },
  {
    preset: "openrouter",
    requestModel: RELEASE_JEV_MODELS.openrouter.request,
    acceptedModelIds: RELEASE_JEV_MODELS.openrouter.responseIds,
    envKey: "OPENROUTER_API_KEY",
  },
];

/** The consent scope every eval request declares. */
export const EVAL_SCOPE = "jev_decisions" as const;

/** Optional dev knob: limit the run to the corpus's first N cases. */
export const EVAL_LIMIT_ENV = "JEV_EVAL_LIMIT" as const;

/** Read the API key for `spec` — absent and blank values both mean "no key". */
export function providerKey(
  spec: EvalProviderSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[spec.envKey];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
}

/** Optional `JEV_EVAL_LIMIT` — a positive integer or undefined. */
export function evalLimit(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[EVAL_LIMIT_ENV];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Is the provider's reported model id one the release baseline accepts?
 * Exact-list membership — `jev-latest`, `jev-preview`, and any id not
 * pinned for this preset are rejected.
 */
export function isAcceptedModelId(
  spec: EvalProviderSpec,
  modelId: string,
): boolean {
  return spec.acceptedModelIds.includes(modelId);
}

/**
 * The eval transport: a bare POST mirroring `sendConsented`'s wire shape
 * (Bearer key, JSON body, credentials omitted, redirect refused) minus the
 * consent/key/permission checks that only exist inside the extension. The
 * client's per-attempt abort signal is forwarded so every call stays
 * bounded.
 */
export function evalTransport(
  spec: EvalProviderSpec,
  key: string,
): JevTransport {
  const url = PRESETS[spec.preset].url;
  return (_scope, _preset, _model, request, options) =>
    fetch(url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: options?.signal ?? null,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
}

export interface EvalClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly transport?: JevTransport;
}

/**
 * A hardened client configured for the eval: pinned request model, the
 * decisions scope, and `maxConcurrency: 1` so provider calls serialize —
 * baseline numbers must not depend on burst timing.
 */
export function makeEvalClient(
  spec: EvalProviderSpec,
  key: string,
  options: EvalClientOptions = {},
): JevClient {
  return createJevClient({
    providerId: spec.preset,
    model: spec.requestModel,
    scope: EVAL_SCOPE,
    transport: options.transport ?? evalTransport(spec, key),
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRetries: options.maxRetries ?? 1,
    maxConcurrency: 1,
  });
}

function sent(bookmark: { title: string; url: string }): SentBookmark | null {
  return minimizeBookmark({ title: bookmark.title, url: bookmark.url });
}

function skipped(c: EvalCase): EvalObservation {
  return { case: c, status: "skipped" };
}

function errored(c: EvalCase, error: unknown): EvalObservation {
  const code =
    error instanceof JevClientError ? error.code : "invalid_response";
  // Only the machine code is recorded — never the message (which is
  // designed-redacted but could carry a question key) and never a cause.
  return {
    case: c,
    status: code === "timeout" ? "timeout" : "error",
    errorCode: code,
  };
}

interface AnswerResult {
  readonly model: string;
  readonly answer: EvalAnswer;
}

/**
 * Build the production question set for `c`, run it, and translate the
 * typed `DecisionResult` into the eval's `EvalAnswer`. Throws
 * `JevClientError`s (transport/validation/mismatch) to the caller; builder
 * `TypeError`s surface as `error` observations.
 */
async function askModel(
  client: JevClient,
  byId: Map<string, SentBookmark | null>,
  c: EvalCase,
): Promise<AnswerResult> {
  const want = (id: string): SentBookmark => {
    const b = byId.get(id);
    if (b === null || b === undefined) {
      throw new TypeError(`corpus bookmark ${JSON.stringify(id)} is not sendable`);
    }
    return b;
  };
  switch (c.kind) {
    case "categorize": {
      const set = categorize({ bookmark: want(c.bookmark) });
      const r = await set.decision.run(client, set.state);
      return {
        model: r.model,
        answer: {
          kind: "categorize",
          choice: String(r.values.category),
          confidence: r.confidence.category,
        },
      };
    }
    case "tags": {
      const set = tags({ bookmark: want(c.bookmark), tags: c.tags });
      const r = await set.decision.run(client, set.state);
      const probabilities: Record<string, number> = {};
      for (const tag of c.tags) {
        const candidateKey = tag.nameKey ?? tag.name;
        probabilities[candidateKey] =
          r.probabilities[`tag_${candidateKey}`]?.true ?? 0;
      }
      return {
        model: r.model,
        answer: { kind: "tags", probabilities },
      };
    }
    case "placement": {
      const set = placement({ bookmark: want(c.bookmark), folders: c.folders });
      const r = await set.decision.run(client, set.state);
      return {
        model: r.model,
        answer: {
          kind: "placement",
          choice: String(r.values.folder),
          confidence: r.confidence.folder,
        },
      };
    }
    case "misfiled": {
      const set = misfiled({
        bookmark: want(c.bookmark),
        folderPath: c.folderPath,
        folders: c.folders,
      });
      const r = await set.decision.run(client, set.state);
      return {
        model: r.model,
        answer: {
          kind: "misfiled",
          choice: String(r.values.folder),
          confidence: r.confidence.folder,
        },
      };
    }
    case "near_duplicate": {
      const set = nearDuplicate({ a: want(c.a), b: want(c.b) });
      const r = await set.decision.run(client, set.state);
      return {
        model: r.model,
        answer: {
          kind: "near_duplicate",
          score: Number(r.values.same_content),
          confidence: r.confidence.same_content,
        },
      };
    }
    case "rerank": {
      const candidates = c.candidates.map((id) => want(id));
      const set = rerank({ query: c.query, candidates });
      const r = await set.decision.run(client, set.state);
      return {
        model: r.model,
        answer: {
          kind: "rerank",
          probabilities: c.candidates.map(
            (_, i) => r.probabilities[`candidate_${i}`]?.true ?? 0,
          ),
        },
      };
    }
  }
}

/**
 * Run one corpus case through `client` (serialized by the caller) and
 * record the observation. The bookmark's `excluded` fixtures never reach
 * the model — they score `skipped`, matching production's never-send rule.
 * The provider's actual model id is recorded; an id outside
 * `spec.acceptedModelIds` makes the case an `error` (`unexpected_model`).
 */
export async function runEvalCase(
  client: JevClient,
  spec: EvalProviderSpec,
  corpus: EvalCorpus,
  c: EvalCase,
): Promise<EvalObservation> {
  const refs =
    c.kind === "near_duplicate"
      ? [c.a, c.b]
      : c.kind === "rerank"
        ? c.candidates
        : [c.bookmark];
  const byId = new Map<string, SentBookmark | null>();
  const bookmarks = new Map(corpus.bookmarks.map((b) => [b.id, b]));
  for (const id of refs) {
    const bm = bookmarks.get(id);
    byId.set(id, bm === undefined || bm.excluded ? null : sent(bm));
  }
  // A case that touches a non-sendable (excluded/malformed) bookmark never
  // reaches the model — coverage records it, the model is never asked.
  if ([...byId.values()].some((b) => b === null)) {
    return skipped(c);
  }
  try {
    const r = await askModel(client, byId, c);
    if (!isAcceptedModelId(spec, r.model)) {
      return {
        case: c,
        status: "error",
        errorCode: "unexpected_model",
        modelId: r.model,
      };
    }
    return { case: c, status: "answered", modelId: r.model, answer: r.answer };
  } catch (error) {
    return errored(c, error);
  }
}

/** The corpus cases a run covers, honoring `JEV_EVAL_LIMIT`. */
export function evalCases(
  corpus: EvalCorpus,
  limit = evalLimit(),
): readonly EvalCase[] {
  return limit === undefined ? corpus.cases : corpus.cases.slice(0, limit);
}
