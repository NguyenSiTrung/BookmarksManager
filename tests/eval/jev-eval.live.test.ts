import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JevClientError } from "../../src/jev/client";
import type { JevClient, JevTransport } from "../../src/jev/client";
import {
  DEFAULT_EVAL_THRESHOLDS,
  aggregateEval,
  type EvalObservation,
} from "../../src/eval/metrics";
import { renderEvalJson, renderEvalMarkdown } from "../../src/eval/report";
import { EvalCorpus, type EvalCase } from "../../src/eval/schema";
import {
  EVAL_PROVIDERS,
  evalCases,
  isAcceptedModelId,
  makeEvalClient,
  providerKey,
  runEvalCase,
  type EvalProviderSpec,
} from "./provider";

/**
 * Phase 6 key-gated evaluation runner — spec FR1. Two layers live here:
 *
 * 1. Provider plumbing tests (always run, no network): key lookup, pinned
 *    model acceptance, and `runEvalCase` failure translation against a stub
 *    transport — timeout, malformed response, missing answers, and invented
 *    candidates all land as bounded observations without leaking bodies or
 *    keys.
 * 2. The live sweep (key-gated): for each preset whose env key is set, every
 *    corpus case runs serially through the production question-set builders
 *    and the hardened client; `afterAll` aggregates and writes
 *    `test-results/eval/jev-eval-<preset>.{json,md}`.
 *
 * Keys come from `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` and are never
 * logged. `JEV_EVAL_LIMIT` caps the corpus for dev runs.
 */

const corpusPath = join(__dirname, "fixtures", "corpus.json");
const corpus = EvalCorpus.parse(
  JSON.parse(readFileSync(corpusPath, "utf8")),
);
const RESULTS_DIR = join(__dirname, "..", "..", "test-results", "eval");

const SPEC = EVAL_PROVIDERS[0] as EvalProviderSpec; // typesafe

