import { describe, expect, it } from "vitest";
import { aggregateEval, DEFAULT_EVAL_THRESHOLDS } from "../../src/eval/metrics";
import { renderEvalJson, renderEvalMarkdown } from "../../src/eval/report";
import type { EvalCase, EvalCorpus } from "../../src/eval/schema";

function fixture() {
  const corpus = {
    version: "1.0.0",
    questionSetVersions: {
      categorize: "categorize-v1",
      tags: "tags-v1",
      placement: "placement-v1",
      misfiled: "misfiled-v1",
      nearDuplicate: "near-duplicate-v1",
      rerank: "rerank-v1",
    },
    bookmarks: [
      { id: "bm1", title: "a", url: "https://example.com/a", excluded: false },
      { id: "bm2", title: "b", url: "https://example.com/b", excluded: false },
    ],
    cases: [
      {
        kind: "categorize",
        id: "c_cat_001",
        bookmark: "bm1",
        expect: { category: "docs" },
      },
      {
        kind: "categorize",
        id: "c_cat_002",
        bookmark: "bm2",
        expect: { category: "video" },
      },
    ],
  } satisfies EvalCorpus;
  const observations = [
    {
      case: corpus.cases[0] as EvalCase,
      status: "answered" as const,
      modelId: "typesafe/jev-1.13",
      answer: { kind: "categorize" as const, choice: "docs", confidence: 0.92 },
    },
    {
      case: corpus.cases[1] as EvalCase,
      status: "answered" as const,
      modelId: "typesafe/jev-1.13",
      answer: { kind: "categorize" as const, choice: "article", confidence: 0.95 },
    },
  ];
  const report = aggregateEval(
    corpus,
    observations,
    DEFAULT_EVAL_THRESHOLDS,
    "2026-09-28T12:00:00Z",
  );
  return { corpus, observations, report };
}

describe("renderEvalJson", () => {
  it("serializes deterministically — identical output on repeat calls", () => {
    const { report } = fixture();
    const a = renderEvalJson(report);
    const b = renderEvalJson(report);
    expect(a).toBe(b);
    expect(() => JSON.parse(a)).not.toThrow();
  });

  it("contains the provenance a store audit needs", () => {
    const { report } = fixture();
    const parsed = JSON.parse(renderEvalJson(report));
    expect(parsed).toMatchObject({
      generatedAt: "2026-09-28T12:00:00Z",
      corpusVersion: "1.0.0",
      modelIds: ["typesafe/jev-1.13"],
      questionSetVersions: { categorize: "categorize-v1" },
      thresholds: DEFAULT_EVAL_THRESHOLDS,
    });
  });
});

describe("renderEvalMarkdown", () => {
  it("renders headline metrics, per-kind table, and failures", () => {
    const { report } = fixture();
    const md = renderEvalMarkdown(report);
    expect(md).toContain("typesafe/jev-1.13");
    expect(md).toContain("categorize-v1");
    expect(md).toContain("incorrect");
    expect(md).toContain("c_cat_002");
    expect(md).toContain("50.0%"); // 1/2 accuracy
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("[object Object]");
  });
});
