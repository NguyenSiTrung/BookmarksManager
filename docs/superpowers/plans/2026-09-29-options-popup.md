# Options and Popup Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Options page and quick-save popup to the redesigned standard: consent disclosures collapse by default behind a read gate, the consent facts render once through a shared `ConsentFacts` component, disabled buttons look disabled, and popup search moves into an expanding header control.

**Architecture:** Presentation only. A `ConsentFacts` component in `options/components.tsx` renders the disclosure facts (verbatim from `src/consent/disclosure.ts`) as a compact definition list with chip rows; each of the four consent sites swaps its hand-rolled `<ul>` for it and adds an `openedOnce` gate that disables its checkbox until the disclosure has been opened for the current subject. Button recipes in `options/ui.ts` and the popup Save button swap `pointer-events-none` for a visibly-disabled treatment. The popup header becomes logo + full title + icon cluster, with `Search.tsx` gaining an `onClose` hook so the row can collapse. No consent facts, storage, scopes, or gate logic change.

**Tech Stack:** React 19, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind 4, Vitest + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-29-options-popup-design.md`.

## Global Constraints

- Commit per task, locally, with the message given in the task, then `git notes add -m "<one-line task summary>"`. **Never** `git push`, `git pull` or `git fetch` (AGENTS.md Git Policy). Leave `.beads/issues.jsonl` uncommitted.
- Track work with `bd`, not markdown TODO lists or TodoWrite (AGENTS.md).
- **Do not edit `src/consent/disclosure.ts` constants.** `tests/unit/consent-snapshot.test.ts` pins them; changing a fact string requires a `CONSENT_VERSION` bump, which is out of scope. This sub-project changes presentation only.
- Theme tokens only (`text-muted-foreground`, `bg-muted`, `text-foreground`, …). No raw palette classes.
- Copy strings, verbatim (single source for every task):
  - Gate reason line: `Open the disclosure above first.` (plain period, rendered in `text-xs text-muted-foreground`).
  - `ConsentFacts` row labels: `Recipient`, `Sent`, `Never sent`, `Why`, `When` (exact, no colon — component tests assert them).
  - Disabled-button tokens: `disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:saturate-50`.
  - Popup header accessible names: `Search bookmarks` (icon button), `Open manager` (icon-only after Task 4, name preserved via `aria-label`), `Settings` (unchanged). The search icon carries `aria-expanded` and `aria-controls="popup-search-row"`.
  - Search row × button: `aria-label`/`title` `Clear search` while the query is non-empty, `Close search` once it is empty.
  - Disclosure summary titles are unchanged: `What enabling {name} means`, `What enabling an LLM provider means`, `What bookmark analysis sends to {name}`, `Automatic second opinions`.
- jsdom does not toggle `<details>` on summary clicks. Tests open a disclosure by flipping the DOM attribute and firing `toggle` directly (the pattern `options-primitives.test.tsx` already uses for `onOpenChange`).
- jsdom does not hide closed `<details>` content from role queries, so content assertions inside a closed disclosure keep passing; only interactions with the now-gated checkbox change.
- Known flaky under full-suite load — re-run the file alone before treating a failure as a regression (`npx vitest run --project components tests/components/<file>`): popup budget, `EditDialog` in `sidepanel-actions`, drag overlay, scan dialog (`sidepanel-scan-ask`), and `tests/unit/search-perf.test.ts`.
- Before each commit that touches code: `npx eslint <touched files>` and `npm run typecheck`. Vitest: `npx vitest run --project unit|components <file>`. e2e needs `npm run build` first, then `xvfb-run -a npx playwright test <spec>`.
- Two documented extensions to the spec's `ConsentFacts` prop list, forced by the spec's own rule that disclosed substance must not change: an optional `recipientNote` (renders `NO_DEVELOPER_SERVER_NOTE` inside the Recipient row, where it lives today) and an optional `sentNote` (renders `SYNTHETIC_DESCRIPTION` as the Sent row's lead-in). Without them, two pinned consent facts would silently disappear from the UI.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/entrypoints/options/ui.ts` | modify | Disabled-state button tokens |
| `src/entrypoints/options/components.tsx` | modify | Add `ConsentFacts` + `consentFactChipClass` |
| `src/entrypoints/options/ProviderSetup.tsx` | modify | `ConsentFacts`, read gate, `armDisclosureGate` |
| `src/entrypoints/options/LlmProviderSetup.tsx` | modify | `ConsentFacts`, read gate |
| `src/entrypoints/options/DecisionSettings.tsx` | modify | `ConsentFacts` ×2, read gates ×2, blocklist spacing |
| `src/entrypoints/popup/App.tsx` | modify | Disabled Save tokens, icon-cluster header, conditional search row |
| `src/entrypoints/popup/Search.tsx` | modify | `onClose` prop, autofocus, × closes when clear |
| `tests/unit/options-button-recipes.test.ts` | create | Button recipe contract |
| `tests/components/options-primitives.test.tsx` | modify | `ConsentFacts` describe |
| `tests/components/provider-setup.test.tsx` | modify | `openDisclosure` helper, gate tests, label assertion updates |
| `tests/components/options-llm-provider.test.tsx` | modify | Same for the LLM card |
| `tests/components/options-decisions.test.tsx` | modify | Same for bookmark analysis |
| `tests/components/options-llm-settings.test.tsx` | modify | Escalation gate test, verbatim-assertion update |
| `tests/components/popup-save.test.tsx` | modify | Disabled Save class assertion |
| `tests/components/popup-search.test.tsx` | modify | `openSearch` harness, header-search tests |
| `tests/e2e/helpers/{llm,provider,decisions}.ts` | modify | Open disclosures before agree boxes |
| `tests/e2e/{llm,provider}.spec.ts` | modify | Same for two direct checkbox uses |
| `/tmp/capture/capture-options-popup-after.mjs` | create (Task 6) | Post-change screenshots |

---

### Task 0: Track the work

**Files:** none (bd only — no spec amendment is needed; every code-level detail this plan settled matched the spec).

- [ ] **Step 1: Create the bd epic and children**

```bash
bd create "UI redesign: options and popup polish (disclosures, consent facts, buttons, header search)" -t epic -p 2 --json
```

Note the returned epic id, then create two children and link them (creating with a parent flag has failed before, so link afterwards):

```bash
bd create "Disabled buttons, ConsentFacts dedup (plan Tasks 1-2)" -t task -p 2 --json
bd create "Read gates, popup header search, incidental fixes, capture (plan Tasks 3-6)" -t task -p 2 --json
bd update <child1-id> --parent <epic-id>
bd update <child2-id> --parent <epic-id>
bd update <child1-id> --claim
```

No commit in this task.

---

### Task 1: Visibly disabled buttons

