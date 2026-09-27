import { describe, expect, it } from "vitest";
import { makeSyntheticRequest, SystemOneResponse } from "../../src/jev/wire";
import { PRESETS } from "../../src/net/presets";

/**
 * Live provider smoke tests (spec FR8) — the fixed synthetic `jev_test`
 * request is POSTed to each real preset endpoint only when its API key is
 * present in the environment. With no keys set every test skips, so the
 * suite stays green locally and in CI; it never runs under `npm run test`
 * (see vitest.live.config.ts). Keys are read from process.env only and are
 * never logged. `src/jev/wire` and `src/net/presets` are pure schema/const
 * modules, so no chrome or DOM APIs are pulled in.
 */

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REQUEST_TIMEOUT_MS = 15_000;

async function postSyntheticTest(url: string, apiKey: string): Promise<void> {
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(makeSyntheticRequest("jev-latest")),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  expect(response.ok, `expected 2xx, got HTTP ${response.status}`).toBe(true);

  const parsed = SystemOneResponse.parse(await response.json());
  const answer = parsed.answers["test"];
  expect(answer?.type).toBe("noul");
  if (answer?.type === "noul") {
    expect(answer.noul).toBeGreaterThanOrEqual(0);
    expect(answer.noul).toBeLessThanOrEqual(1);
  }

  const cost = parsed.usage.cost;
  console.log(
    `[live] model=${parsed.model} latencyMs=${latencyMs}` +
      (cost === undefined ? "" : ` cost=$${cost.toFixed(6)}`),
  );
}

describe("jev live smoke", () => {
  it.skipIf(TYPESAFE_API_KEY === undefined)(
    "TypeSafe answers the synthetic test question",
    async () => {
      if (TYPESAFE_API_KEY === undefined) return; // unreachable; narrows for TS
      await postSyntheticTest(PRESETS.typesafe.url, TYPESAFE_API_KEY);
    },
  );

  it.skipIf(OPENROUTER_API_KEY === undefined)(
    "OpenRouter answers the synthetic test question",
    async () => {
      if (OPENROUTER_API_KEY === undefined) return; // unreachable; narrows for TS
      await postSyntheticTest(PRESETS.openrouter.url, OPENROUTER_API_KEY);
    },
  );
});
