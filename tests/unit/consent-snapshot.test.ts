import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSENT_VERSION } from "../../src/consent/records";
import {
  DECISIONS_NEVER_SENT_FIELDS,
  DECISIONS_PURPOSES,
  DECISIONS_SENT_FIELDS,
  DECISIONS_TRIGGERS,
  DECISIONS_TRIGGER_NOTE,
  EXTENSION_PRIVACY_POLICY_REFERENCE,
  LLM_CONSENT_SCOPES,
  LLM_CREDENTIAL_USE,
  LLM_NEVER_SENT,
  LLM_SCOPE_DISCLOSURES,
  NO_DEVELOPER_SERVER_NOTE,
  PROVIDER_DISCLOSURES,
  SYNTHETIC_FIELDS,
} from "../../src/consent/disclosure";
import { PRESETS } from "../../src/net/presets";
import { DecisionState } from "../../src/schemas/decision-state";

/**
 * The §13.12 consent snapshot test. It fails when the set of fields a task
 * sends changes without a `CONSENT_VERSION` increase **and** matching
 * `store/privacy-practices.md` + `store/privacy-policy.md` edits:
 *
 * 1. The sent-field set is derived from the disclosure constants and pinned
 *    per consent version below — a change to `DECISIONS_SENT_FIELDS` (or the
 *    synthetic fields) without a new snapshot entry fails the equality, and a
 *    version bump without a new entry fails the `toBeDefined` guard.
 * 2. Every populated `DecisionState` field must have a disclosure label, so
 *    a new state field cannot ship undisclosed.
 * 3. Both store documents must quote the disclosure constants, so a field,
 *    purpose, trigger, recipient, or policy-link change cannot ship without
 *    the store text changing too.
 */

/** The exact sent-field set per consent version. Add a new entry whenever
 * `CONSENT_VERSION` increases. */
const SENT_FIELD_SNAPSHOTS: Readonly<Record<number, readonly string[]>> = {
  3: [
    ...SYNTHETIC_FIELDS,
    "bookmark title",
    "cleaned URL",
    "domain",
    "folder path",
    "folder paths",
    "tag names and descriptions",
    "candidate folder paths",
    "candidate bookmarks",
    "near-duplicate partner",
    "Ask search query",
    // llm_test — wire fields of the fixed synthetic chat request ("model"
    // is already a synthetic field)
    "messages",
    "response_format",
    // llm_explain
    "decision state",
    "question",
    "candidate labels",
    "Jev probabilities",
    "selected answer",
    // llm_escalate
    "allowed options",
    "Jev answer",
    // llm_restructure
    "category counts",
    "tag counts",
    "domains",
    "representative titles (capped)",
    // llm_summary
    "page title",
    "site name",
    "headings",
    "bounded page excerpt",
    // jev_summary_verify
    "LLM-generated summary",
  ],
};

/** Map each populated `DecisionState` field to its disclosure label. */
const STATE_FIELD_LABELS: Readonly<Record<string, string>> = {
  bookmark: "bookmark title",
  folderPath: "folder path",
  candidateTags: "tag names and descriptions",
  candidateFolders: "candidate folder paths",
  candidateBookmarks: "candidate bookmarks",
  pairPartner: "near-duplicate partner",
  query: "Ask search query",
};

function readStore(file: string): string {
  // Vitest runs from the repo root, so the store docs resolve from cwd.
  // Collapse whitespace so a phrase split across wrapped lines still matches.
  return readFileSync(resolve(process.cwd(), "store", file), "utf8").replace(
    /\s+/g,
    " ",
  );
}

const STORE_TEXTS = [
  ["store/privacy-policy.md", readStore("privacy-policy.md")],
  ["store/privacy-practices.md", readStore("privacy-practices.md")],
] as const;