**Files:**
- Create: `tests/unit/options-button-recipes.test.ts`
- Modify: `src/entrypoints/options/ui.ts`, `src/entrypoints/popup/App.tsx`, `tests/components/popup-save.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/options-button-recipes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  dangerButtonClass,
  ghostDangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
} from "../../src/entrypoints/options/ui";

/**
 * Disabled-state contract (options-popup plan Task 1): a disabled button is
 * visibly disabled — not-allowed cursor, dimmed, desaturated, no shadow —
 * and keeps receiving pointer events so the cursor (and future tooltips)
 * can work. `pointer-events-none` is the bug this pins against.
 */
const DISABLED_TOKENS = [
  "disabled:cursor-not-allowed",
  "disabled:opacity-60",
  "disabled:shadow-none",
  "disabled:saturate-50",
] as const;

describe("options button recipes", () => {
  for (const [name, className] of [
    ["primaryButtonClass", primaryButtonClass],
    ["dangerButtonClass", dangerButtonClass],
    ["secondaryButtonClass", secondaryButtonClass],
    ["ghostDangerButtonClass", ghostDangerButtonClass],
    ["smallButtonClass", smallButtonClass],
  ] as const) {
    it(`${name} renders disabled buttons visibly disabled`, () => {
      for (const token of DISABLED_TOKENS) {
        expect(className).toContain(token);
      }
      expect(className).not.toContain("pointer-events-none");
    });
  }
});
```

In `tests/components/popup-save.test.tsx`, extend the blank-URL test ("keeps Save disabled for a blank URL") — replace its body's final assertion block:

```tsx
  it("keeps Save disabled for a blank URL", async () => {
    await renderPopup();
    fireEvent.change(urlInput(), { target: { value: "   " } });
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Task 1: the disabled state must read as disabled — dimmed,
    // desaturated, not-allowed cursor — not a normal-looking button.
    expect(save.className).toContain("disabled:cursor-not-allowed");
    expect(save.className).toContain("disabled:saturate-50");
    expect(save.className).not.toContain("pointer-events-none");
  });
```

- [ ] **Step 2: Run them and see them fail**

```bash
npx vitest run --project unit tests/unit/options-button-recipes.test.ts
npx vitest run --project components tests/components/popup-save.test.tsx
```

- [ ] **Step 3: Implement**

In `src/entrypoints/options/ui.ts`, replace the last line of `buttonBase`:

```ts
const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 " +
  "text-sm font-medium transition-all duration-150 active:scale-[0.98] " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none " +
  "disabled:saturate-50";
```

and the last line of `smallButtonClass`:

```ts
export const smallButtonClass =
  "inline-flex items-center gap-1 rounded-md border border-border bg-card " +
  "px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none " +
  "disabled:saturate-50";
```

