import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JevClientError } from "../../src/jev/client";
import { JevConnectionError, testJevConnection } from "../../src/jev/connection";
import { makeSyntheticRequest } from "../../src/jev/wire";
import { NetworkGateError, sendConsented } from "../../src/net/send";
import { ProviderKeyError } from "../../src/security/keys";
import {
  responseMissingTestAnswer,
  responseMissingUsage,
  responseWrongTestAnswerType,
  validOpenRouterResponse,
  validTypeSafeResponse,
} from "../fixtures/jev-responses";

/**
 * `sendConsented` — the scoped gate the client's default transport resolves
 * to — is mocked so the connection test never touches consent, keys,
 * permissions, or fetch. `NetworkGateError` stays real so gate-code relay is
 * asserted against the genuine class (same pattern as network-gate.test.ts).
 */
vi.mock("../../src/net/send", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/net/send")>();
  return { ...actual, sendConsented: vi.fn() };
});

const send = vi.mocked(sendConsented);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function expectConnectionFailure(
  response: Response,
  code: string,
): Promise<JevConnectionError> {
  send.mockResolvedValue(response);
  const error = await testJevConnection("typesafe", "jev-latest").catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(JevConnectionError);
  expect((error as JevConnectionError).code).toBe(code);
  return error as JevConnectionError;
}

beforeEach(() => {
  send.mockReset();
});

describe("testJevConnection", () => {
  it("returns the response's versioned model and latency for TypeSafe", async () => {
    send.mockResolvedValue(jsonResponse(validTypeSafeResponse));

    const result = await testJevConnection("typesafe", "jev-latest");

    expect(send).toHaveBeenCalledTimes(1);
    // The client sends through the scoped gate: scope, preset, model, the
    // exact synthetic request, and an AbortSignal for the attempt timeout.
    expect(send).toHaveBeenCalledWith(
      "jev_test",
      "typesafe",
      "jev-latest",
      makeSyntheticRequest("jev-latest"),
      { signal: expect.any(AbortSignal) },
    );
    expect(result.model).toBe("jev-1.13.0");
    expect(Number.isFinite(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // TypeSafe sends no usage.cost — the field stays absent, not zero.
    expect(result.cost).toBeUndefined();
  });

  it("returns model and usage.cost for the OpenRouter response shape", async () => {
    send.mockResolvedValue(jsonResponse(validOpenRouterResponse));

    const result = await testJevConnection("openrouter", "typesafe/jev-1.13");

    expect(send).toHaveBeenCalledWith(
      "jev_test",
      "openrouter",
      "typesafe/jev-1.13",
      makeSyntheticRequest("typesafe/jev-1.13"),
      { signal: expect.any(AbortSignal) },
    );
    expect(result.model).toBe("typesafe/jev-1.13");
    expect(result.cost).toBe(0.000041);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps HTTP 401 to auth guidance without echoing the body", async () => {
    const error = await expectConnectionFailure(
      jsonResponse({ error: "bad key sk-secret-material" }, 401),
      "auth",
    );
    expect(error.message).not.toContain("sk-secret-material");
    expect(error.message).not.toContain("bad key");
  });

  it("maps HTTP 422 to an incompatibility error", async () => {
    const error = await expectConnectionFailure(
      jsonResponse({ detail: "unknown field" }, 422),
      "incompatible",
    );
    expect(error.message).not.toContain("unknown field");
  });

  it("maps retryable HTTP statuses to retry-later guidance without retrying", async () => {
    for (const status of [429, 503, 529]) {
      // maxRetries: 0 — a test connection never retries; the retryable
      // status collapses to retry_later after the single attempt.
      send.mockClear();
      await expectConnectionFailure(jsonResponse({}, status), "retry_later");
      expect(send, String(status)).toHaveBeenCalledTimes(1);
    }
  });

  it("maps other non-2xx statuses to http_error naming only the status", async () => {
    const error = await expectConnectionFailure(
      new Response("forbidden by policy stack trace", { status: 403 }),
      "http_error",
    );
    expect(error.message).toContain("403");
    expect(error.message).not.toContain("stack trace");
  });

  it("maps a gate timeout to the timeout code", async () => {
    send.mockRejectedValue(
      new NetworkGateError("timeout", "The request was aborted."),
    );
    const error = await testJevConnection("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JevConnectionError);
    expect((error as JevConnectionError).code).toBe("timeout");
  });

  it("maps malformed JSON bodies to invalid_response without leaking body fragments", async () => {
    // A V8 SyntaxError embeds a body snippet in its message — neither the
    // connection error nor the client error it wraps may carry a `cause`
    // (or anything serializable) derived from the response.
    const marker = "provider-body-fragment-9x2";
    const error = await expectConnectionFailure(
      new Response(`this is not json ${marker} {`, { status: 200 }),
      "invalid_response",
    );
    expect(error.cause).toBeInstanceOf(JevClientError);
    expect((error.cause as JevClientError).cause).toBeUndefined();
    expect(error.message).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
    // util.inspect walks the cause chain, like console.error/devtools.
    expect(inspect(error, { depth: null })).not.toContain(marker);
  });

  it("maps schema-invalid bodies to invalid_response without echoing them", async () => {
    // A ZodError's issues embed response `input` values — the same rule.
    const error = await expectConnectionFailure(
      jsonResponse(responseMissingUsage),
      "invalid_response",
    );
    expect(error.cause).toBeInstanceOf(JevClientError);
    expect((error.cause as JevClientError).cause).toBeUndefined();
    expect(error.message).not.toContain("jev-1.13.0");
    expect(JSON.stringify(error)).not.toContain("jev-1.13.0");
    expect(inspect(error, { depth: null })).not.toContain("jev-1.13.0");
  });

  it("fails invalid_response when the test answer is missing entirely", async () => {
    await expectConnectionFailure(
      jsonResponse(responseMissingTestAnswer),
      "invalid_response",
    );
  });

  it("fails invalid_response when the test answer is the wrong type", async () => {
    await expectConnectionFailure(
      jsonResponse(responseWrongTestAnswerType),
      "invalid_response",
    );
  });

  it("wraps a thrown NetworkGateError keeping its code and redacted message", async () => {
    for (const code of ["no_consent", "no_permission", "no_key"] as const) {
      const gateError = new NetworkGateError(
        code,
        `redacted gate refusal: ${code}`,
      );
      send.mockReset();
      send.mockRejectedValue(gateError);

      const error = await testJevConnection("typesafe", "jev-latest").catch(
        (caught: unknown) => caught,
      );

      expect(error, code).toBeInstanceOf(JevConnectionError);
      expect((error as JevConnectionError).code, code).toBe(code);
      expect((error as JevConnectionError).message, code).toBe(gateError.message);
    }
  });

  it("propagates ProviderKeyError from the send layer unwrapped", async () => {
    const keyError = new ProviderKeyError(
      'Stored provider key for preset "typesafe" is malformed; reconnect to re-enter it.',
    );
    send.mockRejectedValue(keyError);

    const error = await testJevConnection("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBe(keyError);
  });

  it("propagates non-gate errors from the send layer unwrapped", async () => {
    const weird = new TypeError("unexpected internals");
    send.mockRejectedValue(weird);

    const error = await testJevConnection("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBe(weird);
  });
});
