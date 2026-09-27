import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type { SystemOneResponse } from "../../../src/jev/wire";
import { PRESETS } from "../../../src/net/presets";
import { DB_NAME } from "./db";
import {
  captureRequest,
  launchProviderExtension,
  readStoreRows,
  type CapturedProviderRequest,
  type ProviderExtension,
  type ProviderLaunchOptions,
} from "./provider";

/**
 * Decisions-protocol e2e plumbing (Phase 5 Task 1): a scriptable Playwright
 * route that answers EVERY question a real `SystemOneRequest` asks, consent
 * and seeding helpers, typed store readers, request-body cleanliness
 * assertions, and a relaunchable provider for the restart specs.
 *
 * `routeFakeTypesafe` in `./provider.ts` is not enough here: it answers only
 * the synthetic `test` question, while the client's answer cross-check
 * (`src/jev/client.ts`) rejects responses that miss, add, or mistype answers
 * for the questions actually asked. This fake parses each request's
 * `questions` record and answers every entry by type, so the real pipeline,
 * client, gate, and persistence run end to end against it.
 */

/**
 * Scriptable fields of the fake decisions endpoint's responses. The spec
 * holds this object and the fake re-reads it when each request arrives, so a
 * spec can flip answers between queries (the Ask spec's ranked → no-match
 * legs) by reassigning fields or mutating the nested records — nothing is
 * `readonly`.
 */
export interface FakeDecisionsScript {
  /**
   * Choice answers by question field key (`category`, `folder`, …). A
   * scripted key that is not among the request's criteria options falls back
   * to the first option, so the fake never answers outside the asked set.
   */
  choices: Record<string, string>;
  /**
   * Noul answers by question field key (`tag_<nameKey>`, `candidate_<i>`, …).
   */
  noul: Record<string, number>;
  /** Noul answer for any unscripted noul question; default `0.95`. */
  defaultNoul?: number;
  /** Confidence for choice/score answers; default `0.9`. */
  confidence?: number;
  /** Model id to claim; defaults to echoing the request's own `model`. */
  model?: string;
}

/** Live capture log + valve for the routed fake decisions endpoint. */
export interface FakeDecisionsRoute {
  /** Every request observed at the endpoint, in arrival order. */
  readonly requests: CapturedProviderRequest[];
  /**
   * Open the valve: fulfill every held request and let all later requests
   * through immediately. Hold durations stay well under the client's 10 s
   * per-attempt timeout, so a held request is never aborted and retried —
   * the captured count equals the sent count exactly.
   */
  release(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build a schema-valid `SystemOneResponse` answering exactly the questions
 * `postData` asked — one answer per requested key, each of the asked type,
 * choice probabilities confined to the asked criteria options (the unit
 * suite's two-option `{pick: conf, other: 1-conf}` shape).
 */
function buildFakeResponse(
  postData: unknown,
  script: FakeDecisionsScript,
): SystemOneResponse {
  const questions =
    isRecord(postData) && isRecord(postData.questions)
      ? (postData.questions as Record<string, unknown>)
      : {};
  const answers: SystemOneResponse["answers"] = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!isRecord(question)) continue;
    if (question.type === "choice") {
      const options = isRecord(question.criteria)
        ? Object.keys(question.criteria)
        : [];
      const scripted = script.choices[key];
      const pick =
        scripted !== undefined && options.includes(scripted)
          ? scripted
          : (options[0] ?? "none");
      const confidence = script.confidence ?? 0.9;
      const other = options.find((option) => option !== pick);
      answers[key] = {
        type: "choice",
        choice: pick,
        probabilities:
          other === undefined
            ? { [pick]: 1 }
            : { [pick]: confidence, [other]: 1 - confidence },
        confidence,
      };
    } else if (question.type === "noul") {
      answers[key] = {
        type: "noul",
        noul: script.noul[key] ?? script.defaultNoul ?? 0.95,
      };
    } else if (question.type === "score") {
      const confidence = script.confidence ?? 0.9;
      answers[key] = {
        type: "score",
        score: 1,
        legend: { low: "not a match", high: "a match" },
        probabilities: { low: 1 - confidence, high: confidence },
        confidence,
      };
    }
  }
  const model =
    script.model ??
    (isRecord(postData) && typeof postData.model === "string"
      ? postData.model
      : "jev-fake");
  return {
    model,
    answers,
    usage: { input_tokens: 96, output_tokens: 12 },
  };
}

/**
 * Route the TypeSafe origin with the scriptable decisions fake. The first
 * `autoRelease` requests (default: all) are fulfilled immediately; the rest
 * are HELD at the route until {@link FakeDecisionsRoute.release} — the
 * restart specs use the hold to freeze a scan mid-batch and then close the
 * whole browser on it. Fulfilling is wrapped in `try/catch`: a held request
 * whose context dies must not fail the spec from inside a dead route.
 */
export async function routeFakeDecisions(
  context: BrowserContext,
  script: FakeDecisionsScript,
  options: { autoRelease?: number } = {},
): Promise<FakeDecisionsRoute> {
  const requests: CapturedProviderRequest[] = [];
  const autoRelease = options.autoRelease ?? Number.POSITIVE_INFINITY;
  let released = 0;
  let open = false;
  const waiting: Array<() => void> = [];
  await context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
    let captured: CapturedProviderRequest;
    try {
      captured = captureRequest(route.request());
    } catch {
      return; // The context died mid-capture; nothing to answer.
    }
    requests.push(captured);
    if (!open && released >= autoRelease) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    released += 1;
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildFakeResponse(captured.postData, script)),
      });
    } catch {
      // The context (or this route) died mid-flight — nothing to answer.
    }
  });
  return {
    requests,
    release: () => {
      open = true;
      const wake = [...waiting];
      waiting.length = 0;
      for (const resolve of wake) resolve();
    },
  };
}

