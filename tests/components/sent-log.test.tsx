import "fake-indexeddb/auto";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { SentLog } from "../../src/entrypoints/options/SentLog";

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
beforeEach(async () => {
  await db.sentLog.clear();
  await db.usage.clear();
});
afterEach(cleanup);
afterAll(() => db.close());

it("renders every safe outcome and preserves metadata for legacy unknown rows", async () => {
  for (const [index, outcome] of ([undefined, "ok", "retried", "timeout", "redirect", "transport", "http_503"] as const).entries()) {
    await db.sentLog.add({
      sentAt: `2026-09-25T10:05:0${index}.000Z`,
      destination: `https://provider-${index}.example`,
      feature: "llm_explain",
      fieldNames: ["model", "messages"],
      ...(outcome === undefined ? {} : { outcome }),
    });
  }
  render(<SentLog />);
  await screen.findByText("https://provider-0.example");
  for (const [index, outcome] of ["Unknown / pending", "ok", "retried", "timeout", "redirect", "transport", "http_503"].entries()) {
    const row = screen.getByText(`https://provider-${index}.example`).closest("li")!;
    expect(within(row).getByText(outcome)).toBeTruthy();
    expect(within(row).getByText("model, messages")).toBeTruthy();
    expect(within(row).getByText("llm_explain")).toBeTruthy();
  }
});
