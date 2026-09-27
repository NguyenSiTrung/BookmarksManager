import { expect, test } from "@playwright/test";
import {
  collectOutboundRequests,
  openSurface,
  startExtension,
} from "./helpers/extension";
import {
  abortProviderRequests,
  consentRows,
  enableTypesafe,
  launchProviderExtension,
  routeFakeTypesafe,
  sendProviderMessage,
  sentLogRows,
  waitForProviderStatus,
} from "./helpers/provider";
import { PRESETS } from "../../src/net/presets";

/**
 * Phase 4 Task 2 (track spec FR8) — real-browser coverage of the Options
 * provider setup and Test-connection flow.
 *
 * What is real end to end: the Options React UI, `chrome.runtime.sendMessage`
 * crossing the page↔worker boundary, the worker's `handleProviderMessage`
 * re-verification (trusted sender, model allowlist, `permissions.contains`),
 * consent/settings/encrypted-key persistence, the scoped `sendConsented`
 * gate, the genuine `fetch` it issues from the service worker, the Jev
 * client's response validation, and the `sentLog` audit write.
 *
 * What is faked, and only there: the wire after Chromium's network stack —
 * `context.route("https://api.typesafe.ai/**")` answers the service worker's
 * fetch with a scripted `SystemOneResponse` (Playwright DOES intercept MV3
 * worker fetches; verified empirically). And in the happy path the host
 * permission is granted at install from a patched-manifest copy of the same
 * build, because `chrome.permissions.request` never resolves under
 * Playwright's Chromium — the promise pends forever headed or headless,
 * real click or CDP `userGesture`, with no prompt window ever appearing
 * (see `helpers/provider.ts`). The Enable button still runs the production
 * handler unchanged: `permissions.request` resolves `true` immediately for
 * an already-held permission, `ENABLE_PROVIDER` flows, and the worker's own
 * permission re-check passes for real.
 */

const E2E_API_KEY = "e2e-typesafe-key-567890ab";
/** Resolved versioned id the fake claims answered — distinct from the
 *  requested `jev-latest` alias so the UI proves it renders response.model. */
const FAKE_RESOLVED_MODEL = "jev-1.13.0";
const FAKE_COST = 0.0042;

test("Options consent flow enables TypeSafe and Test connection sends exactly one request to the faked endpoint", async () => {
  test.setTimeout(90_000);
  const provider = await launchProviderExtension();
  const { context, id } = provider;
  const outbound = collectOutboundRequests(context);
  try {
    const fake = await routeFakeTypesafe(context, {
      model: FAKE_RESOLVED_MODEL,
      cost: FAKE_COST,
    });
    const options = await openSurface(context, id, "options");

    // Setup → consent → Enable, all through the real UI.
    await enableTypesafe(options, { key: E2E_API_KEY, model: "jev-latest" });
    const panel = options.getByRole("group", {
      name: "TypeSafe enabled provider",
    });
    await expect(panel).toContainText("model jev-latest");
    await expect(panel).toContainText("key ending in 90ab");
    await expect(
      options
        .getByRole("status")
        .filter({ hasText: "TypeSafe is enabled." }),
    ).toBeVisible();

    // Consent was persisted at the current version for this origin only.
    expect(await consentRows(options)).toEqual([
      expect.objectContaining({
        scope: "jev_test",
        origin: PRESETS.typesafe.origin,
        consentVersion: 2,
      }),
    ]);

    // Enabling alone must not send a byte — CONSENT_TRIGGER allows egress
    // only on an explicit Test connection action.
    expect(fake.requests).toHaveLength(0);
    expect(outbound.urls).toEqual([]);

    // The one user action that produces traffic.
    await options.getByRole("button", { name: "Test connection" }).click();
    const status = options
      .getByRole("status")
      .filter({ hasText: "Connection test succeeded" });
    await expect(status).toBeVisible();
    await expect(status).toContainText(`model ${FAKE_RESOLVED_MODEL}`);
    await expect(status).toContainText(/answered in \d+ ms/);
    await expect(status).toContainText(`request cost $${FAKE_COST}`);

    // Exactly one POST hit the endpoint, with the fixed synthetic payload and
    // the API key only in the disclosed Authorization header.
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    if (request === undefined) {
      throw new Error("the routed provider endpoint recorded no request");
    }
    expect(request.method).toBe("POST");
    expect(request.url).toBe(PRESETS.typesafe.url);
    expect(request.headers["authorization"]).toBe(`Bearer ${E2E_API_KEY}`);
    expect(request.postData).toEqual({
      model: "jev-latest",
      state: "This is a synthetic connection test with no bookmark content.",
      questions: {
        test: {
          type: "noul",
          instructions: "Is this a synthetic connection test?",
        },
      },
    });

    // The audit row exists because a request really left — destination,
    // scope, and field names only.
    const rows = await sentLogRows(options);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: PRESETS.typesafe.origin,
      feature: "jev_test",
      fieldNames: ["model", "state", "questions"],
    });
  } finally {
    await context.close();
    provider.dispose();
  }
  outbound.stop();
  // The faked endpoint call was the context's only egress, ever.
  expect(outbound.urls).toEqual([PRESETS.typesafe.url]);
});

test("without consent the Test connection path sends zero requests", async () => {
  test.setTimeout(90_000);
  // The stock build: a fresh install holds no consent, no permission, no key.
  const ext = await startExtension();
  const { context, id } = ext;
  const outbound = collectOutboundRequests(context);
  // A recording black hole on the provider origin: an attempted send can
  // neither escape nor pass unnoticed.
  const guard = await abortProviderRequests(context);
  try {
    const options = await openSurface(context, id, "options");
    await waitForProviderStatus(options);

    // UI gate: Enable stays disabled until the affirmative-consent box is
    // checked, and no Test button exists while the provider is off.
    await options.getByLabel("API key").fill(E2E_API_KEY);
    const enable = options.getByRole("button", { name: "Enable TypeSafe" });
    await expect(enable).toBeDisabled();
    await options.getByLabel(/agree to enable/).check();
    await expect(enable).toBeEnabled();
    await expect(
      options.getByRole("button", { name: "Test connection" }),
    ).toHaveCount(0);

    // Attempting the send at the message layer — the exact call the Test
    // click would make — is refused by the worker before any transport is
    // touched (`not_enabled` precedes the gate's consent check).
    const reply = await sendProviderMessage(options, {
      type: "TEST_PROVIDER",
      preset: "typesafe",
    });
    expect(reply).toMatchObject({
      ok: false,
      code: "not_enabled",
    });
    expect(await sentLogRows(options)).toHaveLength(0);
  } finally {
    await context.close();
  }
  outbound.stop();
  expect(
    guard.requests,
    "no request to the provider origin may be attempted without consent",
  ).toEqual([]);
  expect(outbound.urls).toEqual([]);
});
