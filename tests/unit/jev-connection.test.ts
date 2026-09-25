import { beforeEach, describe, expect, it, vi } from "vitest";
import { JevConnectionError, testJevConnection } from "../../src/jev/connection";
import { NetworkGateError, sendConsentedTest } from "../../src/net/send";
import {
  responseMissingTestAnswer,
  responseMissingUsage,
  responseWrongTestAnswerType,
  validOpenRouterResponse,
  validTypeSafeResponse,
} from "../fixtures/jev-responses";

/**
 * `sendConsentedTest` is mocked so the connection test never touches consent,
 * keys, permissions, or fetch — the gate keeps sole ownership of transport.
 * `NetworkGateError` stays real so `gate`-code propagation is asserted against
 * the genuine class (same pattern as network-gate.test.ts).
 */
vi.mock("../../src/net/send", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/net/send")>();
  return { ...actual, sendConsentedTest: vi.fn() };
});

const send = vi.mocked(sendConsentedTest);

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
    expect(send).toHaveBeenCalledWith("typesafe", "jev-latest");
    expect(result.model).toBe("jev-1.13.0");
    expect(Number.isFinite(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // TypeSafe sends no usage.cost — the field stays absent, not zero.
    expect(result.cost).toBeUndefined();
  });

  it("returns model and usage.cost for the OpenRouter response shape", async () => {
    send.mockResolvedValue(jsonResponse(validOpenRouterResponse));

    const result = await testJevConnection("openrouter", "typesafe/jev-1.13");

    expect(send).toHaveBeenCalledWith("openrouter", "typesafe/jev-1.13");
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

  it.each([429, 529])(
    "maps HTTP %i to retry-later guidance",
    async (status) => {
      await expectConnectionFailure(jsonResponse({}, status), "retry_later");
    },
  );

  it("maps other non-2xx statuses to http_error naming only the status", async () => {
    const error = await expectConnectionFailure(
      new Response("server exploded with stack trace", { status: 503 }),
      "http_error",
    );
    expect(error.message).toContain("503");
    expect(error.message).not.toContain("stack trace");
  });

  it("maps malformed JSON bodies to invalid_response", async () => {
    await expectConnectionFailure(
      new Response("this is not json {", { status: 200 }),
      "invalid_response",
    );
  });

  it("maps schema-invalid bodies to invalid_response without echoing them", async () => {
    const error = await expectConnectionFailure(
      jsonResponse(responseMissingUsage),
      "invalid_response",
    );
    expect(error.message).not.toContain("jev-1.13.0");
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

  it("wraps a thrown NetworkGateError as code gate, preserving its redacted message", async () => {
    const gateError = new NetworkGateError(
      "no_consent",
      'No current jev_test consent grant for preset "typesafe".',
    );
    send.mockRejectedValue(gateError);

    const error = await testJevConnection("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(JevConnectionError);
    expect((error as JevConnectionError).code).toBe("gate");
    expect((error as JevConnectionError).message).toBe(gateError.message);
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