In `src/entrypoints/popup/App.tsx` (the Save button's `className`, ~line 784), replace `disabled:pointer-events-none disabled:opacity-50` with `disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:saturate-50`.

- [ ] **Step 4: Run the tests again and see them pass** (same commands as Step 2).

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/entrypoints/options/ui.ts src/entrypoints/popup/App.tsx tests/unit/options-button-recipes.test.ts tests/components/popup-save.test.tsx
npm run typecheck
git add src/entrypoints/options/ui.ts src/entrypoints/popup/App.tsx tests/unit/options-button-recipes.test.ts tests/components/popup-save.test.tsx
git commit -m "feat(ui): make disabled buttons visibly disabled"
git notes add -m "Task 1: button recipes and popup Save use cursor-not-allowed/opacity-60/shadow-none/saturate-50 instead of pointer-events-none/opacity-50"
```

---

### Task 2: `ConsentFacts` — one rendering of the consent facts

**Files:**
- Modify: `src/entrypoints/options/components.tsx`, `src/entrypoints/options/ProviderSetup.tsx`, `src/entrypoints/options/LlmProviderSetup.tsx`, `src/entrypoints/options/DecisionSettings.tsx`
- Modify: `tests/components/options-primitives.test.tsx`, `tests/components/provider-setup.test.tsx`, `tests/components/options-llm-provider.test.tsx`, `tests/components/options-llm-settings.test.tsx`

- [ ] **Step 1: Write the failing component tests**

In `tests/components/options-primitives.test.tsx`: add `ConsentFacts` to the import from `../../src/entrypoints/options/components`, and add this describe inside the top-level `describe`:

```tsx
  describe("ConsentFacts", () => {
    it("renders every provided row and the children", () => {
      render(
        <ConsentFacts
          recipientName="TypeSafe"
          origin="https://api.typesafe.ai"
          recipientNote="This extension has no server of its own."
          sent={["model", "state"]}
          neverSent={["notes"]}
          why="check that your key works"
          when="only on Test connection"
        >
          <p>Stored encrypted on this device.</p>
        </ConsentFacts>,
      );
      expect(screen.getByText("Recipient")).toBeTruthy();
      expect(screen.getByText("Sent")).toBeTruthy();
      expect(screen.getByText("Never sent")).toBeTruthy();
      expect(screen.getByText("Why")).toBeTruthy();
      expect(screen.getByText("When")).toBeTruthy();
      expect(screen.getByText("model")).toBeTruthy();
      expect(screen.getByText("state")).toBeTruthy();
      expect(screen.getByText("notes")).toBeTruthy();
      expect(screen.getByText(/check that your key works/)).toBeTruthy();
      expect(screen.getByText(/only on Test connection/)).toBeTruthy();
      expect(screen.getByText("Stored encrypted on this device.")).toBeTruthy();
      expect(
        screen.getByText(/the only destination this consent covers/),
      ).toBeTruthy();
      expect(
        screen.getByText(/This extension has no server of its own/),
      ).toBeTruthy();
    });

    it("omits absent rows", () => {
      render(
        <ConsentFacts
          recipientName="your provider"
          origin="https://llm.example.com"
          sent={["model"]}
        />,
      );
      expect(screen.getByText("Recipient")).toBeTruthy();
      expect(screen.getByText("Sent")).toBeTruthy();
      expect(screen.queryByText("Never sent")).toBeNull();
      expect(screen.queryByText("Why")).toBeNull();
      expect(screen.queryByText("When")).toBeNull();
    });

    it("renders each fact exactly once (no sent/never-sent duplication)", () => {
      render(
        <ConsentFacts
          recipientName="TypeSafe"
          origin="https://api.typesafe.ai"
          sent={["bookmark title", "domain"]}
          neverSent={["notes", "page text"]}
          why="categorize"
          when="saving a bookmark"
        />,
      );
      // The merged-duplication regression: the never-sent facts appear only
      // in the Never sent row, never echoed in the Sent row's prose.
      expect(screen.getAllByText("notes")).toHaveLength(1);
      expect(screen.getAllByText("page text")).toHaveLength(1);
      expect(screen.getAllByText("bookmark title")).toHaveLength(1);
    });
  });
```

Also update the two copy-dependent label assertions this task makes stale:

- `tests/components/provider-setup.test.tsx`, in "names the recipient, literal origin, …": `view.getByText(/Recipient:/)` → `view.getByText("Recipient")`; `view.getByText(/why:/i)` → `view.getByText("Why")`; `view.getByText(/when:/i)` → `view.getByText("When")`.
- `tests/components/options-llm-provider.test.tsx`, in "names the recipient, exact origin, …": `view.getByText(/why:/i)` → `view.getByText("Why")`; `view.getByText(/when:/i)` → `view.getByText("When")`.
- `tests/components/options-llm-settings.test.tsx`, in "renders the disclosure verbatim and the toggle off by default": replace

```tsx
    expect(
      screen.getByText(/decision state.*Jev answer/s),
    ).toBeTruthy();
```

  with

```tsx
    const region = screen.getByRole("region", {
      name: "Second opinion disclosure",
    });
    expect(region.textContent).toContain("decision state");
    expect(region.textContent).toContain("Jev answer");
```

- [ ] **Step 2: Run and see the new tests fail**

```bash
npx vitest run --project components tests/components/options-primitives.test.tsx
npx vitest run --project components tests/components/provider-setup.test.tsx tests/components/options-llm-provider.test.tsx tests/components/options-llm-settings.test.tsx
```

(The three updated files fail until Step 3 lands; everything else in them still passes because jsdom finds closed-disclosure content and `textContent` assertions are layout-independent.)

- [ ] **Step 3: Implement `ConsentFacts`**

In `src/entrypoints/options/components.tsx`, after `Disclosure`:

```tsx
/** Chip styling shared by `ConsentFacts` rows and per-site extras. */
export const consentFactChipClass =
  "rounded bg-muted px-1.5 py-0.5 text-xs text-foreground";

/**
 * One rendering of the consent facts every disclosure shares
 * (options-popup plan Task 2): Recipient, Sent, Never sent, Why, When —
 * absent rows omitted, `children` carrying per-site extras (credential
 * handling, data note, policy links) after the definition list. The facts
 * stay verbatim from `src/consent/disclosure.ts`; presentation only,
 * pinned by `tests/unit/consent-snapshot.test.ts`.
 */
export function ConsentFacts(props: {
  recipientName: string;
  origin: string;
  /** Rendered inside the Recipient row (e.g. `NO_DEVELOPER_SERVER_NOTE`). */
  recipientNote?: string;
  sent: readonly string[];
  /** Lead-in line inside the Sent row (e.g. the synthetic-payload note). */
  sentNote?: string;
  neverSent?: readonly string[];
  why?: string;
  when?: string;
  children?: ReactNode;
}) {
  const labelClass =
    "text-xs font-medium tracking-wide text-foreground uppercase";
  return (
    <div className="space-y-2.5 text-sm text-muted-foreground">
      <dl className="space-y-2.5">
        <div>
          <dt className={labelClass}>Recipient</dt>
          <dd className="mt-1">
            {props.recipientName} at{" "}
            <code className={consentFactChipClass}>{props.origin}</code> —
            the only destination this consent covers.
            {props.recipientNote !== undefined && ` ${props.recipientNote}`}
          </dd>
        </div>
        <div>
          <dt className={labelClass}>Sent</dt>
          <dd className="mt-1.5">
            {props.sentNote !== undefined && (
              <p className="mb-1.5">{props.sentNote}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {props.sent.map((field) => (
                <code key={field} className={consentFactChipClass}>
                  {field}
                </code>
              ))}
            </div>
          </dd>
        </div>
        {props.neverSent !== undefined && (
          <div>
            <dt className={labelClass}>Never sent</dt>
            <dd className="mt-1.5 flex flex-wrap gap-1.5">
              {props.neverSent.map((field) => (
                <code key={field} className={consentFactChipClass}>
                  {field}
                </code>
              ))}
            </dd>
          </div>
        )}
        {props.why !== undefined && (
          <div>
            <dt className={labelClass}>Why</dt>
            <dd className="mt-1">{props.why}.</dd>
          </div>
        )}
        {props.when !== undefined && (
          <div>
            <dt className={labelClass}>When</dt>
            <dd className="mt-1">{props.when}.</dd>
          </div>
        )}
      </dl>
      {props.children}
    </div>
  );
}
```

- [ ] **Step 4: Use it at the four sites**

**(a) `ProviderSetup.tsx`** — add `ConsentFacts` and `consentFactChipClass` to the `./components` import, then replace the `<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">…</ul>` inside the `What enabling {disclosure.name} means` disclosure with:

```tsx
          <ConsentFacts
            recipientName={disclosure.name}
            origin={disclosure.origin}
            recipientNote={NO_DEVELOPER_SERVER_NOTE}
            sent={[...SYNTHETIC_FIELDS]}
            sentNote={SYNTHETIC_DESCRIPTION}
            why={CONSENT_PURPOSE}
            when={CONSENT_TRIGGER}
          >
            <p>
              Your API key travels only in the{" "}
              <code className={consentFactChipClass}>
                {AUTHORIZATION_HEADER}
              </code>{" "}
              header to {disclosure.origin}. It is stored encrypted on this
              device and never shown again.
            </p>
            <p>{disclosure.dataNote}</p>
            {disclosure.privacyPolicyUrl !== undefined ? (
              <p>
                Read the{" "}
                <a
                  href={disclosure.privacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
                >
                  {disclosure.name} privacy policy
                </a>
                ; this extension&apos;s own draft policy is bundled below.
              </p>
            ) : (
              <p>
                A custom endpoint has no bundled policy link — review that
                provider&apos;s own privacy policy; this extension&apos;s
                draft policy is bundled below.
              </p>
            )}
          </ConsentFacts>
```

**(b) `LlmProviderSetup.tsx`** — same import addition (`ConsentFacts` and `consentFactChipClass`; `NO_DEVELOPER_SERVER_NOTE` and `LLM_NEVER_SENT` are already imported), then replace the `<ul>` inside `What enabling an LLM provider means` with:

```tsx
          <ConsentFacts
            recipientName="your configured provider"
            origin={disclosureOrigin}
            recipientNote={NO_DEVELOPER_SERVER_NOTE}
            sent={[...TEST_DISCLOSURE.fields]}
            neverSent={[...LLM_NEVER_SENT]}
            why={TEST_DISCLOSURE.purpose}
            when={TEST_DISCLOSURE.trigger}
          >
            <p>{TEST_DISCLOSURE.credentialUse}.</p>
            <p>
              With a credential configured it travels only in the{" "}
              <code className={consentFactChipClass}>Authorization</code> or{" "}
              <code className={consentFactChipClass}>api-key</code> request
              header to {disclosureOrigin}.
            </p>
          </ConsentFacts>
```

The old bullets' `What is sent during setup:` lead-in is covered by the Sent row (fields chips) plus `why`/`when`; `TEST_DISCLOSURE.purpose` renders once, in `Why`.

**(c) `DecisionSettings.tsx`, bookmark-analysis disclosure** — add `ConsentFacts` to the `./components` import, then replace the `<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">…</ul>` (the one whose first bullet is `Recipient: {disclosure.name} at {disclosure.origin}`) with:

```tsx
            <ConsentFacts
              recipientName={disclosure.name}
              origin={disclosure.origin}
              recipientNote={NO_DEVELOPER_SERVER_NOTE}
              sent={[...DECISIONS_SENT_FIELDS]}
              neverSent={[...DECISIONS_NEVER_SENT_FIELDS]}
              why={DECISIONS_PURPOSES.join(", ")}
              when={`${DECISIONS_TRIGGERS.join(", ")} — ${DECISIONS_TRIGGER_NOTE}`}
            >
              <p>{disclosure.dataNote}</p>
              {disclosure.privacyPolicyUrl !== undefined ? (
                <p>
                  Read the{" "}
                  <a
                    href={disclosure.privacyPolicyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
                  >
                    {disclosure.name} privacy policy
                  </a>{" "}
                  and {EXTENSION_PRIVACY_POLICY_REFERENCE}.
                </p>
              ) : (
                <p>
                  A custom endpoint has no bundled policy link — review that
                  provider&apos;s own privacy policy, and{" "}
                  {EXTENSION_PRIVACY_POLICY_REFERENCE}.
                </p>
              )}
            </ConsentFacts>
```

`DECISIONS_DESCRIPTION` ("bookmark metadata only — no notes and no page text…") is deliberately no longer rendered — that is the spec's merged-duplication decision; the Never sent chips state it once. Remove `DECISIONS_DESCRIPTION` and the now-unused `Fragment` import (eslint will flag both).

**(d) `DecisionSettings.tsx`, second-opinions disclosure** — replace the `<ul>` inside the `Automatic second opinions` disclosure with:

```tsx
              <ConsentFacts
                recipientName="your LLM provider"
                origin={llmOrigin}
                sent={[...escalationDisclosure.fields]}
                neverSent={["page content", "full URLs"]}
                why={escalationDisclosure.purpose}
                when={escalationDisclosure.trigger}
              >
                <p>{escalationDisclosure.credentialUse}.</p>
              </ConsentFacts>
```

(The old bullet's "— never page content or full URLs" becomes the `neverSent` chips, verbatim.)

- [ ] **Step 5: Run the four files, then the full components project**

```bash
npx vitest run --project components tests/components/options-primitives.test.tsx tests/components/provider-setup.test.tsx tests/components/options-llm-provider.test.tsx tests/components/options-llm-settings.test.tsx tests/components/options-decisions.test.tsx tests/components/options-app.test.tsx
npx vitest run --project components
```

`options-decisions` asserts on `disclosure.textContent` and needs no edits. If any other assertion fails, inspect it: only assertions that depend on the removed prose bullets (e.g. a `getByText` spanning two facts in one text node) may change — never a behavioural one. Report anything unexpected before editing.

- [ ] **Step 6: Gates and commit**

```bash
npx eslint src/entrypoints/options/components.tsx src/entrypoints/options/ProviderSetup.tsx src/entrypoints/options/LlmProviderSetup.tsx src/entrypoints/options/DecisionSettings.tsx tests/components/options-primitives.test.tsx tests/components/provider-setup.test.tsx tests/components/options-llm-provider.test.tsx tests/components/options-llm-settings.test.tsx
npm run typecheck
git add -A src/entrypoints/options tests/components
git commit -m "refactor(options): render consent facts through ConsentFacts"
git notes add -m "Task 2: ConsentFacts component replaces hand-rolled disclosure bullets at all four sites; facts verbatim from disclosure.ts; merged never-sent duplication"
```

---

### Task 3: Disclosure read gates

**Files:**
- Modify: `src/entrypoints/options/ProviderSetup.tsx`, `src/entrypoints/options/LlmProviderSetup.tsx`, `src/entrypoints/options/DecisionSettings.tsx`
- Modify: `tests/components/provider-setup.test.tsx`, `tests/components/options-llm-provider.test.tsx`, `tests/components/options-decisions.test.tsx`, `tests/components/options-llm-settings.test.tsx`
- Modify: `tests/e2e/helpers/llm.ts`, `tests/e2e/helpers/provider.ts`, `tests/e2e/helpers/decisions.ts`, `tests/e2e/llm.spec.ts`, `tests/e2e/provider.spec.ts`

Gate mechanics (identical at every site): the site owns a `disclosureOpen` state wired to `Disclosure`'s `open`/`onOpenChange`, plus a *latched* read signal keyed to the disclosure's subject (`openedPreset === presetId`, `openedKind === kind`, or `openedOrigin === llmOrigin`). The checkbox gains `disabled` until the read signal is true, with the reason line below it. Switching subject, granting, or revoking resets both states (folds the disclosure and re-arms the gate).

- [ ] **Step 1: Write the failing component tests**

**(a) `tests/components/provider-setup.test.tsx`** — add this helper next to `agreeCheckbox()`:

```tsx
/**
 * The disclosure read gate (Task 3): the agree checkbox is disabled until
 * the disclosure has been opened once. jsdom does not toggle `<details>` on
 * summary clicks, so flip the DOM attribute and fire `toggle` directly —
 * the same pattern options-primitives uses for Disclosure.
 */
function openDisclosure(): void {
  const details = screen
    .getByRole("region", { name: /data disclosure/i })
    .closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
```

Insert `openDisclosure();` on the line before each `fireEvent.click(agreeCheckbox())` — inside `fillAndAgree()` and at the two direct call sites (the "keeps Enable disabled until the unchecked agreement box is checked" test and the custom-provider enable flow). Then add:

```tsx
describe("disclosure read gate", () => {
  it("keeps the agree checkbox disabled with a reason until the disclosure opens", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    expect(agreeCheckbox().disabled).toBe(true);
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
    expect(
      screen.queryByText("Open the disclosure above first."),
    ).toBeNull();
  });

  it("re-arms the gate when the provider preset changes", async () => {
    render(<ProviderSetup />);
    await screen.findByRole("button", { name: /enable/i });
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(true));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
  });
});
```

**(b) `tests/components/options-llm-provider.test.tsx`** — same helper (region name `/data disclosure/i`); insert `openDisclosure();` before every `fireEvent.click(agreeCheckbox())` (in `fillPresetAndAgree` and at its five direct call sites); add:

```tsx
describe("disclosure read gate", () => {
  it("keeps the agree checkbox disabled with a reason until the disclosure opens", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /^enable/i });
    expect(agreeCheckbox().disabled).toBe(true);
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
    expect(
      screen.queryByText("Open the disclosure above first."),
    ).toBeNull();
  });

  it("re-arms the gate when the provider kind changes", async () => {
    render(<LlmProviderSetup />);
    await screen.findByRole("button", { name: /^enable/i });
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
    fireEvent.click(customRadio());
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(true));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() => expect(agreeCheckbox().disabled).toBe(false));
  });
});
```

**(c) `tests/components/options-decisions.test.tsx`** — same helper pattern with region name `/bookmark data disclosure/i`; insert `openDisclosure();` as the first line of the existing `grantDecisionsConsent` helper (before `fireEvent.click(agreeBox())`); add:

```tsx
describe("disclosure read gate", () => {
  it("keeps the agree box disabled with a reason until the disclosure opens", async () => {
    render(<DecisionSettings />);
    const box = await screen.findByRole("checkbox", { name: /agree/i });
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openDisclosure();
    await waitFor(() => expect(agreeBox().disabled).toBe(false));
    expect(
      screen.queryByText("Open the disclosure above first."),
    ).toBeNull();
  });

  it("re-arms the gate when the provider preset changes", async () => {
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    openDisclosure();
    await waitFor(() => expect(agreeBox().disabled).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "OpenRouter" }));
    await waitFor(() => expect(agreeBox().disabled).toBe(true));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
  });

  it("re-arms the gate after consent is revoked", async () => {
    render(<DecisionSettings />);
    await screen.findByRole("checkbox", { name: /agree/i });
    await grantDecisionsConsent();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /revoke .* analysis consent/i,
      }),
    );
    const box = await screen.findByRole("checkbox", { name: /agree/i });
    await waitFor(() => expect(box.disabled).toBe(true));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
  });
});
```

**(d) `tests/components/options-llm-settings.test.tsx`** — add the escalation helper:

```tsx
function openEscalationDisclosure(): void {
  const details = screen
    .getByRole("region", { name: "Second opinion disclosure" })
    .closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
```

In "asks for consent before the toggle unlocks", insert `openEscalationDisclosure();` immediately after `await section();` (before the checkbox `findByRole`). Add:

```tsx
  it("gates the second-opinion checkbox on the disclosure and re-arms on revoke", async () => {
    render(<DecisionSettings />);
    await section();
    const box = await screen.findByRole("checkbox", {
      name: /allow second opinions to be sent to/i,
    });
    expect(box.disabled).toBe(true);
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
    openEscalationDisclosure();
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", {
          name: /allow second opinions to be sent to/i,
        }).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /allow second opinions to be sent to/i,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Allow second opinions$/ }),
    );
    await waitFor(() =>
      expect(
        hasConsentAtOrigin(LLM_ESCALATE_SCOPE, LLM_ORIGIN),
      ).resolves.toBe(true),
    );
    // Revoking returns the consent row with the gate re-armed.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revoke second-opinion consent",
      }),
    );
    const back = await screen.findByRole("checkbox", {
      name: /allow second opinions to be sent to/i,
    });
    await waitFor(() => expect(back.disabled).toBe(true));
    expect(screen.getByText("Open the disclosure above first.")).toBeTruthy();
  });
```

- [ ] **Step 2: Run the four files and see the new tests fail**

```bash
npx vitest run --project components tests/components/provider-setup.test.tsx tests/components/options-llm-provider.test.tsx tests/components/options-decisions.test.tsx tests/components/options-llm-settings.test.tsx
```

- [ ] **Step 3: Implement the gates**

**(a) `ProviderSetup.tsx`** — after `const [agreed, setAgreed] = useState(false);` add:

```tsx
  // Read gate (options-popup plan Task 3): the disclosure starts folded and
  // the agreement checkbox stays disabled until it has been opened for the
  // currently selected preset. Switching presets, enabling, or revoking
  // re-arms the gate.
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [openedPreset, setOpenedPreset] = useState<JevProviderId | null>(null);
  const disclosureRead = openedPreset === presetId;
  const armDisclosureGate = (): void => {
    setDisclosureOpen(false);
    setOpenedPreset(null);
  };
```

- In `onPresetChange`, add `armDisclosureGate();` next to `setAgreed(false);`.
- In the enable-success branch (`setStatus(result.data.status); setApiKey(""); setAgreed(false);`) and the revoke-success branch (`setStatus(result.data.status); setAgreed(false);` with the revoke notice), add `armDisclosureGate();`.
- On the `Disclosure`, replace `open={!status?.enabled}` with:

```tsx
          open={disclosureOpen}
          onOpenChange={(open) => {
            setDisclosureOpen(open);
            if (open) setOpenedPreset(presetId);
          }}
```

- On the agreement checkbox add `disabled={!disclosureRead}`, and after the `</label>` add:

```tsx
          {!disclosureRead && (
            <p className="text-xs text-muted-foreground">
              Open the disclosure above first.
            </p>
          )}
```

**(b) `LlmProviderSetup.tsx`** — same pattern keyed to provider kind: after `const [agreed, setAgreed] = useState(false);` add:

```tsx
  // Read gate (options-popup plan Task 3): see ProviderSetup. Keyed to the
  // provider kind; switching kind, enabling, or revoking re-arms.
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [openedKind, setOpenedKind] = useState<ProviderKind | null>(null);
  const disclosureRead = openedKind === kind;
  const armDisclosureGate = (): void => {
    setDisclosureOpen(false);
    setOpenedKind(null);
  };
```

Add `armDisclosureGate();` in `onKindChange` (next to its state resets), in the enable-success branch and the revoke-success branch (each `setAgreed(false);` site). Replace `open={!status?.enabled}` with the same `open={disclosureOpen}` / `onOpenChange` pair (`setOpenedKind(kind)` on open). Add `disabled={!disclosureRead}` to the checkbox and the same reason `<p>` after its `</label>`.

**(c) `DecisionSettings.tsx`, bookmark analysis** — after `const [agreed, setAgreed] = useState(false);` add:

```tsx
  // Read gate (options-popup plan Task 3): see ProviderSetup. Keyed to the
  // selected preset; switching presets, granting, or revoking re-arms.
  const [consentDisclosureOpen, setConsentDisclosureOpen] = useState(false);
  const [openedConsentPreset, setOpenedConsentPreset] =
    useState<JevProviderId | null>(null);
  const consentDisclosureRead = openedConsentPreset === presetId;
  const armConsentDisclosureGate = (): void => {
    setConsentDisclosureOpen(false);
    setOpenedConsentPreset(null);
  };
```

Add `armConsentDisclosureGate();` in `onPresetChange`, in `onGrant`'s success branch (next to `setAgreed(false);`) and in `onRevoke`'s success branch. Replace `open={consentGranted !== true}` with:

```tsx
            open={consentDisclosureOpen}
            onOpenChange={(open) => {
              setConsentDisclosureOpen(open);
              if (open) setOpenedConsentPreset(presetId);
            }}
```

Add `disabled={!consentDisclosureRead}` to the agreement checkbox and the reason `<p>` (same markup) after its `</label>`.

**(d) `DecisionSettings.tsx`, second opinions** — next to `escalationAgreed` add:

```tsx
  // Read gate for the escalation disclosure, keyed to the LLM origin so a
  // provider change re-arms it automatically; granting or revoking re-arms.
  const [escalationDisclosureOpen, setEscalationDisclosureOpen] =
    useState(false);
  const [escalationOpenedOrigin, setEscalationOpenedOrigin] = useState<
    string | null
  >(null);
  const escalationDisclosureRead =
    llmOrigin !== null && escalationOpenedOrigin === llmOrigin;
```

Replace `open={escalationConsentRead !== true}` with:

```tsx
              open={escalationDisclosureOpen}
              onOpenChange={(open) => {
                setEscalationDisclosureOpen(open);
                if (open && llmOrigin !== null) {
                  setEscalationOpenedOrigin(llmOrigin);
                }
              }}
```

In `onEscalationConsent`'s success branch, after `setEscalationAgreed(false);` add:

```tsx
        setEscalationDisclosureOpen(false);
        setEscalationOpenedOrigin(null);
```

On the escalation checkbox change `disabled={escalationBusy}` to `disabled={escalationBusy || !escalationDisclosureRead}`, and inside the `flex flex-wrap items-center gap-3` row, after the `</label>`, add:

```tsx
                {!escalationDisclosureRead && (
                  <p className="basis-full text-xs text-muted-foreground">
                    Open the disclosure above first.
                  </p>
                )}
```

- [ ] **Step 4: Run the component files again and see them pass** (same command as Step 2, plus `tests/components/options-app.test.tsx`).

- [ ] **Step 5: Update the e2e helpers and specs**

All five sites click the disclosure summary before touching the checkbox (Playwright toggles `<details>` natively on summary clicks):

- `tests/e2e/helpers/provider.ts` `enableTypesafe` — before `await region.getByLabel(/agree to enable/).check();`:

```ts
  // Task 3 read gate: the agree checkbox is disabled until the disclosure
  // has been opened once — click its summary first.
  await region
    .locator("summary", { hasText: "What enabling TypeSafe means" })
    .click();
```

- `tests/e2e/helpers/llm.ts` `enableCustom` — before the agree check (the `llm` region locator already exists there):

```ts
  await llm
    .locator("summary", { hasText: "What enabling Custom Jev provider means" })
    .click();
```

- `tests/e2e/helpers/llm.ts` `enableOpenAi` — before the agree check:

```ts
  await page
    .getByRole("region", { name: "Optional LLM provider" })
    .locator("summary", { hasText: "What enabling an LLM provider means" })
    .click();
```

- `tests/e2e/helpers/decisions.ts` `grantDecisionsConsent` — after `openOptionsPanel(page, "Permissions");`, before the checkbox lookup:

```ts
  // Task 3 read gate: open the disclosure before the agree box.
  await page
    .locator("summary", { hasText: "What bookmark analysis sends to TypeSafe" })
    .click();
```

- `tests/e2e/llm.spec.ts` (~line 495) — insert before `await page.getByLabel(/agree to enable this LLM provider/).check();`:

```ts
  await page
    .getByRole("region", { name: "Optional LLM provider" })
    .locator("summary", { hasText: "What enabling an LLM provider means" })
    .click();
```

  and at the two escalation-consent sites (`getByLabel(/I allow second opinions to be sent to …/)` around lines 411 and 503), insert before each `.check()`:

```ts
  await page
    .locator("summary", { hasText: "Automatic second opinions" })
    .click();
```

- `tests/e2e/provider.spec.ts` (~line 156) — insert before `await jev.getByLabel(/agree to enable/).check();`:

```ts
    await jev
      .locator("summary", { hasText: "What enabling TypeSafe means" })
      .click();
```

- [ ] **Step 6: Run the affected e2e specs**

```bash
npm run build
xvfb-run -a npx playwright test tests/e2e/provider.spec.ts tests/e2e/llm.spec.ts tests/e2e/decisions.spec.ts
```

(`decisions.spec.ts` needs no edit: its only checkbox assertion is `not.toBeChecked()`, which holds for a disabled box, and its grants go through the updated helper.)

- [ ] **Step 7: Gates and commit**

```bash
npx eslint src/entrypoints/options/ProviderSetup.tsx src/entrypoints/options/LlmProviderSetup.tsx src/entrypoints/options/DecisionSettings.tsx tests/components/provider-setup.test.tsx tests/components/options-llm-provider.test.tsx tests/components/options-decisions.test.tsx tests/components/options-llm-settings.test.tsx tests/e2e/helpers/llm.ts tests/e2e/helpers/provider.ts tests/e2e/helpers/decisions.ts tests/e2e/llm.spec.ts tests/e2e/provider.spec.ts
npm run typecheck
git add src/entrypoints/options tests/components tests/e2e
git commit -m "feat(options): gate consent checkboxes on opening the disclosure"
git notes add -m "Task 3: disclosures default closed; agree checkboxes disabled until opened for the current subject; gate re-arms on preset/kind/origin change, grant and revoke; e2e helpers open summaries first"
```

---

### Task 4: Popup header search

**Files:**
- Modify: `src/entrypoints/popup/Search.tsx`, `src/entrypoints/popup/App.tsx`, `tests/components/popup-search.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `tests/components/popup-search.test.tsx`:

(a) The first test renders `PopupSearch` directly — add `onClose={() => {}}` to its props.

(b) Add a harness helper next to `searchInput()`:

```tsx
async function openSearch(): Promise<void> {
  fireEvent.click(
    screen.getByRole("button", { name: "Search bookmarks" }),
  );
  await screen.findByRole("combobox", { name: "Search bookmarks" });
}
```

(c) In the six tests that call `await renderPopup();` and then use `searchInput()`, insert `await openSearch();` immediately after `await renderPopup();`.

(d) Add these tests inside the `describe`:

```tsx
  it("hides the search row until the header icon is clicked", async () => {
    await renderPopup();
    expect(
      screen.queryByRole("combobox", { name: "Search bookmarks" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Search bookmarks" }),
    );
    await screen.findByRole("combobox", { name: "Search bookmarks" });
  });

  it("focuses the input on open and keeps form state across a close", async () => {
    await renderPopup();
    fireEvent.click(
      screen.getByRole("button", { name: "Search bookmarks" }),
    );
    const input = await screen.findByRole("combobox", {
      name: "Search bookmarks",
    });
    expect(document.activeElement).toBe(input);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Kept" },
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("combobox", { name: "Search bookmarks" }),
    ).toBeNull();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Kept",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search bookmarks" }),
    );
  });

  it("Escape with a live query clears it; a second Escape closes the row", async () => {
    await renderPopup();
    await openSearch();
    fireEvent.change(searchInput(), { target: { value: "alpha" } });
    await waitFor(() => expect(results().length).toBe(1));
    fireEvent.keyDown(searchInput(), { key: "Escape" });
    expect(searchInput().value).toBe("");
    // The form is back (empty query shows the form again, row still open).
    expect(screen.getByLabelText("Title")).toBeTruthy();
    fireEvent.keyDown(searchInput(), { key: "Escape" });
    expect(
      screen.queryByRole("combobox", { name: "Search bookmarks" }),
    ).toBeNull();
  });

  it("× clears a live query, then closes the row and returns focus", async () => {
    await renderPopup();
    await openSearch();
    fireEvent.change(searchInput(), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(searchInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(
      screen.queryByRole("combobox", { name: "Search bookmarks" }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search bookmarks" }),
    );
  });
```

- [ ] **Step 2: Run and see them fail**

```bash
npx vitest run --project components tests/components/popup-search.test.tsx
```

- [ ] **Step 3: Implement `Search.tsx`**

- Add the prop and autofocus:

```tsx
export interface PopupSearchProps {
  /** `null` until the lazy index build lands. */
  search: SearchIndexHandle | null;
  query: string;
  onQueryChange(query: string): void;
  onOpen(url: string, disposition: OpenUrlDisposition): void;
  /** Escape on an empty query (or × once clear): close the search row. */
  onClose(): void;
}

export function PopupSearch({
  search,
  query,
  onQueryChange,
  onOpen,
  onClose,
}: PopupSearchProps) {
```

  and add `autoFocus` to the combobox `<input>` (after `role="combobox"`).

- Replace the Escape branch of `handleKeyDown`:

```tsx
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") {
        onQueryChange("");
      } else {
        onClose();
      }
    }
```

- Replace the conditional `{query !== "" && (<button …>)}` clear button with an always-mounted one whose label and action follow the query:

```tsx
        <button
          type="button"
          aria-label={query !== "" ? "Clear search" : "Close search"}
          title={query !== "" ? "Clear search" : "Close search"}
          onClick={() => (query !== "" ? onQueryChange("") : onClose())}
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-3.5" />
        </button>
```

- Update the doc comment's Escape sentence to: `Escape clears a non-empty query; on an empty query it closes the row through onClose.`

- [ ] **Step 4: Implement the header in `App.tsx`**

- Add `SearchIcon` to the named imports from `../../ui/components/icons`.
- Next to `const [searchQuery, setSearchQuery] = useState("");` add:

```tsx
  const [searchOpen, setSearchOpen] = useState(false);
```

- Add a ref and close handler (near `handleOpenManager`):

```tsx
  const searchIconButtonRef = useRef<HTMLButtonElement>(null);
  // Closing with a live query clears it; focus returns to the header icon.
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery("");
    searchIconButtonRef.current?.focus();
  };
```

- Replace the header's action buttons (keep logo and `<h1>` as they are) with the icon cluster `[search] [open manager] [settings]`:

```tsx
        <button
          type="button"
          aria-label="Search bookmarks"
          aria-expanded={searchOpen}
          aria-controls="popup-search-row"
          title="Search bookmarks"
          ref={searchIconButtonRef}
          onClick={() => setSearchOpen(true)}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          aria-label="Open manager"
          title="Open manager"
          onClick={handleOpenManager}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <PanelRightIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={openOptionsPage}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <SettingsIcon />
        </button>
```

- Make the search row conditional (the slot below the header):

```tsx
      {searchOpen && (
        <div id="popup-search-row" className="shrink-0 px-4 pb-3">
          <PopupSearch
            search={search}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onOpen={handleOpenResult}
            onClose={closeSearch}
          />
        </div>
      )}
```

The save form's `searchQuery !== "" ? null : (…)` condition is unchanged — an open row with an empty query shows the form beneath it.

- [ ] **Step 5: Run the popup suites**

```bash
npx vitest run --project components tests/components/popup-search.test.tsx tests/components/popup-save.test.tsx tests/components/popup-suggestions.test.tsx
```

(`popup-save`'s "Open manager"/"Settings" tests keep passing — the accessible names are preserved by `aria-label`.)

- [ ] **Step 6: Gates and commit**

```bash
npx eslint src/entrypoints/popup/Search.tsx src/entrypoints/popup/App.tsx tests/components/popup-search.test.tsx
npm run typecheck
git add src/entrypoints/popup tests/components/popup-search.test.tsx
git commit -m "feat(popup): move search into an expanding header control"
git notes add -m "Task 4: header icon cluster [search][open manager][settings], icon-only with aria-labels; search row mounts on click, autofocuses, Escape/× close it and clear the query"
```

---

### Task 5: Incidental fixes

**Files:**
- Modify: `src/entrypoints/options/DecisionSettings.tsx`

- [ ] **Step 1: Blocklist spacing**

Wrap the built-in blocklist `Disclosure` (the one titled `` `Built-in blocklist — ${BUILTIN_SENSITIVE_SITES.length} sites` ``, which currently follows the "Block a host" input row with no separation) in a spacing wrapper:

```tsx
        <div className="mt-4">
          <Disclosure
            title={`Built-in blocklist — ${BUILTIN_SENSITIVE_SITES.length} sites`}
            subtitle="Always applies, not editable."
            open={false}
            regionLabel="Built-in blocklist"
          >
            …unchanged children…
          </Disclosure>
        </div>
```

(No new test: the change is a presentational margin; Task 6's capture verifies it.)

The popup header title needs no code change — Task 4's icon-only cluster frees the width; Task 6's 380 px capture verifies the full "Bookmarks Manager" renders untruncated.

- [ ] **Step 2: Gates and commit**

```bash
npx eslint src/entrypoints/options/DecisionSettings.tsx
npm run typecheck
npx vitest run --project components tests/components/options-decisions.test.tsx tests/components/options-llm-settings.test.tsx
git add src/entrypoints/options/DecisionSettings.tsx
git commit -m "fix(options): separate blocklist input from built-in disclosure"
git notes add -m "Task 5: mt-4 wrapper between the Block-a-host row and the built-in blocklist disclosure; popup title width verified in Task 6 capture"
```

---

### Task 6: Visual verification, e2e, gates, report

**Files:**
- Create: `/tmp/capture/capture-options-popup-after.mjs` (script below)
- Read-only review: `/tmp/capture/after-options-popup/*.png`, copies to `.amp/in/artifacts/options-popup/`

- [ ] **Step 1: Build and write the capture script**

```bash
npm run build
```

Write `/tmp/capture/capture-options-popup-after.mjs`:

```js
/**
 * Options/popup capture (options-popup plan Task 6).
 *
 * One profile, no provider configured (same posture as the survey):
 *  - popup.html at 380 px: search closed, search open with results, dark;
 *  - options panels (connections, permissions, activity, data) at 1280 and
 *    400, light; connections + permissions also dark;
 *  - consent disclosures closed (the new default) and opened.
 *
 * Output dir from $OUT (default /tmp/capture/after-options-popup).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/home/user/workspace/repo/package.json");
const { chromium } = require("@playwright/test");

const OUT = process.env.OUT ?? "/tmp/capture/after-options-popup";
const EXTENSION_DIR = "/home/user/workspace/repo/.output/chrome-mv3";
mkdirSync(OUT, { recursive: true });

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
  ],
});
const [existing] = context.serviceWorkers();
const worker = existing ?? (await context.waitForEvent("serviceworker"));
const id = new URL(worker.url()).host;

async function shot(page, width, name, fullPage = false) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: path.join(OUT, name),
    ...(fullPage ? { fullPage: true } : {}),
  });
  console.log(`captured ${name}`);
}

// Popup at 380 (its fixed width): closed, open with results, dark.
{
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByLabelText("Title").waitFor({ timeout: 20_000 });
  await shot(page, 380, "popup-380-search-closed.png", true);
  await page
    .getByRole("button", { name: "Search bookmarks" })
    .click();
  await page
    .getByRole("combobox", { name: "Search bookmarks" })
    .waitFor({ timeout: 10_000 });
  await shot(page, 380, "popup-380-search-open-empty.png", true);
  await page
    .getByRole("combobox", { name: "Search bookmarks" })
    .fill("reading");
  await page.waitForTimeout(500);
  await shot(page, 380, "popup-380-search-results.png", true);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, 380, "popup-380-dark.png", true);
  await page.close();
}

// Options panels: default (closed-disclosure) state everywhere, then the
// consent disclosures opened, then dark for the two consent panels.
{
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page
    .getByRole("heading", { name: "Bookmarks Manager" })
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  for (const panel of ["connections", "permissions", "activity", "data"]) {
    await page.goto(`chrome-extension://${id}/options.html#${panel}`);
    await page.waitForTimeout(600);
    await shot(page, 1280, `options-${panel}-1280.png`, true);
    await shot(page, 400, `options-${panel}-400.png`, true);
  }
  // Opened disclosures (both Connections cards, both Permissions cards —
  // escalation shows its "configure a provider" guidance without one).
  await page.goto(`chrome-extension://${id}/options.html#connections`);
  await page.waitForTimeout(600);
  for (const title of [
    "What enabling TypeSafe means",
    "What enabling an LLM provider means",
  ]) {
    await page.locator("summary", { hasText: title }).click();
    await page.waitForTimeout(250);
  }
  await shot(page, 1280, "options-connections-1280-disclosures-open.png", true);
  await shot(page, 400, "options-connections-400-disclosures-open.png", true);
  await page.goto(`chrome-extension://${id}/options.html#permissions`);
  await page.waitForTimeout(600);
  await page
    .locator("summary", { hasText: "What bookmark analysis sends to TypeSafe" })
    .click();
  await page.waitForTimeout(250);
  await shot(page, 1280, "options-permissions-1280-disclosure-open.png", true);
  await shot(page, 400, "options-permissions-400-disclosure-open.png", true);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, 1280, "options-connections-1280-dark.png", true);
  await shot(page, 400, "options-permissions-400-dark.png", true);
  await page.close();
}
await context.close();
console.log(`done → ${OUT}`);
```

- [ ] **Step 2: Run the capture**

```bash
npm run build && cd /tmp/capture && OUT=/tmp/capture/after-options-popup xvfb-run -a node capture-options-popup-after.mjs
```

Expected: 18 PNGs in `/tmp/capture/after-options-popup/`.

- [ ] **Step 3: Inspect every capture with view_media**

Copy the set to `.amp/in/artifacts/options-popup/` and inspect each with `view_media`, objective naming the expected content:

| File | Expected |
|---|---|
| `popup-380-search-closed.png` | Header: logo, full untruncated "Bookmarks Manager" title, three icon buttons (search/open-manager/settings); **no** search row; save form first content |
| `popup-380-search-open-empty.png` | Search row under the header, input focused, × reads Close; save form beneath |
| `popup-380-search-results.png` | Results list replaces the form; footer hint present; header unchanged |
| `popup-380-dark.png` | Dark theme, readable text, no white box |
| `options-{connections,permissions,activity,data}-{1280,400}.png` | Both consent disclosures **folded** by default (summary rows only); panels not dominated by text walls; Permissions blocklist input clearly separated from the built-in disclosure |
| `options-connections-{1280,400}-disclosures-open.png` | Opened disclosures render `ConsentFacts`: uppercase row labels, chip rows for Sent/Never sent, credential/data-note/policy lines below; no "What is sent:" prose bullets |
| `options-permissions-{1280,400}-disclosure-open.png` | Bookmark-analysis disclosure with Sent + Never sent chip rows; agree checkbox visible with the "Open the disclosure above first." reason line (gate re-armed state does not apply — it opens on click) |
| `options-connections-1280-dark.png`, `options-permissions-400-dark.png` | Dark theme, chips and labels readable |

Report any defect to the user BEFORE fixing. Fix, rebuild, re-capture, re-inspect until clean. Commit fixes as separate `fix(ui): …` / `fix(popup): …` commits.

- [ ] **Step 4: Full gates**

```bash
npm run lint
npm run typecheck
npm run build
npm run check:manifest && npm run check:store && npm run check:site && npm run check:bundle
npx vitest run --project unit
npx vitest run --project components
xvfb-run -a npx playwright test tests/e2e/shell.spec.ts tests/e2e/provider.spec.ts tests/e2e/llm.spec.ts tests/e2e/decisions.spec.ts
```

(Known-flaky files: re-run alone before calling a regression.)

- [ ] **Step 5: Store assets**

`ls store/assets/source` — the generated store assets are icons and the promo tile. Nothing in them depicts the Options page or the popup; if (and only if) a source file contradicts that, update it and run `node scripts/generate-store-assets.mjs`; otherwise record in the report that no store asset shows Options/popup and nothing was regenerated.

- [ ] **Step 6: Close tracking and report**

```bash
bd close <child1-id>
bd update <child2-id> --claim
bd close <child2-id>
bd close <epic-id>
```

(Do not `bd dolt push` or `git push`; the user decides when to push.)

Report to the user: commits (`git log --oneline -14`), gates and results, which known-flaky tests were seen, the screenshot review verdict per file, any fix commits and what they fixed, the store-asset record, and confirmation that `.beads/issues.jsonl` is the only uncommitted file. Do not push.