describe("consent snapshot (§13.12)", () => {
  it("pins CONSENT_VERSION to 3", () => {
    expect(CONSENT_VERSION).toBe(3);
  });

  it("pins the exact sent-field set for the current consent version", () => {
    const llmFields = [
      ...new Set(
        LLM_CONSENT_SCOPES.flatMap(
          (scope) => LLM_SCOPE_DISCLOSURES[scope].fields,
        ),
      ),
    ];
    const current = [
      ...new Set([
        ...SYNTHETIC_FIELDS,
        ...DECISIONS_SENT_FIELDS,
        ...llmFields,
      ]),
    ];
    const snapshot = SENT_FIELD_SNAPSHOTS[CONSENT_VERSION];
    expect(snapshot).toBeDefined();
    expect([...current].sort()).toEqual([...snapshot!].sort());
  });

  it("declares a disclosure for exactly the LLM consent scopes", () => {
    expect(Object.keys(LLM_SCOPE_DISCLOSURES).sort()).toEqual(
      [...LLM_CONSENT_SCOPES].sort(),
    );
    for (const scope of LLM_CONSENT_SCOPES) {
      const disclosure = LLM_SCOPE_DISCLOSURES[scope];
      expect(disclosure.fields.length).toBeGreaterThan(0);
      expect(disclosure.purpose.length).toBeGreaterThan(0);
      expect(disclosure.trigger.length).toBeGreaterThan(0);
      expect(disclosure.credentialUse.length).toBeGreaterThan(0);
    }
  });

  it("gives every populated DecisionState field a disclosure label", () => {
    const state = DecisionState as unknown as {
      shape: Record<string, unknown>;
    };
    expect(Object.keys(STATE_FIELD_LABELS).sort()).toEqual(
      Object.keys(state.shape).sort(),
    );
    for (const label of Object.values(STATE_FIELD_LABELS)) {
      expect(DECISIONS_SENT_FIELDS).toContain(label);
    }
  });
});

describe("store disclosures match the disclosure constants", () => {
  it.each(STORE_TEXTS)("%s names every sent field", (_name, text) => {
    const lower = text.toLowerCase();
    for (const field of [...SYNTHETIC_FIELDS, ...DECISIONS_SENT_FIELDS]) {
      expect(lower).toContain(field.toLowerCase());
    }
  });

  it.each(STORE_TEXTS)("%s names the never-sent fields", (_name, text) => {
    const lower = text.toLowerCase();
    for (const field of DECISIONS_NEVER_SENT_FIELDS) {
      expect(lower).toContain(field.toLowerCase());
    }
  });

  it.each(STORE_TEXTS)("%s names every purpose", (_name, text) => {
    const lower = text.toLowerCase();
    for (const purpose of DECISIONS_PURPOSES) {
      expect(lower).toContain(purpose.toLowerCase());
    }
  });

  it.each(STORE_TEXTS)(
    "%s names every trigger and the user-started guarantee",
    (_name, text) => {
      const lower = text.toLowerCase();
      for (const trigger of DECISIONS_TRIGGERS) {
        expect(lower).toContain(trigger.toLowerCase());
      }
      expect(lower).toContain(DECISIONS_TRIGGER_NOTE.toLowerCase());
    },
  );

  it.each(STORE_TEXTS)(
    "%s names both provider origins and privacy-policy links",
    (_name, text) => {
      for (const preset of ["typesafe", "openrouter"] as const) {
        const disclosure = PROVIDER_DISCLOSURES[preset];
        expect(text).toContain(disclosure.origin);
        expect(text).toContain(disclosure.privacyPolicyUrl);
      }
      expect(text.toLowerCase()).toContain(
        EXTENSION_PRIVACY_POLICY_REFERENCE.toLowerCase(),
      );
    },
  );

  it.each(STORE_TEXTS)(
    "%s names every LLM scope with its title and sent fields",
    (_name, text) => {
      const lower = text.toLowerCase();
      for (const scope of LLM_CONSENT_SCOPES) {
        expect(text).toContain(scope);
        const disclosure = LLM_SCOPE_DISCLOSURES[scope];
        expect(lower).toContain(disclosure.title.toLowerCase());
        for (const field of disclosure.fields) {
          expect(lower).toContain(field.toLowerCase());
        }
      }
    },
  );

  it.each(STORE_TEXTS)(
    "%s names the LLM credential path and the never-sent content",
    (_name, text) => {
      const lower = text.toLowerCase();
      expect(lower).toContain(LLM_CREDENTIAL_USE.toLowerCase());
      for (const field of LLM_NEVER_SENT) {
        expect(lower).toContain(field.toLowerCase());
      }
    },
  );

  it.each(STORE_TEXTS)(
    "%s names the jev_decisions scope and the versioned consent",
    (_name, text) => {
      expect(text).toContain("jev_decisions");
      expect(text.toLowerCase()).toContain("consentversion");
    },
  );

  it.each(STORE_TEXTS)(
    "%s states the developer runs no server and is never a destination",
    (_name, text) => {
      expect(text).toContain(NO_DEVELOPER_SERVER_NOTE);
    },
  );

  it("keeps the preset origins aligned with the frozen registry", () => {
    expect(PROVIDER_DISCLOSURES.typesafe.origin).toBe(PRESETS.typesafe.origin);
    expect(PROVIDER_DISCLOSURES.openrouter.origin).toBe(
      PRESETS.openrouter.origin,
    );
  });
});
