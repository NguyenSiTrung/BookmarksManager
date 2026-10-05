import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { SentLog } from "../../src/entrypoints/options/SentLog";

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
beforeEach(async () => {
  await db.sentLog.clear();
  await db.usage.clear();
  await db.usageMonths.clear();
});
afterEach(cleanup);
afterAll(() => db.close());

it("reads nothing from sentLog while collapsed, then renders after expand (A08)", async () => {
  const orderBySpy = vi.spyOn(db.sentLog, "orderBy");
  await db.sentLog.add({
    sentAt: "2026-09-25T10:05:00.000Z",
    destination: "https://provider-0.example",
    feature: "llm_explain",
    fieldNames: ["model"],
    outcome: "ok",
  });
  render(<SentLog />);
  // Collapsed: the toggle is there, the table was never queried.
  const toggle = await screen.findByRole("button", { name: "Show sent log" });
  expect(screen.queryByText("https://provider-0.example")).toBeNull();
  expect(orderBySpy).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await screen.findByText("https://provider-0.example");
  expect(orderBySpy).toHaveBeenCalledWith("sentAt");
});

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
  fireEvent.click(await screen.findByRole("button", { name: "Show sent log" }));
  await screen.findByText("https://provider-0.example");
  for (const [index, outcome] of ["Unknown / pending", "ok", "retried", "timeout", "redirect", "transport", "http_503"].entries()) {
    const row = screen.getByText(`https://provider-${index}.example`).closest("li")!;
    expect(within(row).getByText(outcome)).toBeTruthy();
    expect(within(row).getByText("model, messages")).toBeTruthy();
    expect(within(row).getByText("llm_explain")).toBeTruthy();
  }
});

it("pages the log and offers a Show-all affordance beyond the first page", async () => {
  for (let index = 0; index < 55; index += 1) {
    await db.sentLog.add({
      sentAt: `2026-09-25T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      destination: `https://provider-${index}.example`,
      feature: "llm_explain",
      fieldNames: ["model"],
      outcome: "ok",
    });
  }
  render(<SentLog />);
  fireEvent.click(await screen.findByRole("button", { name: "Show sent log" }));
  // The newest 50 render; the oldest 5 stay unread until Show all.
  await screen.findByText("https://provider-54.example");
  expect(screen.queryByText("https://provider-4.example")).toBeNull();
  const showAll = await screen.findByRole("button", { name: "Show all 55 entries" });
  fireEvent.click(showAll);
  await screen.findByText("https://provider-0.example");
});

it("folds usageMonths rollups into the usage stat tiles", async () => {
  await db.usage.add({
    model: "jev-1",
    inputTokens: 100,
    outputTokens: 40,
    costUsd: 0.001,
    recordedAt: "2026-10-15T00:00:00.000Z",
    month: "2026-10",
  });
  await db.usageMonths.add({
    key: "|2026-09",
    month: "2026-09",
    requests: 3,
    inputTokens: 300,
    outputTokens: 120,
    costUsd: 0.006,
    unpricedRequests: 1,
  });
  render(<SentLog />);
  // Requests tile: 1 raw + 3 rolled; tokens: 400/160; cost: $0.0070 over
  // 3 priced rows (2 priced in the rollup + 1 raw), 1 unpriced.
  const tiles = await screen.findByLabelText("Usage totals");
  expect(within(tiles).getByText("4")).toBeTruthy();
  expect(within(tiles).getByText("400")).toBeTruthy();
  expect(within(tiles).getByText("160")).toBeTruthy();
  expect(within(tiles).getByText("$0.0070")).toBeTruthy();
  expect(within(tiles).getByText(/3 of 4 priced/)).toBeTruthy();
  expect(within(tiles).getByText(/1 unpriced/)).toBeTruthy();
});
