import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryVerificationState } from "../../src/schemas/summary-verification";
import {
  questionSetVersion,
  verifySummary,
  verifySummaryRun,
  VERDICT_FIELD,
} from "../../src/jev/tasks/verify-summary";
import type { JevClient } from "../../src/jev/client";
import type { Answer } from "../../src/jev/wire";

/**
 * spec FR10 — the Jev summary-verification contract:
 *
 * - `SummaryVerificationState` is a closed schema that carries the bounded
 *   page text (`excerpt`/`headings`), the cleaned bookmark, and the
 *   LLM-written summary — nothing else (notes can never ride along);
 * - `verifySummary` asks a three-way supported/unsupported/uncertain
 *   choice over that state;
 * - `verifySummaryRun` maps the answer to a typed verdict.
 */

const STATE = {
  bookmark: {
    title: "Async Rust in depth",
    url: "https://blog.a-site.com/async-rust",
    domain: "blog.a-site.com",
  },
  excerpt: "Rust async explained with examples.".repeat(20),
  headings: ["Async Rust", "Futures"],
  summary: "An introduction to Rust's async model.",
};

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeClient(
  answers: Record<string, Answer>,
): JevClient & { run: ReturnType<typeof vi.fn> } {
  return {
    model: "jev-latest",
    run: vi.fn(async () => ({
      model: "jev-1.13.0",
      answers,
      usage: { inputTokens: 400, outputTokens: 20, cost: 0.001 },
      batches: 1,
    })),
  };
}

describe("SummaryVerificationState schema", () => {
  it("round-trips a valid state", () => {
    expect(SummaryVerificationState.parse(STATE)).toEqual(STATE);
  });

  it("rejects unknown fields — notes can never ride along", () => {
    expect(
      SummaryVerificationState.safeParse({
        ...STATE,
        notes: "private notes",
      }).success,
    ).toBe(false);
  });

  it("rejects a summary over 2,000 chars (spec FR10.4)", () => {
    expect(
      SummaryVerificationState.safeParse({
        ...STATE,
        summary: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      SummaryVerificationState.safeParse({
        ...STATE,
        summary: "x".repeat(2000),
      }).success,
    ).toBe(true);
  });

  it("rejects an excerpt over the cap", () => {
    expect(
      SummaryVerificationState.safeParse({
        ...STATE,
        excerpt: "x".repeat(20_001),
      }).success,
    ).toBe(false);
  });

  it("rejects an uncleaned bookmark URL", () => {
    expect(
      SummaryVerificationState.safeParse({
        ...STATE,
        bookmark: {
          title: "T",
          url: "https://blog.a-site.com/x?utm=1",
          domain: "blog.a-site.com",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects empty excerpt/summary", () => {
    for (const patch of [{ excerpt: "" }, { summary: "" }]) {
      expect(
        SummaryVerificationState.safeParse({ ...STATE, ...patch }).success,
      ).toBe(false);
    }
  });
});

describe("verifySummary task", () => {
  it("exports a questionSetVersion and a three-way verdict choice", () => {
    expect(questionSetVersion).toBe("verify-summary-v1");
    const task = verifySummary(STATE);
    expect(task.questionSetVersion).toBe(questionSetVersion);
    const request = task.decision.build(task.state, "jev-latest");
    const q = request.questions[VERDICT_FIELD];
    expect(q?.type).toBe("choice");
    if (q?.type === "choice") {
      expect(Object.keys(q.criteria).sort()).toEqual([
        "supported",
        "uncertain",
        "unsupported",
      ]);
    }
  });

  it("run() returns the supported verdict with confidence", async () => {
    const client = fakeClient({
      verdict: {
        type: "choice",
        choice: "supported",
        probabilities: { supported: 0.9, uncertain: 0.1 },
        confidence: 0.9,
      },
    });
    const result = await verifySummaryRun(client, STATE);
    expect(result.verdict).toBe("supported");
    expect(result.confidence).toBe(0.9);
    // The state reaching the wire is exactly what was passed.
    expect(client.run).toHaveBeenCalledWith(
      expect.objectContaining({ model: "jev-latest", state: STATE }),
    );
  });

  it.each(["unsupported", "uncertain"] as const)(
    "run() passes the %s verdict through",
    async (verdict) => {
      const client = fakeClient({
        verdict: {
          type: "choice",
          choice: verdict,
          probabilities: { [verdict]: 0.8 },
          confidence: 0.8,
        },
      });
      const result = await verifySummaryRun(client, STATE);
      expect(result.verdict).toBe(verdict);
    },
  );
});
