/**
 * Scripted OpenAI-compatible mock for the LLM gate/client tests. Implements
 * the `fetch` surface the gate uses — `POST <base>/chat/completions` — with a
 * recorded request log, canned completions, and a per-attempt failure script
 * (HTTP status, Retry-After, or a thrown transport error). No real network.
 */

export interface MockRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface MockFailure {
  /** Return this HTTP status instead of a completion. */
  readonly status?: number;
  /** Throw this error (simulates a transport failure). */
  readonly throw?: Error;
  /** Retry-After header value, in seconds. */
  readonly retryAfterSeconds?: number;
  /** Error body emitted alongside a non-2xx status. */
  readonly body?: unknown;
}

export interface MockOpenAiOptions {
  /** Completion JSON returned for a successful call (default: fixed reply). */
  readonly completion?: (body: {
    model: string;
    messages: readonly unknown[];
    response_format?: unknown;
  }) => Record<string, unknown>;
  /** Failure script consumed in attempt order; extra attempts succeed. */
  readonly failures?: readonly MockFailure[];
}

export function makeOpenAiServer(options: MockOpenAiOptions = {}): {
  fetch: typeof fetch;
  requests: MockRequest[];
} {
  const requests: MockRequest[] = [];
  const failures = [...(options.failures ?? [])];

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k] = v;
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ url, method: init?.method ?? "GET", headers, body });

    const failure = failures.shift();
    if (failure?.throw !== undefined) {
      throw failure.throw;
    }
    if (failure?.status !== undefined) {
      const headersOut = new Headers();
      if (failure.retryAfterSeconds !== undefined) {
        headersOut.set("retry-after", String(failure.retryAfterSeconds));
      }
      return new Response(JSON.stringify(failure.body ?? { error: "mock" }), {
        status: failure.status,
        headers: headersOut,
      });
    }

    const completion = options.completion?.(
      body as { model: string; messages: readonly unknown[] },
    ) ?? {
      id: "chatcmpl-mock",
      object: "chat.completion",
      model:
        (body as { model?: string } | null)?.model ?? "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "{\"ok\":true}" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, requests };
}
