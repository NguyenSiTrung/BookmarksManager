import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { ReviewView } from "../../src/entrypoints/sidepanel/ReviewView";
import { RestructureView } from "../../src/entrypoints/sidepanel/RestructureView";
import { Decision } from "../../src/schemas/decision";
import type { FeatureConsentApproval } from "../../src/schemas/feature-consent";
import { flattenTree } from "../../src/sync/tree";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";

const APPROVAL: FeatureConsentApproval = {
  providerId: "preset:openai",
  origin: "https://api.openai.com",
  model: "gpt-4o-mini-2024-07-18",
  endpoint: "https://api.openai.com/v1/chat/completions",
  consentVersion: 5,
};
const row = Decision.parse({ ...decisionBase, kind: "set_category", category: "docs" });
const variants = [
  { scope: "llm_explain", type: "LLM_EXPLAIN", button: /^Explain/, label: /Agree and explain/i },
  { scope: "llm_restructure", type: "RESTRUCTURE_START", button: /Propose a layout/, label: /Agree and propose/i },
] as const;

type Intent = { type: string; consentApproval?: FeatureConsentApproval; unknownCostConfirmed?: boolean };
let send: ReturnType<typeof vi.fn<(message: Intent) => Promise<unknown>>>;
let paidRequests: number;
let destinationChanged: boolean;