/**
 * Grant the `jev_decisions` consent through the real Options UI: check the
 * affirmative-disclosure checkbox, click Allow, and wait for the granted
 * panel. The grant is a direct Dexie write from the Options page — the egress
 * gate re-verifies it on every send, so this is the real production path.
 */
export async function grantDecisionsConsent(page: Page): Promise<void> {
  const checkbox = page.getByLabel(/I have read the disclosure above and agree/);
  await expect(checkbox).toBeVisible({ timeout: 15_000 });
  await checkbox.check();
  const allow = page.getByRole("button", {
    name: "Allow TypeSafe bookmark analysis",
  });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(
    page.getByRole("group", { name: "TypeSafe analysis consent" }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Seed tag definitions straight into the `tags` store (rows must satisfy
 * `TagDef`: `nameKey` is the trim+lowercase of `name`, timestamps ISO). The
 * pipeline ranks candidates from this table, so seeded tags become the
 * `tag_<nameKey>` questions the fake must answer. Throws when the extension
 * database does not exist yet — enable a provider first (seeding must never
 * be the write that creates it).
 */
export async function seedTags(
  page: Page,
  names: readonly string[],
): Promise<void> {
  await page.evaluate(
    async ({ dbName, tagNames }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((info) => info.name === dbName)) {
        throw new Error(
          "The extension database does not exist yet — enable a provider before seeding tags.",
        );
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const now = new Date().toISOString();
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("tags", "readwrite");
          const store = transaction.objectStore("tags");
          for (const name of tagNames) {
            store.put({
              name,
              nameKey: name.trim().toLowerCase(),
              createdAt: now,
              updatedAt: now,
            });
          }
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, tagNames: [...names] },
  );
}

/** A `bookmarkMeta` row as the specs read it (lazy rows: fields optional). */
export interface MetaRow {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly category?: string;
}

/** A `jobs` row as the specs read it. */
export interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly progress: {
    totalBatches: number;
    committedBatches: number;
    processedCount: number;
  };
}

/** Every `decisions` row (pending/applied/…), straight from the store. */
export function decisionsRows(page: Page): Promise<unknown[]> {
  return readStoreRows<unknown>(page, "decisions");
}

/** Every `bookmarkMeta` row — the applied sidecar the specs assert on. */
export function bookmarkMetaRows(page: Page): Promise<MetaRow[]> {
  return readStoreRows<MetaRow>(page, "bookmarkMeta");
}

/** Every `jobs` row — the persisted scan state the restart specs assert on. */
export function jobRows(page: Page): Promise<JobRow[]> {
  return readStoreRows<JobRow>(page, "jobs");
}

/**
 * Assert every captured egress body is minimized: no forbidden substring
 * anywhere in the serialized payload (blocklist tokens, query strings,
 * "notes"), no `notes` field on the state or its bookmark, and every sent
 * URL cleaned (no `?`, `#`, or `@` — query, fragment, and credentials are
 * exactly what `cleanUrl` must strip before send).
 */
export function assertEgressBodiesClean(
  requests: readonly CapturedProviderRequest[],
  forbiddenSubstrings: readonly string[],
): void {
  for (const entry of requests) {
    const raw = JSON.stringify(entry.postData ?? null);
    for (const needle of forbiddenSubstrings) {
      expect(
        raw,
        `egress body must not contain ${JSON.stringify(needle)}`,
      ).not.toContain(needle);
    }
    const state =
      entry.postData !== undefined &&
      typeof entry.postData === "object" &&
      entry.postData !== null &&
      "state" in entry.postData &&
      typeof (entry.postData as { state: unknown }).state === "object" &&
      (entry.postData as { state: unknown }).state !== null
        ? ((entry.postData as { state: Record<string, unknown> }).state)
        : {};
    expect(
      Object.hasOwn(state, "notes"),
      "state must never carry notes",
    ).toBe(false);
    const bookmarks: unknown[] = [
      state.bookmark,
      ...(Array.isArray(state.candidateBookmarks)
        ? state.candidateBookmarks
        : []),
    ];
    for (const bookmark of bookmarks) {
      if (
        typeof bookmark === "object" &&
        bookmark !== null &&
        "url" in bookmark &&
        typeof (bookmark as { url: unknown }).url === "string"
      ) {
        expect(
          Object.hasOwn(bookmark, "notes"),
          "a sent bookmark must never carry notes",
        ).toBe(false);
        expect((bookmark as { url: string }).url).not.toMatch(/[?#@]/);
      }
    }
  }
}

/**
 * A provider launcher whose patched-extension root and profile directory
 * persist across launches: relaunching yields the SAME extension id (id
 * derives from the load path) over the SAME profile, so the extension's
 * IndexedDB (provider settings, consents, job rows) and the Chrome bookmark
 * tree survive `context.close()`. This is how the restart specs emulate a
 * browser restart mid-job — a browser restart subsumes an MV3 worker
 * restart, which no Playwright API can trigger on demand.
 */
export interface RestartableProvider {
  readonly extensionRoot: string;
  readonly profileDir: string;
  /** Launch (or relaunch) the same patched extension on the same profile. */
  launch(
    options?: Omit<ProviderLaunchOptions, "extensionRoot" | "profileDir">,
  ): Promise<ProviderExtension>;
}

export function restartableProvider(): RestartableProvider {
  const extensionRoot = mkdtempSync(path.join(tmpdir(), "bm-e2e-ext-"));
  const profileDir = mkdtempSync(path.join(tmpdir(), "bm-e2e-profile-"));
  return {
    extensionRoot,
    profileDir,
    launch: (options = {}) =>
      launchProviderExtension({ extensionRoot, profileDir, ...options }),
  };
}
