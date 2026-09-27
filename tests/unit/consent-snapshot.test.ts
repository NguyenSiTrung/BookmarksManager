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
  2: [
    ...SYNTHETIC_FIELDS,
    "bookmark title",
    "cleaned URL",
    "domain",
    "folder path",
    "tag names and descriptions",
    "candidate folder paths",
    "candidate bookmarks",
    "near-duplicate partner",
    "Ask search query",
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
  it("pins CONSENT_VERSION to 2", () => {
    expect(CONSENT_VERSION).toBe(2);
  });

  it("pins the exact sent-field set for the current consent version", () => {
    const current = [...SYNTHETIC_FIELDS, ...DECISIONS_SENT_FIELDS];
    const snapshot = SENT_FIELD_SNAPSHOTS[CONSENT_VERSION];
    expect(snapshot).toBeDefined();
    expect([...current]).toEqual([...snapshot!]);
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
    "%s names the jev_decisions scope and the versioned consent",
    (_name, text) => {
      expect(text).toContain("jev_decisions");
      expect(text.toLowerCase()).toContain("consentversion");
    },
  );

  it("keeps the preset origins aligned with the frozen registry", () => {
    expect(PROVIDER_DISCLOSURES.typesafe.origin).toBe(PRESETS.typesafe.origin);
    expect(PROVIDER_DISCLOSURES.openrouter.origin).toBe(
      PRESETS.openrouter.origin,
    );
  });
});
