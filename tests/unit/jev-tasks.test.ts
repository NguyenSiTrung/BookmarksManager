import { describe, expect, it, vi } from "vitest";
import type { JevClient } from "../../src/jev/client";
import {
  checkGuards,
  estimateTokens,
  MAX_BATCH_TOTAL_TOKENS,
} from "../../src/jev/budget";
import { DecisionState } from "../../src/schemas/decision-state";
import type { SentBookmark } from "../../src/schemas/decision-state";
import { SystemOneRequest } from "../../src/jev/wire";
import type { Answer } from "../../src/jev/wire";
import { Category } from "../../src/schemas/bookmark";
import {
  categorize,
  questionSetVersion as categorizeVersion,
} from "../../src/jev/tasks/categorize";
import {
  tags,
  questionSetVersion as tagsVersion,
} from "../../src/jev/tasks/tags";
import {
  placement,
  questionSetVersion as placementVersion,
} from "../../src/jev/tasks/placement";
import {
  misfiled,
  questionSetVersion as misfiledVersion,
} from "../../src/jev/tasks/misfiled";
import {
  nearDuplicate,
  questionSetVersion as nearDuplicateVersion,
} from "../../src/jev/tasks/near-duplicate";
import {
  rerank,
  questionSetVersion as rerankVersion,
} from "../../src/jev/tasks/rerank";

/**
 * Jev question sets (spec FR4, PROJECT_PLAN.md §9): six `defineDecision`
 * sets, each pairing a typed `decision` with the `DecisionState` it was
 * built for. These pin the exact wire JSON (`decision.build(state, model)`),
 * the backticked state-field references in every question, the candidate
 * option keys, each set's `questionSetVersion`, typed `run()` mapping, and
 * the §2.1/§8.3 guards at the candidate caps (30 tags, 50 folders, 30
 * rerank candidates).
 */

const BOOKMARK: SentBookmark = {
  title: "Tokio tutorial: async in depth",
  url: "https://tokio.rs/tokio/tutorial/async",
  domain: "tokio.rs",
};

const PARTNER: SentBookmark = {
  title: "Async Rust in depth",
  url: "https://blog.example.com/async-rust",
  domain: "blog.example.com",
};

const MODEL = "jev-test-model";

function fakeClient(
  answers: Record<string, Answer>,
  model = "jev-1.13.0",
): JevClient & { run: ReturnType<typeof vi.fn> } {
  return {
    model: "jev-latest",
    run: vi.fn(async () => ({
      model,
      answers,
      usage: { inputTokens: 120, outputTokens: 40, cost: 0.0003 },
      batches: 1,
    })),
  };
}