function responseOf(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function okBody(model: string, answers: Record<string, unknown>) {
  return { model, answers, usage: { input_tokens: 10, output_tokens: 4 } };
}

const catCase = corpus.cases.find((c) => c.kind === "categorize") as EvalCase;

function stubClient(run: JevClient["run"]): JevClient {
  return { model: SPEC.requestModel, run };
}

describe("eval provider plumbing", () => {
  it("providerKey treats missing and blank env values as no key", () => {
    expect(providerKey(SPEC, {})).toBeUndefined();
    expect(providerKey(SPEC, { TYPESAFE_API_KEY: "" })).toBeUndefined();
    expect(providerKey(SPEC, { TYPESAFE_API_KEY: "   " })).toBeUndefined();
    expect(providerKey(SPEC, { TYPESAFE_API_KEY: " sk-test " })).toBe(
      "sk-test",
    );
  });

  it("accepts only the pinned response ids — moving aliases are rejected", () => {
    for (const spec of EVAL_PROVIDERS) {
      expect(isAcceptedModelId(spec, spec.requestModel)).toBe(true);
      expect(isAcceptedModelId(spec, "jev-latest")).toBe(false);
      expect(isAcceptedModelId(spec, "jev-preview")).toBe(false);
      expect(isAcceptedModelId(spec, "typesafe/jev-latest")).toBe(false);
    }
    expect(isAcceptedModelId(EVAL_PROVIDERS[0]!, "typesafe/jev-1.13")).toBe(
      false,
    );
    expect(isAcceptedModelId(EVAL_PROVIDERS[1]!, "jev-1.13.0")).toBe(false);
  });

  it("records an answered observation with the actual model id", async () => {
    const client = stubClient(async () => ({
      model: "jev-1.13.0",
      answers: {
        category: {
          type: "choice" as const,
          choice: "docs",
          probabilities: { docs: 0.9, article: 0.1 },
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 10, outputTokens: 4 },
      batches: 1,
    }));
    const o = await runEvalCase(client, SPEC, corpus, catCase);
    expect(o).toMatchObject({ status: "answered", modelId: "jev-1.13.0" });
    expect(o.answer).toMatchObject({ kind: "categorize", choice: "docs" });
  });

  it("a moving-alias response model becomes an unexpected_model error", async () => {
    const client = stubClient(async () => ({
      model: "jev-latest",
      answers: {
        category: {
          type: "choice" as const,
          choice: "docs",
          probabilities: { docs: 0.9, article: 0.1 },
          confidence: 0.9,
        },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      batches: 1,
    }));
    const o = await runEvalCase(client, SPEC, corpus, catCase);
    expect(o).toMatchObject({
      status: "error",
      errorCode: "unexpected_model",
      modelId: "jev-latest",
    });
  });

  it("a client timeout lands as a timeout observation", async () => {
    const client = stubClient(async () => {
      throw new JevClientError("timeout", "bounded abort fired");
    });
    const o = await runEvalCase(client, SPEC, corpus, catCase);
    expect(o).toMatchObject({ status: "timeout", errorCode: "timeout" });
  });

  it("malformed / mismatched responses land as error observations", async () => {
    for (const code of ["invalid_response", "answer_mismatch"] as const) {
      const client = stubClient(async () => {
        throw new JevClientError(code, "redacted");
      });
      const o = await runEvalCase(client, SPEC, corpus, catCase);
      expect(o).toMatchObject({ status: "error", errorCode: code });
    }
  });

  it("missing answers / invented candidates surface via the real client cross-check", async () => {
    const missingTransport: JevTransport = async () =>
      responseOf(okBody("jev-1.13.0", {}));
    const inventedTransport: JevTransport = async () =>
      responseOf(
        okBody("jev-1.13.0", {
          category: {
            type: "choice",
            choice: "docs",
            probabilities: { docs: 1 },
            confidence: 0.9,
          },
          invented_field: { type: "noul", noul: 0.9 },
        }),
      );
    for (const transport of [missingTransport, inventedTransport]) {
      const client = makeEvalClient(SPEC, "key", {
        transport,
        timeoutMs: 1_000,
        maxRetries: 0,
      });
      const o = await runEvalCase(client, SPEC, corpus, catCase);
      expect(o.status).toBe("error");
      expect(o.errorCode).toBe("answer_mismatch");
    }
  });

  it("excluded bookmarks are skipped without touching the provider", async () => {
    const excluded = corpus.bookmarks.find((b) => b.excluded);
    expect(excluded).toBeDefined();
    const c = {
      kind: "categorize",
      id: "c_test_excluded",
      bookmark: excluded!.id,
      expect: { category: "other" },
    } as EvalCase;
    let called = 0;
    const client = stubClient(async () => {
      called += 1;
      throw new Error("must not be called");
    });
    const o = await runEvalCase(client, SPEC, corpus, c);
    expect(o.status).toBe("skipped");
    expect(called).toBe(0);
  });

  it("error observations never leak keys or bodies", async () => {
    const SECRET = "sk-live-SECRET-EVAL-KEY";
    const transport: JevTransport = async () =>
      // A 500 whose body contains the key and private content — the client
      // must not read non-2xx bodies, and the observation must carry neither.
      responseOf({ debug: `body for ${SECRET} with private bookmark text` }, 500);
    const client = makeEvalClient(SPEC, SECRET, {
      transport,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    const o = await runEvalCase(client, SPEC, corpus, catCase);
    expect(o.status).toBe("error");
    const serialized = JSON.stringify(o);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("private bookmark text");
  });
});

// ---------------------------------------------------------------------------
// Live sweep — key-gated per provider
// ---------------------------------------------------------------------------

for (const spec of EVAL_PROVIDERS) {
  describe(`live eval: ${spec.preset} (${spec.requestModel})`, () => {
    const key = providerKey(spec);
    const cases = evalCases(corpus);
    const observations: EvalObservation[] = [];
    const client =
      key === undefined
        ? undefined
        : makeEvalClient(spec, key, { timeoutMs: 20_000, maxRetries: 1 });

    describe.skipIf(client === undefined)("corpus cases", () => {
      for (const c of cases) {
        it(
          `${c.kind} ${c.id}`,
          async () => {
            const observation = await runEvalCase(
              client as JevClient,
              spec,
              corpus,
              c,
            );
            observations.push(observation);
            expect(observation.case.id).toBe(c.id);
            expect(observation.status).toMatch(
              /^(answered|timeout|error|skipped)$/,
            );
          },
          90_000,
        );
      }
    });

    afterAll(() => {
      if (observations.length === 0) return;
      const report = aggregateEval(
        corpus,
        observations,
        DEFAULT_EVAL_THRESHOLDS,
        new Date().toISOString(),
      );
      mkdirSync(RESULTS_DIR, { recursive: true });
      const json = renderEvalJson(report);
      const md = renderEvalMarkdown(report);
      // Belt: the artifacts must never carry the key material.
      if (key !== undefined) {
        expect(json).not.toContain(key);
        expect(md).not.toContain(key);
      }
      writeFileSync(
        join(RESULTS_DIR, `jev-eval-${spec.preset}.json`),
        json,
      );
      writeFileSync(join(RESULTS_DIR, `jev-eval-${spec.preset}.md`), md);
      console.log(
        `[eval] ${spec.preset}: ${report.totals.answered}/${report.totals.cases} answered, ` +
          `accuracy ${(report.totals.accuracy ?? 0).toFixed(3)} → ${RESULTS_DIR}`,
      );
    });
  });
}
