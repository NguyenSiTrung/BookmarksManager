import { describe, expect, it, vi } from "vitest";
import { BodyCapError, MAX_RESPONSE_BYTES, MAX_RESPONSE_DEPTH, readJsonCapped } from "../../src/net/body";

function streamOf(
  chunks: string[],
  cancel?: () => void,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    ...(cancel === undefined ? {} : { cancel }),
  });
  return new Response(stream, { status: 200 });
}

describe("readJsonCapped (A06)", () => {
  it("parses an ordinary success body", async () => {
    const response = new Response(JSON.stringify({ a: [1, { b: "c" }] }));
    expect(await readJsonCapped(response)).toEqual({ a: [1, { b: "c" }] });
  });

  it("rejects a body over the byte cap and cancels the stream", async () => {
    const cancel = vi.fn();
    const response = streamOf(
      ["x".repeat(MAX_RESPONSE_BYTES), "y"],
      cancel,
    );
    await expect(readJsonCapped(response)).rejects.toBeInstanceOf(BodyCapError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a body exactly at the byte cap", async () => {
    // {"v":""} is 8 chars of envelope — fill to exactly the cap.
    const fill = "x".repeat(MAX_RESPONSE_BYTES - 8);
    const response = new Response(`{"v":"${fill}"}`);
    expect(await readJsonCapped(response)).toEqual({ v: fill });
  });

  it("rejects a deeply nested body before parse", async () => {
    const nested = "[".repeat(MAX_RESPONSE_DEPTH + 1) + "]".repeat(MAX_RESPONSE_DEPTH + 1);
    await expect(readJsonCapped(new Response(nested))).rejects.toBeInstanceOf(BodyCapError);
  });

  it("accepts a body nested exactly at the depth cap", async () => {
    const nested = "[".repeat(MAX_RESPONSE_DEPTH) + "]".repeat(MAX_RESPONSE_DEPTH);
    await expect(readJsonCapped(new Response(nested))).resolves.toBeDefined();
  });

  it("ignores structure inside strings and escapes", async () => {
    const deep = `{ "a": "${"{".repeat(80)}", "b": "\\"${"[".repeat(80)}" }`;
    expect(await readJsonCapped(new Response(deep))).toEqual({
      a: "{".repeat(80),
      b: `"${"[".repeat(80)}`,
    });
  });

  it("propagates a malformed body as a plain parse error", async () => {
    await expect(readJsonCapped(new Response("not json{"))).rejects.toBeInstanceOf(SyntaxError);
  });

  it("rejects a body that is not valid UTF-8", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await expect(readJsonCapped(new Response(stream))).rejects.toThrow();
  });

  it("rejects a response with no readable body", async () => {
    const response = new Response(null);
    await expect(readJsonCapped(response)).rejects.toBeInstanceOf(BodyCapError);
  });
});
