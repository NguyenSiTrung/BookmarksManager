import { afterEach, describe, expect, it } from "vitest";
import {
  SystemOneRequest,
  SystemOneResponse,
  makeSyntheticRequest,
} from "../../src/jev/wire";
import type { SystemOneRequest as SystemOneRequestBody } from "../../src/jev/wire";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Self-tests for the scriptable mock System One server (spec FR8): default
 * answers are schema-valid and same-typed per question, scripted replies hit
 * in FIFO order, every request is recorded, and close() frees the ephemeral
 * port even while a `hang` or `delay` reply is outstanding.
 */

let server: MockJevServer | undefined;

async function start(): Promise<MockJevServer> {
  server = await startMockJevServer();
  return server;
}

afterEach(async () => {
  // Idempotent close — a leaked server would hang the vitest worker.
  await server?.close();
  server = undefined;
});

const ALL_TYPES_REQUEST = {
  model: "jev-latest",
  state: { bookmark: { title: "Example", url: "https://example.test" } },
  questions: {
    relevant: {
      type: "noul",
      instructions: "Is this bookmark relevant?",
    },
    category: {
      type: "choice",
      instructions: "Which category fits?",
      criteria: { docs: "documentation", article: null, tool: null },
    },
    quality: {
      type: "score",
      instructions: "Rate overall quality.",
      criteria: ["poor", "average", "excellent"],
    },
  },
} satisfies SystemOneRequestBody;

function post(
  url: string,
  body: unknown = ALL_TYPES_REQUEST,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

describe("startup and shutdown", () => {
  it("binds 127.0.0.1 on an ephemeral port", async () => {
    const s = await start();
    expect(s.port).toBeGreaterThan(0);
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.url).toBe(`${s.origin}/v1/systemone`);
  });

  it("close() resolves and frees the port", async () => {
    const s = await start();
    await s.close();
    await expect(post(s.url)).rejects.toThrow();
  });

  it("close() resolves while a hang reply is outstanding", async () => {
    const s = await start();
    s.queue({ kind: "hang" });
    const controller = new AbortController();
    const pending = post(s.url, ALL_TYPES_REQUEST, {
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    await expect(s.close()).resolves.toBeUndefined();
    controller.abort();
    await pending;
  });
});

describe("default answers", () => {
  it("returns a SystemOneResponse-valid answer for all three question types", async () => {
    const s = await start();
    const response = await post(s.url);

    expect(response.status).toBe(200);
    const parsed = SystemOneResponse.parse(await response.json());

    expect(parsed.model).toBe("jev-latest"); // echoes request.model
    expect(Object.keys(parsed.answers).sort()).toEqual([
      "category",
      "quality",
      "relevant",
    ]);

    const noul = parsed.answers["relevant"];
    expect(noul).toMatchObject({ type: "noul" });
    if (noul?.type === "noul") {
      expect(noul.noul).toBeGreaterThanOrEqual(0);
      expect(noul.noul).toBeLessThanOrEqual(1);
    }

    const choice = parsed.answers["category"];
    expect(choice).toMatchObject({ type: "choice" });
    if (choice?.type === "choice") {
      expect(Object.keys(ALL_TYPES_REQUEST.questions.category.criteria)).toContain(
        choice.choice,
      );
      // probabilities cover every option key
      expect(Object.keys(choice.probabilities).sort()).toEqual(
        ["article", "docs", "tool"],
      );
      expect(choice.confidence).toBeGreaterThan(0);
    }

    const score = parsed.answers["quality"];
    expect(score).toMatchObject({ type: "score" });
    if (score?.type === "score") {
      // score within the 1..N level set; legend/probabilities keyed over it
      expect(score.score).toBeGreaterThanOrEqual(1);
      expect(score.score).toBeLessThanOrEqual(3);
      expect(Object.keys(score.legend)).toEqual(["1", "2", "3"]);
      expect(Object.keys(score.probabilities)).toEqual(["1", "2", "3"]);
    }

    expect(Number.isInteger(parsed.usage.input_tokens)).toBe(true);
    expect(Number.isInteger(parsed.usage.output_tokens)).toBe(true);
    expect(parsed.usage.input_tokens).toBeGreaterThan(0);
    expect(parsed.usage.output_tokens).toBeGreaterThan(0);
  });

  it("answers the synthetic makeSyntheticRequest", async () => {
    const s = await start();
    const request = makeSyntheticRequest("jev-1.13.0");
    const response = await post(s.url, request);
    const parsed = SystemOneResponse.parse(await response.json());
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.answers["test"]).toMatchObject({ type: "noul" });
  });

  it("answers a request whose question keys get deterministic answers", async () => {
    const s = await start();
    const first = SystemOneResponse.parse(await (await post(s.url)).json());
    const second = SystemOneResponse.parse(await (await post(s.url)).json());
    expect(first.answers).toEqual(second.answers);
  });
});

describe("routing", () => {
  it("serves both /v1/systemone and /api/v1/systemone", async () => {
    const s = await start();
    const tsResponse = await post(`${s.origin}/v1/systemone`);
    const orResponse = await post(`${s.origin}/api/v1/systemone`);
    expect(tsResponse.status).toBe(200);
    expect(orResponse.status).toBe(200);
    expect(
      SystemOneResponse.safeParse(await orResponse.json()).success,
    ).toBe(true);
  });

  it("returns 404 for unknown paths without consuming queued replies", async () => {
    const s = await start();
    s.queue({ kind: "status", status: 503 });
    const missing = await post(`${s.origin}/v1/unknown`);
    expect(missing.status).toBe(404);
    // The queued reply was not consumed by the 404.
    const response = await post(s.url);
    expect(response.status).toBe(503);
  });

  it("returns 404 for non-POST methods on a valid path", async () => {
    const s = await start();
    const response = await fetch(s.url, { method: "GET" });
    expect(response.status).toBe(404);
  });

  it("returns 422 for bodies that are not valid System One requests", async () => {
    const s = await start();
    const notJson = await post(s.url, "{oops");
    expect(notJson.status).toBe(422);
    const notRequest = await post(s.url, { model: 7 });
    expect(notRequest.status).toBe(422);
    // Both were still recorded.
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]?.json).toBeUndefined();
    expect(s.requests[1]?.json).toEqual({ model: 7 });
  });
});

