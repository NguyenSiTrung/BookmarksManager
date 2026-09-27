import { describe, expect, it } from "vitest";
import { UsageMeter } from "../../src/jev/usage";

/**
 * UsageMeter is a pure accumulator (spec FR3): it sums token counts, sums the
 * USD cost only over entries that report one (OpenRouter only), and records
 * the versioned model ids seen. Nothing is persisted.
 */

describe("UsageMeter", () => {
  it("starts empty", () => {
    const meter = new UsageMeter();
    expect(meter.inputTokens).toBe(0);
    expect(meter.outputTokens).toBe(0);
    expect(meter.costUsd).toBeUndefined();
    expect(meter.costComplete).toBe(false);
    expect(meter.models).toEqual([]);
  });

  it("sums tokens across added entries", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 100, output_tokens: 40 });
    meter.add({ input_tokens: 23, output_tokens: 7 });
    meter.add({ input_tokens: 7, output_tokens: 3 });

    expect(meter.inputTokens).toBe(130);
    expect(meter.outputTokens).toBe(50);
  });

  it("reports undefined costUsd when no entry reports a cost", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 10, output_tokens: 5 });
    meter.add({ input_tokens: 10, output_tokens: 5 });

    expect(meter.costUsd).toBeUndefined();
    expect(meter.costComplete).toBe(false);
  });

  it("sums only reported costs, and is not costComplete on partial coverage", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 10, output_tokens: 5, cost: 0.002 });
    meter.add({ input_tokens: 10, output_tokens: 5 }); // no cost reported
    meter.add({ input_tokens: 10, output_tokens: 5, cost: 0.001 });

    expect(meter.costUsd).toBeCloseTo(0.003);
    expect(meter.costComplete).toBe(false);
  });

  it("is costComplete when every added entry reports a cost", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1, output_tokens: 1, cost: 0 });
    meter.add({ input_tokens: 1, output_tokens: 1, cost: 0.005 });

    expect(meter.costComplete).toBe(true);
    expect(meter.costUsd).toBe(0.005);
  });

  it("records unique models in insertion order", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1, output_tokens: 1 }, "jev-1.13.0");
    meter.add({ input_tokens: 1, output_tokens: 1 }, "jev-1.13.0");
    meter.add({ input_tokens: 1, output_tokens: 1 }, "typesafe/jev-1.13");

    expect(meter.models).toEqual(["jev-1.13.0", "typesafe/jev-1.13"]);
  });

  it("treats the model argument as optional", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1, output_tokens: 1 });
    meter.add({ input_tokens: 1, output_tokens: 1 }, "jev-1.13.0");
    meter.add({ input_tokens: 1, output_tokens: 1 });

    expect(meter.models).toEqual(["jev-1.13.0"]);
  });

  it("returns a models snapshot that later adds do not mutate", () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1, output_tokens: 1 }, "jev-1.13.0");
    const snapshot = meter.models;
    meter.add({ input_tokens: 1, output_tokens: 1 }, "typesafe/jev-1.13");

    expect(snapshot).toEqual(["jev-1.13.0"]);
    expect(meter.models).toEqual(["jev-1.13.0", "typesafe/jev-1.13"]);
  });
});