beforeEach(async () => {
  await db.delete();
  await db.open();
  paidRequests = 0;
  destinationChanged = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

for (const feature of variants) {
  describe(`${feature.scope} affirmative UI flow`, () => {
    async function mount() {
      send = vi.fn(async (message: Intent) => {
        if (message.type === "RESTRUCTURE_STATUS") {
          return { ok: false, code: "not_found", message: "No job." };
        }
        if (message.consentApproval === undefined || destinationChanged) {
          return { ok: false, code: "consent_required", message: "Consent required.",
            consent: { scope: feature.scope, recipient: destinationChanged ? "Custom LLM provider" : "OpenAI",
              approval: destinationChanged ? { ...APPROVAL, origin: "https://new-provider.dev",
                endpoint: "https://new-provider.dev/v1/chat/completions", providerId: "custom:https://new-provider.dev/v1" } : APPROVAL } };
        }
        // Exercise the real UI persistence before acknowledging a retry.
        expect(await db.consents.get([feature.scope, APPROVAL.origin])).toMatchObject({
          scope: feature.scope, consentVersion: 5, origin: APPROVAL.origin,
        });
        if (message.unknownCostConfirmed !== true) {
          return { ok: false, code: "confirmation_required", message: "Unknown price.",
            destinationOrigin: APPROVAL.origin, consentApproval: APPROVAL };
        }
        paidRequests++;
        return feature.scope === "llm_explain"
          ? { ok: true, code: "explain_ok", result: { decisionId: row.id, rationale: "Explained.", model: APPROVAL.model } }
          : { ok: true, code: "job_ok", job: {} };
      });
      vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
      if (feature.scope === "llm_explain") {
        const fake = createFakeBookmarks({ bookmarksBar: [
          { id: "bm-001", title: "A public bookmark", url: "https://public.dev" },
        ] });
        render(<ReviewView decisions={[row]} tree={flattenTree(await fake.getTree())} />);
      } else {
        render(<RestructureView />);
        await screen.findByRole("button", { name: feature.button });
      }
    }

    async function open() {
      const trigger = screen.getByRole("button", { name: feature.button });
      trigger.focus();
      fireEvent.click(trigger);
      return { trigger, dialog: await screen.findByRole("dialog") };
    }

    async function accept(dialog: HTMLElement) {
      fireEvent.click(within(dialog).getByRole("checkbox"));
      const approve = within(dialog).getByRole("button", { name: feature.label });
      fireEvent.click(approve);
      fireEvent.click(approve);
      return screen.findByRole("button", { name: /Send anyway/i });
    }

    it("shows recipient, exact endpoint, fields, purpose and trigger with unchecked consent and safe focus", async () => {
      await mount();
      const { dialog } = await open();
      expect(dialog.textContent).toContain("OpenAI");
      expect(dialog.textContent).toContain(APPROVAL.origin);
      expect(dialog.textContent).toContain(APPROVAL.endpoint);
      expect(dialog.textContent).toContain(feature.scope === "llm_explain" ? "Jev probabilities" : "representative titles (capped)");
      if (feature.scope === "llm_explain") {
        for (const field of ["bookmark title", "cleaned URL", "domain"]) {
          expect(dialog.textContent).toContain(field);
        }
      }
      expect(dialog.textContent).toContain(feature.scope === "llm_explain" ? "plain language" : "folder structure");
      expect(dialog.textContent).toContain("only when you click");
      expect(within(dialog).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      const approve = within(dialog).getByRole("button", { name: feature.label }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: /Don.t send/i }));
      fireEvent.click(approve);
      expect(await db.consents.count()).toBe(0);
      expect(paidRequests).toBe(0);
    });

    it.each(["cancel", "escape", "overlay"] as const)("dismisses via %s without grant or retry and resets approval on reopen", async (dismiss) => {
      await mount();
      const { trigger, dialog } = await open();
      fireEvent.click(within(dialog).getByRole("checkbox"));
      if (dismiss === "cancel") fireEvent.click(within(dialog).getByRole("button", { name: /Don.t send/i }));
      else if (dismiss === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else {
        const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
        await new Promise((resolve) => setTimeout(resolve, 0));
        fireEvent.pointerDown(overlay);
        fireEvent.pointerUp(overlay);
        fireEvent.click(overlay);
      }
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(await db.consents.count()).toBe(0);
      expect(send.mock.calls.filter(([m]) => m.type === feature.type)).toHaveLength(1);
      const reopened = (await open()).dialog;
      expect(within(reopened).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      expect(paidRequests).toBe(0);
    });

    it("grants only the disclosed scope then retains the exact binding through one-shot cost retry", async () => {
      await mount();
      const { dialog } = await open();
      const confirm = await accept(dialog);
      expect(await db.consents.toArray()).toEqual([expect.objectContaining({
        scope: feature.scope, origin: APPROVAL.origin, consentVersion: 5,
      })]);
      expect(paidRequests).toBe(0);
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await waitFor(() => expect(paidRequests).toBe(1));
      const attempts = send.mock.calls.filter(([m]) => m.type === feature.type).map(([m]) => m);
      expect(attempts).toHaveLength(3);
      expect(attempts[1]).toMatchObject({ consentApproval: APPROVAL });
      expect(attempts[1]?.unknownCostConfirmed).toBeUndefined();
      expect(attempts[2]).toMatchObject({ consentApproval: APPROVAL, unknownCostConfirmed: true });
    });

    it("a changed recipient on cost retry opens a new unchecked disclosure without granting or sending to it", async () => {
      await mount();
      const { dialog } = await open();
      const confirm = await accept(dialog);
      destinationChanged = true;
      fireEvent.click(confirm);
      const next = await screen.findByRole("dialog", { name: /Allow/ });
      expect(next.textContent).toContain("https://new-provider.dev");
      expect(within(next).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      expect(await db.consents.count()).toBe(1);
      expect(await db.consents.get([feature.scope, "https://new-provider.dev"])).toBeUndefined();
      expect(paidRequests).toBe(0);
    });

    it("a worker failure after acceptance is redacted and does not leave an endless send or retry", async () => {
      await mount();
      const { dialog } = await open();
      send.mockImplementation(async () => { throw new Error("secret-provider-detail"); });
      fireEvent.click(within(dialog).getByRole("checkbox"));
      fireEvent.click(within(dialog).getByRole("button", { name: feature.label }));
      await screen.findByText("The extension worker is not reachable — nothing was changed.");
      expect(document.body.textContent).not.toContain("secret-provider-detail");
      expect(paidRequests).toBe(0);
    });

    it("a failed consent write stays in the dialog, reports safely and sends no retry", async () => {
      await mount();
      const { dialog } = await open();
      vi.spyOn(db.consents, "put").mockRejectedValue(new Error("private-storage-detail"));
      fireEvent.click(within(dialog).getByRole("checkbox"));
      fireEvent.click(within(dialog).getByRole("button", { name: feature.label }));
      await within(dialog).findByRole("alert");
      expect(dialog.textContent).toContain("Nothing was sent");
      expect(dialog.textContent).not.toContain("private-storage-detail");
      expect(send.mock.calls.filter(([m]) => m.type === feature.type)).toHaveLength(1);
      expect(await db.consents.count()).toBe(0);
      expect(paidRequests).toBe(0);
    });
  });
}