describe("scripted replies", () => {
  it("returns a scripted HTTP status", async () => {
    for (const status of [401, 422, 500, 529]) {
      const s = await start();
      s.queue({ kind: "status", status });
      const response = await post(s.url);
      expect(response.status, `HTTP ${status}`).toBe(status);
    }
  });

  it("returns scripted headers such as retry-after on 429", async () => {
    const s = await start();
    s.queue({
      kind: "status",
      status: 429,
      headers: { "retry-after": "2" },
      body: "rate limited",
    });
    const response = await post(s.url);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toBe("rate limited");
  });

  it("consumes queued replies in FIFO order, then falls back to default", async () => {
    const s = await start();
    s.queue({ kind: "status", status: 401 });
    s.queue({ kind: "answer", model: "jev-9.9.9" });

    const first = await post(s.url);
    const second = await post(s.url);
    const third = await post(s.url);

    expect(first.status).toBe(401);
    expect(second.status).toBe(200);
    expect((await second.json()).model).toBe("jev-9.9.9");
    expect(third.status).toBe(200);
    expect(SystemOneResponse.parse(await third.json()).model).toBe(
      "jev-latest",
    );
  });

  it("delay waits before applying the follow-up reply", async () => {
    const s = await start();
    s.queue({ kind: "delay", ms: 60, then: { kind: "status", status: 503 } });
    const started = performance.now();
    const response = await post(s.url);
    const elapsed = performance.now() - started;
    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(5000);
  });

  it("delay without `then` produces a default answer", async () => {
    const s = await start();
    s.queue({ kind: "delay", ms: 20 });
    const response = await post(s.url);
    expect(response.status).toBe(200);
    expect(
      SystemOneResponse.safeParse(await response.json()).success,
    ).toBe(true);
  });

  it("hang never replies; the client aborts and close() still resolves", async () => {
    const s = await start();
    s.queue({ kind: "hang" });
    const controller = new AbortController();
    const pending = post(s.url, ALL_TYPES_REQUEST, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow();
    // The request reached the server before the abort.
    expect(s.requests).toHaveLength(1);
    await expect(s.close()).resolves.toBeUndefined();
  });

  it("malformed returns a 200 whose body fails response.json()", async () => {
    const s = await start();
    s.queue({ kind: "malformed" });
    const response = await post(s.url);
    expect(response.status).toBe(200);
    await expect(response.json()).rejects.toThrow();
  });

  it("malformed honors a custom body", async () => {
    const s = await start();
    s.queue({ kind: "malformed", body: "<html>nope</html>" });
    const response = await post(s.url);
    expect(await response.text()).toBe("<html>nope</html>");
  });
});

describe("scripted answer shaping", () => {
  it("answer overrides model, merges usage, and passes extras through", async () => {
    const s = await start();
    s.queue({
      kind: "answer",
      model: "typesafe/jev-1.13",
      usage: { output_tokens: 42, cost: 0.0017 },
      extras: { id: "gen-abc", provider: "typesafe" },
    });
    const response = await post(s.url);
    const parsed = SystemOneResponse.parse(await response.json());
    expect(parsed.model).toBe("typesafe/jev-1.13");
    expect(parsed.id).toBe("gen-abc");
    expect(parsed.provider).toBe("typesafe");
    expect(parsed.usage.output_tokens).toBe(42);
    expect(parsed.usage.cost).toBe(0.0017);
    expect(parsed.usage.input_tokens).toBeGreaterThan(0);
  });

  it("answer `answers` fully replaces the generated answers map", async () => {
    const s = await start();
    s.queue({
      kind: "answer",
      answers: { only: { type: "noul", noul: 0.5 } },
    });
    const parsed = SystemOneResponse.parse(await (await post(s.url)).json());
    expect(parsed.answers).toEqual({ only: { type: "noul", noul: 0.5 } });
  });

  it("omitAnswerKeys drops generated answers", async () => {
    const s = await start();
    s.queue({ kind: "answer", omitAnswerKeys: ["quality", "category"] });
    const parsed = SystemOneResponse.parse(await (await post(s.url)).json());
    expect(Object.keys(parsed.answers)).toEqual(["relevant"]);
  });

  it("answerOverrides replaces per-key answers (e.g. mismatched type)", async () => {
    const s = await start();
    s.queue({
      kind: "answer",
      answerOverrides: {
        relevant: {
          type: "choice",
          choice: "yes",
          probabilities: { yes: 1 },
          confidence: 1,
        },
      },
    });
    const parsed = SystemOneResponse.parse(await (await post(s.url)).json());
    // Schema-valid on the wire; the client flags the type mismatch.
    expect(parsed.answers["relevant"]).toEqual({
      type: "choice",
      choice: "yes",
      probabilities: { yes: 1 },
      confidence: 1,
    });
    expect(parsed.answers["category"]).toMatchObject({ type: "choice" });
    expect(parsed.answers["quality"]).toMatchObject({ type: "score" });
  });
});

describe("setHandler", () => {
  it("is consulted with the call index when the queue is empty", async () => {
    const s = await start();
    const seen: number[] = [];
    s.setHandler((callIndex, request) => {
      seen.push(callIndex);
      expect(SystemOneRequest.safeParse(request.json).success).toBe(true);
      return callIndex === 1 ? { kind: "status", status: 529 } : undefined;
    });
    const first = await post(s.url); // handler returns undefined → default
    const second = await post(s.url); // handler scripts 529
    const third = await post(s.url); // undefined → default
    expect(first.status).toBe(200);
    expect(second.status).toBe(529);
    expect(third.status).toBe(200);
    expect(seen).toEqual([0, 1, 2]);
  });

  it("queued replies take precedence over the handler", async () => {
    const s = await start();
    s.setHandler(() => ({ kind: "status", status: 418 }));
    s.queue({ kind: "status", status: 429 });
    const first = await post(s.url);
    const second = await post(s.url);
    expect(first.status).toBe(429);
    expect(second.status).toBe(418);
  });
});

describe("request recording", () => {
  it("records method, path, headers, raw and parsed body", async () => {
    const s = await start();
    const request = { ...ALL_TYPES_REQUEST, model: "jev-preview" };
    const body = JSON.stringify(request);
    await post(`${s.origin}/api/v1/systemone?ignored=1`, request, {
      headers: {
        authorization: "Bearer sk-test",
        "x-custom-header": "hello",
      },
    });
    expect(s.requests).toHaveLength(1);
    const received = s.requests[0];
    expect(received?.method).toBe("POST");
    expect(received?.path).toBe("/api/v1/systemone");
    expect(received?.headers["authorization"]).toBe("Bearer sk-test");
    expect(received?.headers["x-custom-header"]).toBe("hello");
    expect(received?.rawBody).toBe(body);
    expect(received?.json).toEqual(request);
  });

  it("records 404s and malformed bodies too", async () => {
    const s = await start();
    await post(`${s.origin}/nope`);
    await post(s.url, "{not json");
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]?.path).toBe("/nope");
    expect(s.requests[1]?.path).toBe("/v1/systemone");
    expect(s.requests[1]?.rawBody).toBe("{not json");
    expect(s.requests[1]?.json).toBeUndefined();
  });
});