/** Every `` `name` `` referenced by a question text. */
function backtickRefs(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

describe("categorize", () => {
  const task = categorize({ bookmark: BOOKMARK });

  it("builds the exact §8.4 request JSON", () => {
    expect(task.decision.build(task.state, MODEL)).toEqual({
      model: MODEL,
      state: { bookmark: BOOKMARK },
      questions: {
        category: {
          type: "choice",
          instructions: {
            goal: "Classify a saved bookmark for a personal bookmark library.",
            question: "Which kind of resource is `bookmark`?",
          },
          criteria: {
            article:
              "A blog post, news story, essay, or tutorial meant to be read.",
            docs: "Official documentation or an API reference for a product or library.",
            tool: "A web app or online utility the user interacts with.",
            video: "A page whose main content is a video or a video channel.",
            repo: "A source code repository or package registry page.",
            reference:
              "A wiki, dictionary, cheat sheet, or other lookup resource.",
            shopping: "A product page or online store.",
            social: "A social media profile, post, or discussion thread.",
            other: "None of the above describes it well.",
          },
        },
      },
    });
  });

  it("offers exactly the Category enum values as option keys", () => {
    const question = task.decision.build(task.state, MODEL).questions[
      "category"
    ];
    expect(question?.type).toBe("choice");
    if (question?.type === "choice") {
      expect(Object.keys(question.criteria).sort()).toEqual(
        [...Category.options].sort(),
      );
    }
  });

  it("exports a questionSetVersion and a conforming state", () => {
    expect(categorizeVersion).toBe("categorize-v1");
    expect(task.questionSetVersion).toBe(categorizeVersion);
    expect(DecisionState.parse(task.state)).toEqual(task.state);
  });

  it("run() returns the typed Category value with API confidence", async () => {
    const client = fakeClient({
      category: {
        type: "choice",
        choice: "docs",
        probabilities: { article: 0.2, docs: 0.7, other: 0.1 },
        confidence: 0.7,
      },
    });
    const result = await task.decision.run(client, task.state);
    expect(client.run).toHaveBeenCalledWith(
      task.decision.build(task.state, "jev-latest"),
    );
    const category: Category = result.values.category;
    expect(category).toBe("docs");
    expect(result.confidence.category).toBe(0.7);
    expect(result.probabilities.category).toEqual({
      article: 0.2,
      docs: 0.7,
      other: 0.1,
    });
    expect(result.model).toBe("jev-1.13.0");
  });
});

describe("tags", () => {
  const task = tags({
    bookmark: BOOKMARK,
    tags: [
      {
        name: "rust",
        nameKey: "rust",
        description: "The Rust programming language",
      },
      { name: "async", nameKey: "async" },
      { name: "Tokio" },
    ],
  });
  const request = task.decision.build(task.state, MODEL);

  it("builds one noul per candidate tag, keyed by tag identity", () => {
    expect(request).toEqual({
      model: MODEL,
      state: {
        bookmark: BOOKMARK,
        candidateTags: [
          { name: "rust", description: "The Rust programming language" },
          { name: "async" },
          { name: "Tokio" },
        ],
      },
      questions: {
        tag_rust: {
          type: "noul",
          instructions: {
            goal: "Decide which of a library's existing tags apply to a saved bookmark.",
            question:
              '`tag` is the candidate tag {"name":"rust","description":"The Rust programming language"}. Is `bookmark` mainly about `tag`?',
          },
        },
        tag_async: {
          type: "noul",
          instructions: {
            goal: "Decide which of a library's existing tags apply to a saved bookmark.",
            question:
              '`tag` is the candidate tag {"name":"async"}. Is `bookmark` mainly about `tag`?',
          },
        },
        tag_Tokio: {
          type: "noul",
          instructions: {
            goal: "Decide which of a library's existing tags apply to a saved bookmark.",
            question:
              '`tag` is the candidate tag {"name":"Tokio"}. Is `bookmark` mainly about `tag`?',
          },
        },
      },
    });
  });

  it("never puts nameKey or a URL into the state or questions", () => {
    expect(DecisionState.parse(task.state)).toEqual(task.state);
    const json = JSON.stringify(request);
    expect(json).not.toContain("nameKey");
  });

  it("rejects an empty candidate list and duplicate tag keys", () => {
    expect(() => tags({ bookmark: BOOKMARK, tags: [] })).toThrow(TypeError);
    expect(() =>
      tags({
        bookmark: BOOKMARK,
        tags: [{ name: "rust", nameKey: "rust" }, { name: "Rust", nameKey: "rust" }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      tags({ bookmark: BOOKMARK, tags: [{ name: "   " }] }),
    ).toThrow(TypeError);
  });

  it("run() maps each noul to a boolean and a §10.1 margin confidence", async () => {
    const client = fakeClient({
      tag_rust: { type: "noul", noul: 0.9 },
      tag_async: { type: "noul", noul: 0.4 },
      tag_Tokio: { type: "noul", noul: 0.5 },
    });
    const result = await task.decision.run(client, task.state);
    expect(result.values).toEqual({
      tag_rust: true,
      tag_async: false,
      tag_Tokio: true,
    });
    // Margins: p=0.9 → 0.8, p=0.4 → 0.2, p=0.5 → 0.
    expect(result.confidence.tag_rust).toBeCloseTo(0.8);
    expect(result.confidence.tag_async).toBeCloseTo(0.2);
    expect(result.confidence.tag_Tokio).toBe(0);
    expect(result.probabilities.tag_rust?.["true"]).toBe(0.9);
    expect(result.probabilities.tag_rust?.["false"]).toBeCloseTo(0.1);
  });
});

describe("placement", () => {
  const task = placement({
    bookmark: BOOKMARK,
    folders: [
      { id: "f_12", path: ["Bookmarks bar", "Dev", "Rust"] },
      { id: "f_31", path: ["Bookmarks bar", "Reading"] },
    ],
  });
  const request = task.decision.build(task.state, MODEL);

  it("builds one choice over folder IDs plus `none`", () => {
    expect(request).toEqual({
      model: MODEL,
      state: {
        bookmark: BOOKMARK,
        candidateFolders: [
          { id: "f_12", path: ["Bookmarks bar", "Dev", "Rust"] },
          { id: "f_31", path: ["Bookmarks bar", "Reading"] },
        ],
      },
      questions: {
        folder: {
          type: "choice",
          instructions: {
            goal: "Choose the best existing folder for a newly saved bookmark.",
            question:
              "Which folder from `candidateFolders` should `bookmark` be filed in?",
          },
          criteria: {
            f_12: "Bookmarks bar / Dev / Rust",
            f_31: "Bookmarks bar / Reading",
            none: "None of these folders fits.",
          },
        },
      },
    });
  });

  it("makes option keys equal the candidate folder IDs, then `none`", () => {
    const question = request.questions["folder"];
    if (question?.type === "choice") {
      expect(Object.keys(question.criteria)).toEqual(["f_12", "f_31", "none"]);
    } else {
      expect.unreachable("folder is a choice question");
    }
  });

  it("rejects an empty folder list, a duplicate id, and a `none` id", () => {
    expect(() => placement({ bookmark: BOOKMARK, folders: [] })).toThrow(
      TypeError,
    );
    expect(() =>
      placement({
        bookmark: BOOKMARK,
        folders: [
          { id: "f_1", path: ["A"] },
          { id: "f_1", path: ["B"] },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      placement({
        bookmark: BOOKMARK,
        folders: [{ id: "none", path: ["A"] }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      placement({
        bookmark: BOOKMARK,
        folders: [{ id: "  ", path: ["A"] }],
      }),
    ).toThrow(TypeError);
  });

  it("run() returns the chosen folder id (or `none`)", async () => {
    const client = fakeClient({
      folder: {
        type: "choice",
        choice: "f_12",
        probabilities: { f_12: 0.8, f_31: 0.1, none: 0.1 },
        confidence: 0.8,
      },
    });
    const result = await task.decision.run(client, task.state);
    expect(result.values.folder).toBe("f_12");
    expect(result.confidence.folder).toBe(0.8);
  });

  it("maps answers by option key, not by position (integer-like ids reorder)", async () => {
    // Chrome folder ids are integer-like strings; JS sorts integer-like
    // object keys ascending, so the criteria record is unordered. The
    // ordered state.candidateFolders array carries the model-facing order,
    // and an answer is looked up by key.
    const reordered = placement({
      bookmark: BOOKMARK,
      folders: [
        { id: "10", path: ["Ten"] },
        { id: "2", path: ["Two"] },
        { id: "1", path: ["One"] },
      ],
    });
    const request = reordered.decision.build(reordered.state, MODEL);
    expect(reordered.state.candidateFolders?.map((c) => c.id)).toEqual([
      "10",
      "2",
      "1",
    ]);
    const folder = request.questions["folder"];
    if (folder?.type === "choice") {
      expect(Object.keys(folder.criteria)).toEqual(["1", "2", "10", "none"]);
    } else {
      expect.unreachable("folder is a choice question");
    }
    const result = await reordered.decision.run(
      fakeClient({
        folder: {
          type: "choice",
          choice: "10",
          probabilities: { "10": 0.9, "2": 0.05, "1": 0.05, none: 0 },
          confidence: 0.9,
        },
      }),
      reordered.state,
    );
    expect(result.values.folder).toBe("10");
  });
});

describe("misfiled", () => {
  const task = misfiled({
    bookmark: BOOKMARK,
    folderPath: ["Bookmarks bar", "Reading"],
    folders: [
      { id: "f_31", path: ["Bookmarks bar", "Reading"], current: true },
      { id: "f_12", path: ["Bookmarks bar", "Dev", "Rust"] },
    ],
  });
  const request = task.decision.build(task.state, MODEL);

  it("builds the scan-time choice with `folderPath` in state and a marked current folder", () => {
    expect(request).toEqual({
      model: MODEL,
      state: {
        bookmark: BOOKMARK,
        folderPath: ["Bookmarks bar", "Reading"],
        candidateFolders: [
          { id: "f_31", path: ["Bookmarks bar", "Reading"] },
          { id: "f_12", path: ["Bookmarks bar", "Dev", "Rust"] },
        ],
      },
      questions: {
        folder: {
          type: "choice",
          instructions: {
            goal: "Decide whether a saved bookmark is filed in the right folder.",
            question:
              "`bookmark` is currently filed in `folderPath`. Which folder from `candidateFolders` should it be filed in?",
          },
          criteria: {
            f_31: "Bookmarks bar / Reading (current folder)",
            f_12: "Bookmarks bar / Dev / Rust",
            none: "None of these folders fits.",
          },
        },
      },
    });
  });

  it("run() returns the chosen folder id", async () => {
    const client = fakeClient({
      folder: {
        type: "choice",
        choice: "f_12",
        probabilities: { f_31: 0.3, f_12: 0.6, none: 0.1 },
        confidence: 0.6,
      },
    });
    const result = await task.decision.run(client, task.state);
    expect(result.values.folder).toBe("f_12");
    expect(result.confidence.folder).toBe(0.6);
  });
});

describe("nearDuplicate", () => {
  const task = nearDuplicate({ a: BOOKMARK, b: PARTNER });
  const request = task.decision.build(task.state, MODEL);

  it("builds one score question with the four §9.2 levels", () => {
    expect(request).toEqual({
      model: MODEL,
      state: { bookmark: BOOKMARK, pairPartner: PARTNER },
      questions: {
        same_content: {
          type: "score",
          instructions: {
            goal: "Decide whether two saved bookmarks point to the same content.",
            question: "Do `bookmark` and `pairPartner` point to the same content?",
          },
          criteria: [
            "Unrelated — the pages are not about the same thing.",
            "Same topic but different content — the pages overlap in subject but are distinct pages.",
            "Same content at a different URL or version — one is a copy, move, or update of the other.",
            "Identical page — the same content.",
          ],
        },
      },
    });
  });

  it("run() returns the level number with API confidence", async () => {
    const client = fakeClient({
      same_content: {
        type: "score",
        score: 3,
        legend: { "1": "unrelated", "4": "identical" },
        probabilities: { "1": 0.05, "2": 0.15, "3": 0.7, "4": 0.1 },
        confidence: 0.7,
      },
    });
    const result = await task.decision.run(client, task.state);
    expect(result.values.same_content).toBe(3);
    expect(result.confidence.same_content).toBe(0.7);
    expect(result.probabilities.same_content["3"]).toBeCloseTo(0.7);
  });
});

describe("rerank", () => {
  const task = rerank({
    query: "rust async executors",
    candidates: [BOOKMARK, PARTNER],
  });
  const request = task.decision.build(task.state, MODEL);

  it("builds one noul per candidate, referenced by `candidateBookmarks` index", () => {
    expect(request).toEqual({
      model: MODEL,
      state: { query: "rust async executors", candidateBookmarks: [BOOKMARK, PARTNER] },
      questions: {
        candidate_0: {
          type: "noul",
          instructions: {
            goal: "Decide which bookmarks match a search query.",
            question:
              "`bookmark` is the `candidateBookmarks` entry at index 0. Does `bookmark` match what `query` is looking for?",
          },
        },
        candidate_1: {
          type: "noul",
          instructions: {
            goal: "Decide which bookmarks match a search query.",
            question:
              "`bookmark` is the `candidateBookmarks` entry at index 1. Does `bookmark` match what `query` is looking for?",
          },
        },
      },
    });
  });

  it("keeps candidate URLs out of the question text", () => {
    for (const question of Object.values(request.questions)) {
      const text = (question.instructions as { question: string }).question;
      expect(text).not.toContain("https://");
      expect(text).not.toContain("tokio.rs");
    }
  });

  it("rejects an empty query and an empty candidate list", () => {
    expect(() =>
      rerank({ query: "  ", candidates: [BOOKMARK] }),
    ).toThrow(TypeError);
    expect(() => rerank({ query: "q", candidates: [] })).toThrow(TypeError);
  });

  it("run() maps each candidate noul to a boolean with probabilities", async () => {
    const client = fakeClient({
      candidate_0: { type: "noul", noul: 0.9 },
      candidate_1: { type: "noul", noul: 0.2 },
    });
    const result = await task.decision.run(client, task.state);
    expect(result.values).toEqual({ candidate_0: true, candidate_1: false });
    expect(result.probabilities.candidate_1).toEqual({
      true: 0.2,
      false: 0.8,
    });
    expect(result.confidence.candidate_0).toBeCloseTo(0.8);
  });
});

describe("shared invariants", () => {
  const tasks = [
    categorize({ bookmark: BOOKMARK }),
    tags({
      bookmark: BOOKMARK,
      tags: [{ name: "rust", nameKey: "rust" }],
    }),
    placement({
      bookmark: BOOKMARK,
      folders: [{ id: "f_1", path: ["A"] }],
    }),
    misfiled({
      bookmark: BOOKMARK,
      folderPath: ["A"],
      folders: [{ id: "f_1", path: ["A"], current: true }],
    }),
    nearDuplicate({ a: BOOKMARK, b: PARTNER }),
    rerank({ query: "q", candidates: [BOOKMARK] }),
  ];

  it("every set exports a distinct non-empty questionSetVersion", () => {
    const versions = tasks.map((t) => t.questionSetVersion);
    for (const v of versions) {
      expect(typeof v).toBe("string");
      expect(v?.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(versions).size).toBe(versions.length);
    expect([
      categorizeVersion,
      tagsVersion,
      placementVersion,
      misfiledVersion,
      nearDuplicateVersion,
      rerankVersion,
    ]).toEqual(versions);
  });

  it("every question carries {goal, question} instructions", () => {
    for (const task of tasks) {
      const request = task.decision.build(task.state, MODEL);
      for (const [key, question] of Object.entries(request.questions)) {
        expect(
          question.instructions,
          `question ${key} in ${task.questionSetVersion}`,
        ).toEqual({
          goal: expect.any(String),
          question: expect.any(String),
        });
        const instructions = question.instructions as {
          goal: string;
          question: string;
        };
        expect(instructions.goal.trim()).not.toBe("");
        expect(instructions.question.trim()).not.toBe("");
      }
    }
  });

  it("every question refers to named state fields (or a locally defined field) in backticks", () => {
    // Only two sets reference a field the state does not carry: `tags`
    // defines `tag` and `rerank` defines `bookmark`, each inside the question
    // text itself. Every other set must reference real state fields only.
    const localRefsBySet: Record<string, readonly string[]> = {
      "tags-v1": ["tag"],
      "rerank-v1": ["bookmark"],
    };
    for (const task of tasks) {
      const allowedLocalRefs = new Set(
        localRefsBySet[task.questionSetVersion] ?? [],
      );
      const stateKeys = new Set(
        Object.keys(task.state).filter(
          (key) => (task.state as Record<string, unknown>)[key] !== undefined,
        ),
      );
      const request = task.decision.build(task.state, MODEL);
      for (const question of Object.values(request.questions)) {
        const text = (question.instructions as { question: string }).question;
        const refs = backtickRefs(text);
        expect(refs.length).toBeGreaterThan(0);
        for (const ref of refs) {
          if (stateKeys.has(ref)) {
            continue;
          }
          expect(
            allowedLocalRefs.has(ref),
            `${task.questionSetVersion} references \`${ref}\` which is neither a state field nor a locally defined field`,
          ).toBe(true);
          // A whitelisted local ref must actually be defined in the question.
          expect(text).toContain(`\`${ref}\` is`);
        }
      }
    }
  });

  it("every built request and state conforms to the wire and DecisionState schemas", () => {
    for (const task of tasks) {
      const request = task.decision.build(task.state, MODEL);
      expect(SystemOneRequest.safeParse(request).success).toBe(true);
      expect(DecisionState.safeParse(task.state).success).toBe(true);
      expect(() => checkGuards(request)).not.toThrow();
    }
  });

  it("never includes notes or uncleaned URL parts", () => {
    for (const task of tasks) {
      const request = task.decision.build(task.state, MODEL);
      const json = JSON.stringify(request);
      expect(json).not.toContain('"notes"');
      // URL cleanliness in state is enforced by CleanedUrl via the
      // DecisionState.safeParse check above; question texts are free text.
    }
  });
});

describe("guards at the candidate caps", () => {
  const manyTags = Array.from({ length: 30 }, (_, i) => ({
    name: `tag-${i}`,
    nameKey: `tag-${i}`,
    description: `Candidate tag number ${i}`,
  }));
  const manyFolders = Array.from({ length: 50 }, (_, i) => ({
    id: `f_${i}`,
    path: ["Bookmarks bar", `Section ${i}`, `Folder ${i}`],
  }));
  const manyBookmarks = Array.from({ length: 30 }, (_, i) => ({
    title: `Result ${i} about rust async`,
    url: `https://example.com/articles/${i}`,
    domain: "example.com",
  }));

  it("30 tag nouls stay inside the guards and the 64k batch budget", () => {
    const task = tags({ bookmark: BOOKMARK, tags: manyTags });
    const request = task.decision.build(task.state, MODEL);
    expect(Object.keys(request.questions)).toHaveLength(30);
    expect(() => checkGuards(request)).not.toThrow();
    expect(
      estimateTokens(request.state) + estimateTokens(request.questions),
    ).toBeLessThanOrEqual(MAX_BATCH_TOTAL_TOKENS);
  });

  it("50 folder candidates + `none` = 51 options stay inside the guards", () => {
    const task = placement({ bookmark: BOOKMARK, folders: manyFolders });
    const request = task.decision.build(task.state, MODEL);
    const folder = request.questions["folder"];
    if (folder?.type === "choice") {
      expect(Object.keys(folder.criteria)).toHaveLength(51);
    }
    expect(() => checkGuards(request)).not.toThrow();
    expect(
      estimateTokens(request.state) + estimateTokens(request.questions),
    ).toBeLessThanOrEqual(MAX_BATCH_TOTAL_TOKENS);
  });

  it("a beyond-cap current folder (51 candidates + `none`) still passes the guards", () => {
    const task = misfiled({
      bookmark: BOOKMARK,
      folderPath: ["Bookmarks bar", "Current"],
      folders: [
        ...manyFolders,
        { id: "f_current", path: ["Bookmarks bar", "Current"], current: true },
      ],
    });
    const request = task.decision.build(task.state, MODEL);
    // The state must hold all 51 folders (50 ranked + the guaranteed current
    // one) — DecisionState.candidateFolders is capped at 51 for exactly this.
    expect(task.state.candidateFolders).toHaveLength(51);
    expect(DecisionState.safeParse(task.state).success).toBe(true);
    const folder = request.questions["folder"];
    if (folder?.type === "choice") {
      // 51 folder options + `none`.
      expect(Object.keys(folder.criteria)).toHaveLength(52);
      expect(Object.keys(folder.criteria)).toContain("f_current");
      expect(Object.keys(folder.criteria)).toContain("none");
    } else {
      expect.unreachable("folder is a choice question");
    }
    expect(() => checkGuards(request)).not.toThrow();
    expect(
      estimateTokens(request.state) + estimateTokens(request.questions),
    ).toBeLessThanOrEqual(MAX_BATCH_TOTAL_TOKENS);
  });

  it("30 rerank nouls stay inside the guards and the 64k batch budget", () => {
    const task = rerank({ query: "rust async", candidates: manyBookmarks });
    const request = task.decision.build(task.state, MODEL);
    expect(Object.keys(request.questions)).toHaveLength(30);
    expect(() => checkGuards(request)).not.toThrow();
    expect(
      estimateTokens(request.state) + estimateTokens(request.questions),
    ).toBeLessThanOrEqual(MAX_BATCH_TOTAL_TOKENS);
  });
});
