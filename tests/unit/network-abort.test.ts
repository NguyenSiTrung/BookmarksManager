import { describe, expect, it } from "vitest";
import { classifyAbort } from "../../src/net/abort";

describe("content-free outbound abort classification", () => {
  it.each([
    ["TimeoutError", "AbortError", "timeout"],
    ["AbortError", "TimeoutError", "aborted"],
  ] as const)("signal %s overrides fetch %s", (reasonName, causeName, expected) => {
    const controller = new AbortController();
    controller.abort(new DOMException("private reason", reasonName));
    expect(classifyAbort(controller.signal, new DOMException("private cause", causeName))).toBe(expected);
  });

  it.each([undefined, null, "private reason", { secret: "private reason" }])(
    "treats arbitrary caller reasons as aborts, not deadlines",
    (reason) => {
      const controller = new AbortController();
      controller.abort(reason);
      expect(classifyAbort(controller.signal, new DOMException("private cause", "TimeoutError"))).toBe("aborted");
    },
  );

  it.each([
    ["TimeoutError", "timeout"],
    ["AbortError", "aborted"],
    ["TypeError", undefined],
  ] as const)("recognizes %s without an aborted signal", (name, expected) => {
    expect(classifyAbort(new AbortController().signal, { name })).toBe(expected);
    expect(classifyAbort(undefined, { name })).toBe(expected);
  });

  it("never reads caller/provider error messages", () => {
    const reason = {
      name: "TimeoutError",
      get message(): never { throw new Error("Do not read private content"); },
    };
    const controller = new AbortController();
    controller.abort(reason);
    expect(classifyAbort(controller.signal, reason)).toBe("timeout");
    expect(classifyAbort(undefined, reason)).toBe("timeout");
  });

  it("survives a reason whose name getter throws", () => {
    const reason = {
      get name(): never { throw new Error("Do not read private content"); },
    };
    const controller = new AbortController();
    controller.abort(reason);
    expect(classifyAbort(controller.signal, reason)).toBe("aborted");
    expect(classifyAbort(undefined, reason)).toBeUndefined();
  });
});
