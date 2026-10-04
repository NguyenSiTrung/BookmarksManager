import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EvalCorpus, NONE_FOLDER_ID } from "../../src/eval/schema";
import type { EvalCase } from "../../src/eval/schema";
import { questionSetVersions } from "../../src/jev/tasks";

// The labeled eval corpus (spec FR1) is the release-quality baseline: it
// must be schema-valid, synthetic, free of private/intranet URLs and
// credentials, and cover every shipped question set.

const corpusPath = resolve(
  process.cwd(),
  "tests",
  "eval",
  "fixtures",
  "corpus.json",
);

function loadCorpus(): unknown {
  return JSON.parse(readFileSync(corpusPath, "utf8"));
}

/** A minimal corpus that satisfies the schema — one case per kind. */
const miniCorpus = {
  version: "1.0.0",
  questionSetVersions: {
    categorize: "categorize-v1",
    tags: "tags-v1",
    placement: "placement-v1",
    misfiled: "misfiled-v1",
    nearDuplicate: "near-duplicate-v1",
    rerank: "rerank-v1",
  },
  bookmarks: [
    {
      id: "bm_docs",
      title: "Rust async book",
      url: "https://doc.rust-lang.org/book/",
    },
    {
      id: "bm_video",
      title: "Rust conference talk",
      url: "https://www.youtube.com/watch?v=abc",
    },
    {
      id: "bm_bank",
      title: "Chase sign in",
      url: "https://www.chase.com/",
      excluded: true,
    },
    {
      id: "bm_broken",
      title: "Saved placeholder",
      url: "not a url",
      excluded: true,
    },
  ],
  cases: [
    {
      kind: "categorize",
      id: "case_cat",
      bookmark: "bm_docs",
      expect: { category: "docs" },
    },
    {
      kind: "tags",
      id: "case_tags",
      bookmark: "bm_docs",
      tags: [
        { name: "rust", nameKey: "rust", description: "Rust language" },
        { name: "cooking" },
      ],
      expect: { tags: ["rust"] },
    },
    {
      kind: "placement",
      id: "case_place",
      bookmark: "bm_docs",
      folders: [
        { id: "f10", path: ["Bookmarks bar", "Dev"] },
        { id: "f20", path: ["Bookmarks bar", "Hobbies"] },
      ],
      expect: { folder: "f10" },
    },
    {
      kind: "misfiled",
      id: "case_mis",
      bookmark: "bm_video",
      folderPath: ["Bookmarks bar", "Hobbies"],
      folders: [
        { id: "f10", path: ["Bookmarks bar", "Dev"] },
        {
          id: "f20",
          path: ["Bookmarks bar", "Hobbies"],
          current: true,
        },
      ],
      expect: { folder: "f10" },
    },
    {
      kind: "near_duplicate",
      id: "case_dup",
      a: "bm_docs",
      b: "bm_video",
      expect: { same_content: 1 },
    },
    {
      kind: "rerank",
      id: "case_rerank",
      query: "rust docs",
      candidates: ["bm_docs", "bm_video"],
      expect: { matches: ["bm_docs"] },
    },
  ],
};

function corpusWith(cases: EvalCase[], bookmarks?: unknown): unknown {
  return {
    ...miniCorpus,
    bookmarks: bookmarks ?? miniCorpus.bookmarks,
    cases,
  };
}

describe("EvalCorpus acceptance", () => {
  it("accepts a corpus with one valid case of every kind", () => {
    const result = EvalCorpus.safeParse(miniCorpus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bookmarks).toHaveLength(4);
      expect(result.data.cases.map((c) => c.kind).sort()).toEqual([
        "categorize",
        "misfiled",
        "near_duplicate",
        "placement",
        "rerank",
        "tags",
      ]);
    }
  });

  it("accepts an excluded bookmark referenced by a real case", () => {
    const corpus = corpusWith([
      {
        kind: "categorize",
        id: "case_sensitive",
        bookmark: "bm_bank",
        expect: { category: "tool" },
      },
    ]);
    expect(EvalCorpus.safeParse(corpus).success).toBe(true);
  });

  it("accepts a misfiled case expecting the current folder (no move)", () => {
    const corpus = corpusWith([
      {
        kind: "misfiled",
        id: "case_keep",
        bookmark: "bm_video",
        folderPath: ["Bookmarks bar", "Hobbies"],
        folders: [
          { id: "f10", path: ["Bookmarks bar", "Dev"] },
          { id: "f20", path: ["Bookmarks bar", "Hobbies"], current: true },
        ],
        expect: { folder: "f20" },
      },
    ]);
    expect(EvalCorpus.safeParse(corpus).success).toBe(true);
  });
});

