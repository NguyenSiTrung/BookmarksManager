import { describe, expect, it } from "vitest";
import { minimizeBookmark } from "../../src/decisions/minimize";
import { categorize } from "../../src/jev/tasks/categorize";
import { Category } from "../../src/schemas/bookmark";
import { SystemOneResponse } from "../../src/jev/wire";
import { PRESETS } from "../../src/net/presets";

/**
 * Live categorize smoke (Phase 5 Task 2, spec FR4/FR8): the REAL
 * production categorize question set — `minimizeBookmark` → `categorize` →
 * `decision.build`, the exact request `analyzeBookmark` sends for its
 * categorize check — POSTed to each real preset endpoint, key-gated exactly
 * like tests/live/jev-smoke.test.ts: with no key in the environment every
 * test skips, so the suite stays green locally and in CI, and it never runs
 * under `npm run test` (see vitest.live.config.ts). Keys are read from
 * process.env only and never logged.
 *
 * Every fixture is public, unambiguous metadata: title + URL + domain is the
 * entire wire payload (notes can never enter a state field), and the two
 * canonical pages assert their expected `Category` — a live model that can
 * no longer classify `react.dev` reference pages or GitHub repos is a
 * regression this smoke exists to flag. The tutorial page asserts the
 * contract only: "article" and "docs" are both defensible for it, so
 * pinning one would make the smoke flaky across model versions.
 */

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REQUEST_TIMEOUT_MS = 15_000;
const MODEL = "jev-latest";

/** Fixture bookmark metadata; `expect` pins the category when unambiguous. */
const FIXTURES: ReadonlyArray<{
  title: string;
  url: string;
  expect?: Category;
}> = [
  {
    title: "React documentation — Hooks API reference",
    url: "https://react.dev/reference/react/hooks",
    expect: "docs",
  },
  {
    title: "ripgrep — a line-oriented search tool",
    url: "https://github.com/BurntSushi/ripgrep",
    expect: "repo",
  },
  {
    title: "Tokio tutorial: async in depth",
    url: "https://tokio.rs/tokio/tutorial/async",
  },
];

async function liveCategorize(
  url: string,
  apiKey: string,
  fixture: (typeof FIXTURES)[number],
): Promise<void> {
  // The production path for one categorize check: minimize (title, cleaned
  // URL, domain only), pair the shared decision with the state, build the
  // SystemOneRequest the client would send.
  const sent = minimizeBookmark({
    title: fixture.title,
    url: fixture.url,
  });
  if (sent === null) {
    throw new Error(`fixture unexpectedly blocklisted: ${fixture.url}`);
  }
  const set = categorize({ bookmark: sent });
  const request = set.decision.build(set.state, MODEL);

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
    body: JSON.stringify(request),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  expect(response.ok, `expected 2xx, got HTTP ${response.status}`).toBe(true);
  const parsed = SystemOneResponse.parse(await response.json());

  // The wire contract: a choice answer for `category`, one of the nine sent
  // option keys, with a probability distribution and confidence in [0, 1].
  const answer = parsed.answers["category"];
  expect(answer?.type).toBe("choice");
  if (answer?.type !== "choice") return; // unreachable; narrows for TS
  expect(
    Category.options,
    `choice ${JSON.stringify(answer.choice)} must be a sent Category option`,
  ).toContain(answer.choice);
  const probability = answer.probabilities[answer.choice];
  expect(probability).toBeGreaterThanOrEqual(0);
  expect(probability).toBeLessThanOrEqual(1);
  expect(answer.confidence).toBeGreaterThanOrEqual(0);
  expect(answer.confidence).toBeLessThanOrEqual(1);
  if (fixture.expect !== undefined) {
    expect(answer.choice).toBe(fixture.expect);
  }

  const cost = parsed.usage.cost;
  console.log(
    `[live] categorize model=${parsed.model} latencyMs=${latencyMs} ` +
      `choice=${answer.choice} confidence=${answer.confidence.toFixed(2)} ` +
      `url=${fixture.url}` +
      (cost === undefined ? "" : ` cost=$${cost.toFixed(6)}`),
  );
}

describe("decisions live categorize", () => {
  for (const preset of ["typesafe", "openrouter"] as const) {
    const apiKey =
      preset === "typesafe" ? TYPESAFE_API_KEY : OPENROUTER_API_KEY;

    it.skipIf(apiKey === undefined)(
      `${preset} categorizes the fixture bookmarks`,
      async () => {
        if (apiKey === undefined) return; // unreachable; narrows for TS
        for (const fixture of FIXTURES) {
          await liveCategorize(PRESETS[preset].url, apiKey, fixture);
        }
      },
    );
  }
});
