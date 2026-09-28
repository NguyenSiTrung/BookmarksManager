import { describe, expect, it } from "vitest";

/**
 * Live LLM smoke tests (spec FR8 + Phase 6 Task 2): the strictest
 * structured-output request shape — `response_format: json_schema` with
 * `strict: true` — POSTed to the real OpenAI and OpenRouter
 * chat.completions endpoints only when their API key is in the
 * environment. With no keys every test skips, so the suite stays green
 * locally and in CI; it never runs under `npm run test` (see
 * vitest.live.config.ts). Keys are read from process.env only and are
 * never logged. The request mirrors exactly what `src/llm/structured.ts`
 * puts on the wire for the json_schema tier — same envelope, same
 * response_format block — so a provider that silently dropped strict
 * output support fails here before users hit it.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const REQUEST_TIMEOUT_MS = 20_000;

/** The exact strict-tier request body shape structured.ts emits. */
const STRICT_REQUEST = {
  model: "gpt-4o-mini-2024-07-18",
  messages: [
    {
      role: "system",
      content:
        "Answer with the JSON object the schema requests and nothing else.",
    },
    {
      role: "user",
      content: "Should bookmarks about rust go under dev?",
    },
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "verdict",
      strict: true,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["yes", "no"] },
        },
        required: ["verdict"],
        additionalProperties: false,
      },
    },
  },
  max_tokens: 32,
  temperature: 0,
};

async function strictSmoke(url: string, apiKey: string): Promise<void> {
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
    body: JSON.stringify(STRICT_REQUEST),
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  const text = await response.text();
  expect(
    response.ok,
    `expected 2xx, got HTTP ${response.status}: ${text.slice(0, 200)}`,
  ).toBe(true);
  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = parsed.choices?.[0]?.message?.content;
  expect(typeof content).toBe("string");
  // The strict contract: the body parses to exactly the schema's shape.
  const verdict = JSON.parse(content!) as { verdict?: unknown };
  expect(["yes", "no"]).toContain(verdict.verdict);
  console.log(
    `[live] ${url} latencyMs=${latencyMs}` +
      (parsed.usage === undefined
        ? ""
        : ` tokens=${parsed.usage.prompt_tokens}+${parsed.usage.completion_tokens}`),
  );
}

describe("llm live smoke", () => {
  it.skipIf(OPENAI_API_KEY === undefined)(
    "OpenAI answers a strict json_schema request",
    async () => {
      if (OPENAI_API_KEY === undefined) return; // narrows for TS
      await strictSmoke(
        "https://api.openai.com/v1/chat/completions",
        OPENAI_API_KEY,
      );
    },
  );

  it.skipIf(OPENROUTER_API_KEY === undefined)(
    "OpenRouter answers a strict json_schema request",
    async () => {
      if (OPENROUTER_API_KEY === undefined) return;
      await strictSmoke(
        "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY,
      );
    },
  );
});
