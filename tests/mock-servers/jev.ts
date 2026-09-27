import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SystemOneRequest } from "../../src/jev/wire";
import type {
  Answer,
  Question,
  SystemOneRequest as SystemOneRequestBody,
} from "../../src/jev/wire";

/**
 * Scriptable mock of the Jev System One HTTP API (PROJECT_PLAN.md §8.1–8.2).
 *
 * Bound to 127.0.0.1 on an ephemeral port, it answers `POST /v1/systemone`
 * (TypeSafe) and `POST /api/v1/systemone` (OpenRouter-style base URL). By
 * default it builds a schema-valid answer per question of the same type; a
 * FIFO queue of scripted replies (or a handler consulted when the queue is
 * empty) can instead force auth failures, 422s, retryable 429/529 statuses
 * with `retry-after`, delays, hangs, malformed JSON, missing or mismatched
 * answers, OpenRouter extras, and arbitrary versioned `model` values. Every
 * request, including 404s, is recorded with its raw and parsed body.
 */

/** One scripted reply, consumed per incoming call (FIFO queue). */
export type MockReply =
  | {
      kind: "answer";
      /** Versioned model id to claim answered; default echoes request.model. */
      model?: string;
      /** Per-field usage overrides merged over the plausible defaults. */
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cost?: number;
      };
      /** Extra top-level response fields, e.g. OpenRouter {id, provider}. */
      extras?: Record<string, unknown>;
      /** Full override of the answers map (before omit/override tweaks). */
      answers?: Record<string, Answer>;
      /** Drop these keys from the generated answers map. */
      omitAnswerKeys?: string[];
      /** Replace these keys, e.g. with a mismatched-type answer. */
      answerOverrides?: Record<string, Answer>;
    }
  | {
      kind: "status";
      status: number;
      headers?: Record<string, string>;
      /** Raw response body; defaults to empty. */
      body?: string;
    }
  | {
      kind: "malformed";
      /** Raw 200 response body that is not JSON; default "{not json". */
      body?: string;
    }
  | {
      kind: "delay";
      ms: number;
      /** Reply applied after the wait; defaults to a normal answer. */
      then?: MockReply;
    }
  /** Never responds; the client must abort. close() still resolves. */
  | { kind: "hang" };

export interface ReceivedRequest {
  readonly method: string;
  /** URL pathname only — query strings are stripped. */
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
  /** JSON.parse result, or undefined when the body does not parse. */
  readonly json: unknown;
}

export interface MockJevServer {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  /** `origin + "/v1/systemone"` */
  readonly url: string;
  readonly port: number;
  /** Every request received so far, in order, including 404s. */
  readonly requests: readonly ReceivedRequest[];
  /** Enqueue a scripted reply (FIFO, one per endpoint call). */
  queue(reply: MockReply): void;
  /**
   * Optional override consulted only when the queue is empty; it receives the
   * 0-based call index (its position in `requests`) and the recorded request.
   * Returning undefined falls through to the default generated answer.
   */
  setHandler(
    fn: (callIndex: number, request: ReceivedRequest) => MockReply | undefined,
  ): void;
  /**
   * Stops accepting connections, destroys all open sockets (so `hang`
   * replies die), clears pending `delay` timers, and resolves once the
   * listener is released. Idempotent.
   */
  close(): Promise<void>;
}

const SYSTEMONE_PATHS = new Set(["/v1/systemone", "/api/v1/systemone"]);

/**
 * Deterministic same-type answers per question: noul gets a fixed p in
 * [0, 1], choice picks the first option key with a peaked distribution over
 * all keys, score picks the middle level (1-based indexing, matching §8.2's
 * legend/probabilities keying).
 */
function defaultAnswerFor(question: Question): Answer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 0.9 };
    case "choice": {
      const options = Object.keys(question.criteria);
      const picked = options[0] ?? "";
      const rest = Math.max(1, options.length - 1);
      const probabilities = Object.fromEntries(
        options.map((key) => [
          key,
          key === picked ? 0.75 : 0.25 / rest,
        ]),
      );
      return {
        type: "choice",
        choice: picked,
        probabilities,
        confidence: 0.75,
      };
    }
    case "score": {
      const levels = question.criteria;
      const score = Math.ceil(levels.length / 2); // a level in 1..levels.length
      const legend = Object.fromEntries(
        levels.map((text, index) => [
          String(index + 1),
          typeof text === "string" ? text : JSON.stringify(text),
        ]),
      );
      const rest = Math.max(1, levels.length - 1);
      const probabilities = Object.fromEntries(
        levels.map((_, index) => [
          String(index + 1),
          index + 1 === score ? 0.6 : 0.4 / rest,
        ]),
      );
      return {
        type: "score",
        score,
        legend,
        probabilities,
        confidence: 0.6,
      };
    }
  }
}

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return req.url ?? "/";
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string>,
): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    // The client may have aborted while a `delay` reply was pending.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json",
  });
}