describe("EvalCorpus rejection", () => {
  it("rejects malformed top-level envelopes", () => {
    for (const [label, patch] of [
      ["empty version", { version: "not-semver" }],
      ["unknown top-level key", { unexpected: true }],
      ["missing questionSetVersions key", { questionSetVersions: {} }],
    ] as const) {
      expect(EvalCorpus.safeParse({ ...miniCorpus, ...patch }).success, label).toBe(false);
    }
  });

  it("rejects duplicate bookmark and case ids", () => {
    expect(
      EvalCorpus.safeParse(
        corpusWith(miniCorpus.cases as EvalCase[], [
          ...miniCorpus.bookmarks,
          { ...miniCorpus.bookmarks[0] },
        ]),
      ).success,
      "duplicate bookmark ids",
    ).toBe(false);
    expect(
      EvalCorpus.safeParse(
        corpusWith([
          ...(miniCorpus.cases as EvalCase[]),
          { ...(miniCorpus.cases[0] as EvalCase) },
        ]),
      ).success,
      "duplicate case ids",
    ).toBe(false);
  });

  it("rejects unknown bookmark references in categorize, near_duplicate, and rerank cases", () => {
    for (const [kind, patch] of [
      ["categorize", { bookmark: "bm_missing" }],
      ["near_duplicate", { a: "bm_docs", b: "bm_missing" }],
      ["rerank", { candidates: ["bm_docs", "bm_missing"] }],
    ] as const) {
      const base = (miniCorpus.cases as EvalCase[]).find(
        (c) => c.kind === kind,
      ) as unknown as Record<string, unknown>;
      const corpus = corpusWith([{ ...base, ...patch } as EvalCase]);
      expect(EvalCorpus.safeParse(corpus).success, kind).toBe(false);
    }
  });

  it("rejects bookmarks with private, local, file, or credentialed URLs", () => {
    for (const url of [
      "https://10.0.0.5/internal",
      "https://127.0.0.1:8080/",
      "https://192.168.1.10/nas",
      "https://printer.local/status",
      "https://nas/",
      "file:///home/user/notes.txt",
      "data:text/plain,hello",
      "http://[::1]:3000/",
      "https://user:hunter2@example.com/",
      "https://user@example.com/",
    ]) {
      const corpus = corpusWith(miniCorpus.cases as EvalCase[], [
        { id: "bm_bad", title: "bad", url },
        ...miniCorpus.bookmarks,
      ]);
      expect(EvalCorpus.safeParse(corpus).success, url).toBe(false);
    }
  });

  it("rejects bookmarks with notes, unknown keys, or invalid ids", () => {
    for (const [label, patch] of [
      ["a notes field", { notes: "private note" }],
      ["an unknown key", { starred: true }],
      ["a missing id", { id: "" }],
      ["a non-lower-case id", { id: "BM_Upper" }],
    ] as const) {
      const corpus = corpusWith(miniCorpus.cases as EvalCase[], [
        { ...miniCorpus.bookmarks[0], ...patch },
        ...miniCorpus.bookmarks.slice(1),
      ]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });

  it("rejects mislabeled sensitive, malformed, or excluded bookmarks", () => {
    for (const [label, bookmark] of [
      [
        "sensitive but not excluded",
        { id: "bm_x", title: "Bank", url: "https://www.chase.com/" },
      ],
      [
        "malformed but not excluded",
        { id: "bm_x", title: "Broken", url: "ht!tp://[" },
      ],
      [
        "ordinary but marked excluded",
        {
          id: "bm_x",
          title: "Docs",
          url: "https://example.com/",
          excluded: true,
        },
      ],
    ] as const) {
      const corpus = corpusWith(miniCorpus.cases as EvalCase[], [
        bookmark,
        ...miniCorpus.bookmarks,
      ]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });

  it("rejects self-referencing pairs, non-candidate expected tags, and duplicate tag option keys", () => {
    for (const [label, case_] of [
      ["near-duplicate pair referencing one bookmark", {
        kind: "near_duplicate",
        id: "case_self",
        a: "bm_docs",
        b: "bm_docs",
        expect: { same_content: 4 },
      }],
      ["expected tag that is not a candidate", {
        kind: "tags",
        id: "case_tags",
        bookmark: "bm_docs",
        tags: [{ name: "rust" }],
        expect: { tags: ["kubernetes"] },
      }],
      ["duplicate tag option keys", {
        kind: "tags",
        id: "case_tags",
        bookmark: "bm_docs",
        tags: [
          { name: "Rust!", nameKey: "rust" },
          { name: "rust" },
        ],
        expect: { tags: [] },
      }],
    ] as const) {
      const corpus = corpusWith([case_ as EvalCase]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });

  it("rejects placement cases with an invalid expected folder, reserved id, duplicate ids, or a current marker", () => {
    for (const [label, patch] of [
      ["expected folder not a candidate", { expect: { folder: "f99" } }],
      ["a candidate id reserved as none", {
        folders: [
          { id: NONE_FOLDER_ID, path: ["Nowhere"] },
          { id: "f10", path: ["Dev"] },
        ],
      }],
      ["duplicate folder ids", {
        folders: [
          { id: "f10", path: ["Dev"] },
          { id: "f10", path: ["Also dev"] },
        ],
      }],
      ["a current marker", {
        folders: [
          { id: "f10", path: ["Dev"], current: true },
          { id: "f20", path: ["Hobbies"] },
        ],
      }],
    ] as const) {
      const corpus = corpusWith([
        {
          kind: "placement",
          id: "case_place",
          bookmark: "bm_docs",
          folders: [
            { id: "f10", path: ["Dev"] },
            { id: "f20", path: ["Hobbies"] },
          ],
          expect: { folder: "f10" },
          ...patch,
        } as unknown as EvalCase,
      ]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });

  it("rejects misfiled cases with no, multiple, or mismatched current candidates", () => {
    for (const [label, patch] of [
      ["no current candidate", {
        folders: [
          { id: "f10", path: ["Dev"] },
          { id: "f20", path: ["Hobbies"] },
        ],
      }],
      ["two current candidates", {
        folders: [
          { id: "f10", path: ["Dev"], current: true },
          { id: "f20", path: ["Hobbies"], current: true },
        ],
      }],
      ["current path ≠ folderPath", {
        folders: [
          { id: "f10", path: ["Dev"] },
          { id: "f20", path: ["Elsewhere"], current: true },
        ],
      }],
    ] as const) {
      const corpus = corpusWith([
        {
          kind: "misfiled",
          id: "case_mis",
          bookmark: "bm_video",
          folderPath: ["Bookmarks bar", "Hobbies"],
          expect: { folder: "f10" },
          ...patch,
        } as unknown as EvalCase,
      ]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });

  it("rejects non-candidate or excluded rerank matches, out-of-range levels, and unknown case kinds", () => {
    for (const [label, case_] of [
      ["rerank expected match that is not a candidate", {
        kind: "rerank",
        id: "case_rerank",
        query: "rust",
        candidates: ["bm_docs"],
        expect: { matches: ["bm_video"] },
      }],
      ["excluded bookmark as a rerank expected match", {
        kind: "rerank",
        id: "case_rerank",
        query: "bank",
        candidates: ["bm_docs", "bm_bank"],
        expect: { matches: ["bm_bank"] },
      }],
      ["out-of-range same_content level", {
        kind: "near_duplicate",
        id: "case_dup",
        a: "bm_docs",
        b: "bm_video",
        expect: { same_content: 5 },
      }],
      ["unknown case discriminator", {
        kind: "summarize",
        id: "case_future",
        bookmark: "bm_docs",
        expect: {},
      } as unknown as EvalCase],
    ] as const) {
      const corpus = corpusWith([case_ as EvalCase]);
      expect(EvalCorpus.safeParse(corpus).success, label).toBe(false);
    }
  });
});

describe("shipped corpus.json", () => {
  it("parses under EvalCorpus", () => {
    const result = EvalCorpus.safeParse(loadCorpus());
    if (!result.success) {
      console.error(result.error.issues.slice(0, 20));
    }
    expect(result.success).toBe(true);
  });

  it("holds approximately 300 bookmark records", () => {
    const corpus = EvalCorpus.parse(loadCorpus());
    expect(corpus.bookmarks.length).toBeGreaterThanOrEqual(280);
    expect(corpus.bookmarks.length).toBeLessThanOrEqual(320);
  });

  it("covers every shipped question set", () => {
    const corpus = EvalCorpus.parse(loadCorpus());
    const counts = new Map<string, number>();
    for (const c of corpus.cases) {
      counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
    }
    for (const kind of [
      "categorize",
      "tags",
      "placement",
      "misfiled",
      "near_duplicate",
      "rerank",
    ]) {
      expect(
        counts.get(kind) ?? 0,
        `corpus has no ${kind} cases`,
      ).toBeGreaterThanOrEqual(10);
    }
  });

  it("includes exclusion fixtures: sensitive-site and malformed", () => {
    const corpus = EvalCorpus.parse(loadCorpus());
    const excluded = corpus.bookmarks.filter((b) => b.excluded);
    expect(excluded.length).toBeGreaterThanOrEqual(5);
    // Malformed fixtures are part of the exclusion coverage.
    expect(
      excluded.some((b) => {
        try {
          new URL(b.url);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
  });

  it("pins the shipped questionSetVersions", () => {
    const corpus = EvalCorpus.parse(loadCorpus());
    expect(corpus.questionSetVersions).toEqual(questionSetVersions);
  });
});
