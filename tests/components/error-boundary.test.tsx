import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import {
  CLIENT_ERRORS_KEY,
  ErrorBoundary,
  installClientErrorReporting,
  reportClientError,
  type ClientErrorRecord,
} from "../../src/ui/components/ErrorBoundary";

/**
 * Crash containment (spec U10): a render error swaps in a Reload fallback
 * and is reported — `console.error` plus a bounded diagnostics row in
 * `db.metadata` — instead of blanking the surface silently. A global
 * `unhandledrejection` listener routes stray rejections through the same
 * channel.
 */

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
afterEach(() => cleanup());
afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
});

let errorSpy: ReturnType<typeof vi.spyOn>;

async function errorRecords(): Promise<ClientErrorRecord[]> {
  const row = await db.metadata.get(CLIENT_ERRORS_KEY);
  return Array.isArray(row?.value) ? (row.value as ClientErrorRecord[]) : [];
}

beforeEach(async () => {
  await db.metadata.clear();
  // React also reports caught errors on console.error — spy quietens the
  // noise while remaining the assertion target for our reporter.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
});

function Bomb(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("renders children while nothing has thrown", () => {
    render(
      <ErrorBoundary surface="sidepanel">
        <p>healthy</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the Reload fallback for a throwing child and reports the error", async () => {
    render(
      <ErrorBoundary surface="sidepanel">
        <Bomb />
      </ErrorBoundary>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/something went wrong/i);
    expect(alert.textContent).toMatch(/sidepanel/);

    // location.reload is non-configurable in jsdom, so the pin is the
    // control itself: present, labeled, and safe to click (jsdom logs a
    // not-implemented navigation notice rather than throwing).
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    const reported = await waitFor(async () => {
      const records = await errorRecords();
      expect(records.length).toBeGreaterThan(0);
      return records;
    });
    expect(reported.at(-1)).toMatchObject({
      surface: "sidepanel",
      name: "Error",
      message: "kaboom",
    });
  });
});

describe("unhandledrejection reporting", () => {
  it("reports a rejected promise on the surface channel, not silent", async () => {
    installClientErrorReporting("popup");
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: new Error("dropped rejection"),
      }),
    );
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropped rejection"),
      ),
    );
    // Each installed listener records on its own surface channel — find
    // this test's row, not just the last one written.
    const records = await waitFor(async () => {
      const rows = await errorRecords();
      expect(
        rows.some(
          (row) =>
            row.surface === "popup" && row.message === "dropped rejection",
        ),
      ).toBe(true);
      return rows;
    });
    expect(
      records.find(
        (row) => row.surface === "popup" && row.message === "dropped rejection",
      ),
    ).toMatchObject({ name: "Error" });
  });

  it("reports a synchronous throw dispatched as an error event", async () => {
    installClientErrorReporting("options");
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("sync boom"),
        message: "Uncaught Error: sync boom",
      }),
    );
    await waitFor(async () => {
      const records = await errorRecords();
      expect(
        records.some(
          (row) =>
            row.surface === "options" && row.message === "sync boom",
        ),
      ).toBe(true);
    });
  });

  it("describes non-Error rejection reasons", async () => {
    installClientErrorReporting("options");
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", {
        promise: Promise.resolve(),
        reason: "plain string reason",
      }),
    );
    await waitFor(async () => {
      const records = await errorRecords();
      expect(
        records.some(
          (row) =>
            row.surface === "options" &&
            row.message === "plain string reason",
        ),
      ).toBe(true);
    });
  });
});

describe("reportClientError", () => {
  it("bounds the diagnostics ring at ten records, newest last", async () => {
    for (let i = 0; i < 12; i += 1) {
      await reportClientError("options", new Error(`failure ${i}`));
    }
    const records = await errorRecords();
    expect(records).toHaveLength(10);
    expect(records.at(-1)?.message).toBe("failure 11");
    expect(records.at(0)?.message).toBe("failure 2");
  });

  it("truncates long messages and never stores the stack", async () => {
    const long = new Error("x".repeat(500));
    await reportClientError("sidepanel", long);
    const [record] = await errorRecords();
    expect(record?.message).toHaveLength(300);
    expect(record).not.toHaveProperty("stack");
  });
});