export function startMockJevServer(): Promise<MockJevServer> {
  const requests: ReceivedRequest[] = [];
  const queued: MockReply[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let handler:
    | ((callIndex: number, request: ReceivedRequest) => MockReply | undefined)
    | undefined;
  let closed = false;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  }

  function buildAnswers(
    reply: Extract<MockReply, { kind: "answer" }>,
    parsed: SystemOneRequestBody | undefined,
  ): Record<string, Answer> {
    let answers: Record<string, Answer>;
    if (reply.answers !== undefined) {
      answers = { ...reply.answers };
    } else if (parsed !== undefined) {
      answers = Object.fromEntries(
        Object.entries(parsed.questions).map(([key, question]) => [
          key,
          defaultAnswerFor(question),
        ]),
      );
    } else {
      answers = {};
    }
    for (const key of reply.omitAnswerKeys ?? []) {
      delete answers[key];
    }
    for (const [key, answer] of Object.entries(reply.answerOverrides ?? {})) {
      answers[key] = answer;
    }
    return answers;
  }

  function sendAnswer(
    reply: Extract<MockReply, { kind: "answer" }>,
    received: ReceivedRequest,
    parsed: SystemOneRequestBody | undefined,
    res: ServerResponse,
  ): void {
    const answers = buildAnswers(reply, parsed);
    const usage = {
      input_tokens: Math.max(1, Math.round(received.rawBody.length / 4)),
      output_tokens: Math.max(1, Object.keys(answers).length * 8),
      ...(reply.usage ?? {}),
    };
    sendJson(res, 200, {
      ...(reply.extras ?? {}),
      model: reply.model ?? parsed?.model ?? "mock-jev",
      answers,
      usage,
    });
  }

  async function applyReply(
    reply: MockReply,
    received: ReceivedRequest,
    parsed: SystemOneRequestBody | undefined,
    res: ServerResponse,
  ): Promise<void> {
    let current: MockReply = reply;
    for (;;) {
      if (closed || res.destroyed || res.writableEnded) return;
      switch (current.kind) {
        case "hang":
          // Never answered; close() destroys the socket so the server exits.
          return;
        case "status":
          send(res, current.status, current.body ?? "", current.headers ?? {});
          return;
        case "malformed":
          send(res, 200, current.body ?? "{not json", {
            "content-type": "application/json",
          });
          return;
        case "delay":
          await sleep(current.ms);
          current = current.then ?? { kind: "answer" };
          continue;
        case "answer":
          sendAnswer(current, received, parsed, res);
          return;
      }
    }
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
    } catch {
      return; // client went away mid-body
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = undefined;
    }
    const received: ReceivedRequest = {
      method: req.method ?? "",
      path: pathnameOf(req),
      headers: { ...req.headers },
      rawBody,
      json,
    };
    requests.push(received);

    if (received.method !== "POST" || !SYSTEMONE_PATHS.has(received.path)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    const parsed = SystemOneRequest.safeParse(json);
    const requestBody = parsed.success ? parsed.data : undefined;

    const scripted =
      queued.length > 0
        ? queued.shift()
        : handler?.(requests.length - 1, received);

    if (scripted === undefined) {
      if (requestBody === undefined) {
        sendJson(res, 422, {
          error: { message: "body is not a valid System One request" },
        });
        return;
      }
      sendAnswer({ kind: "answer" }, received, requestBody, res);
      return;
    }
    await applyReply(scripted, received, requestBody, res);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {
      // A client abort mid-response must not crash the mock process.
    });
    void handleRequest(req, res);
  });

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      // Destroys keep-alive and in-flight sockets, including `hang` replies,
      // so server.close() resolves instead of waiting on them.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    })();
    return closePromise;
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === "string") {
        reject(new Error("mock Jev server did not bind a TCP port"));
        return;
      }
      const origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        url: `${origin}/v1/systemone`,
        port: address.port,
        requests,
        queue(reply: MockReply): void {
          queued.push(reply);
        },
        setHandler(
          fn: (
            callIndex: number,
            request: ReceivedRequest,
          ) => MockReply | undefined,
        ): void {
          handler = fn;
        },
        close,
      });
    });
  });
}
