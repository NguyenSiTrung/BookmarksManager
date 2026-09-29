import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
} from "../../src/schemas/provider";
import {
  readAiConnected,
  useAiConnected,
} from "../../src/entrypoints/sidepanel/useAiConnected";
import {
  WIDE_QUERY,
  useIsWide,
} from "../../src/entrypoints/sidepanel/useIsWide";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const mql = {
    matches: initial,
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) =>
      listeners.delete(cb),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      return mql;
    }),
  );
  return {
    queries,
    set(next: boolean) {
      mql.matches = next;
      for (const cb of listeners) cb();
    },
  };
}

describe("useIsWide", () => {
  it("reports wide when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useIsWide());
    expect(result.current).toBe(true);
  });

  it("follows the 640px media query and reacts to changes", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsWide());
    expect(result.current).toBe(false);
    expect(media.queries).toContain(WIDE_QUERY);
    expect(WIDE_QUERY).toBe("(min-width: 640px)");

    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });
});

describe("useAiConnected", () => {
  beforeAll(async () => {
    await db.open();
  });
  afterAll(() => {
    db.close();
  });
  beforeEach(async () => {
    await db.consents.clear();
  });

  const row = (scope: string, version = CONSENT_VERSION) => ({
    scope: scope as typeof DECISIONS_CONSENT_SCOPE,
    origin: "https://provider.example",
    consentVersion: version,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });

  it("is false with no consent rows", async () => {
    expect(await readAiConnected()).toBe(false);
  });

  it("ignores the synthetic test-connection scope", async () => {
    await db.consents.put(row(CONSENT_SCOPE));
    expect(await readAiConnected()).toBe(false);
  });

  it("ignores stale consent versions", async () => {
    await db.consents.put(row(DECISIONS_CONSENT_SCOPE, CONSENT_VERSION - 1));
    expect(await readAiConnected()).toBe(false);
  });

  it("is true for a current decisions consent, live", async () => {
    const { result } = renderHook(() => useAiConnected());
    expect(result.current).toBe(false);
    await db.consents.put(row(DECISIONS_CONSENT_SCOPE));
    await waitFor(() => expect(result.current).toBe(true));
  });
});
