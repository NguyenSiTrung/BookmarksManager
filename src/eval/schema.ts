import { z } from "../schemas/z";
import { Category } from "../schemas/bookmark";
import { isNonPublicUrl, isSensitiveUrl } from "../decisions/minimize";

/**
 * The labeled evaluation corpus contract (spec FR1, plan Phase 6): the
 * schema `tests/eval/fixtures/corpus.json` must satisfy and the shape the
 * key-gated eval runner consumes. Pure module — no `chrome`, DOM, React,
 * `fetch`, filesystem, or wall-clock access.
 *
 * A corpus is a flat `bookmarks` pool plus labeled `cases` for every shipped
 * Jev question set (categorize, tags, placement, misfiled, near_duplicate,
 * rerank). Fixtures are synthetic and rights-safe by construction:
 *
 * - bookmark URLs that parse must be public-looking — private/intranet/
 *   hostless targets (`isNonPublicUrl`) and `user[:pass]@` credentials are
 *   rejected outright;
 * - a bookmark that must never leave the device is marked `excluded: true` —
 *   required for builtin-sensitive and unparseable URLs, forbidden for
 *   ordinary public ones — so an exclusion expectation is a property of the
 *   fixture, not of whichever cases happen to reference it;
 * - strict objects everywhere reject `notes`, credentials fields, and any
 *   other key the corpus format does not define;
 * - every bookmark reference resolves to a pool entry and every expected
 *   label points at a real candidate, so a typo'd id fails validation
 *   instead of silently corrupting a report.
 */

/** Corpus-local record/case ids: stable, greppable, machine-checkable. */
const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "an id is lowercase alphanumerics with '-'/'_' separators",
  );

/**
 * One synthetic library bookmark. `url` is the raw as-saved spelling — the
 * runner sends it through `minimizeBookmark`, so tracking parameters,
 * sensitive domains, and malformed strings exercise the same exclusion path
 * as production. `excluded` is the label for that path: it must be `true`
 * exactly when the bookmark cannot produce a sendable `SentBookmark`.
 */
export const EvalBookmark = z
  .strictObject({
    id: Id,
    title: z.string().max(500), // untitled fixtures carry ""
    url: z.string().min(1).max(2_048),
    excluded: z.boolean().default(false),
  })
  .superRefine((bookmark, ctx) => {
    let url: URL | null = null;
    try {
      url = new URL(bookmark.url);
    } catch {
      url = null;
    }
    if (url === null) {
      if (!bookmark.excluded) {
        ctx.addIssue({
          code: "custom",
          path: ["excluded"],
          message:
            "a bookmark whose url does not parse must be marked excluded",
        });
      }
      return;
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "fixture urls never carry credentials",
      });
    }
    if (isNonPublicUrl(bookmark.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "private, intranet, hostless, or file: urls never appear in fixtures",
      });
      return; // nothing meaningful left to check about the excluded flag
    }
    if (bookmark.excluded !== isSensitiveUrl(bookmark.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["excluded"],
        message: bookmark.excluded
          ? "only builtin-sensitive or malformed bookmarks may be excluded"
          : "a builtin-sensitive bookmark must be marked excluded: true",
      });
    }
  });
export type EvalBookmark = z.infer<typeof EvalBookmark>;

/**
 * One tag candidate for a `tags` case — the fixture-side shape of
 * `TagRef`. `nameKey` is optional; the effective option key is
 * `nameKey ?? name`, and `expect.tags` lists those keys.
 */
export const EvalTagCandidate = z.strictObject({
  name: z.string().min(1).max(64),
  nameKey: z.string().min(1).max(64).optional(),
  description: z.string().max(300).optional(),
});
export type EvalTagCandidate = z.infer<typeof EvalTagCandidate>;

/**
 * One folder candidate for a `placement`/`misfiled` case — the fixture-side
 * shape of `FolderRef`. `current` is reserved for `misfiled` cases, where
 * exactly one candidate must carry `current: true` and its `path` must equal
 * the case's `folderPath` (the `misfiledCandidates` selector's contract).
 */
export const EvalFolderCandidate = z.strictObject({
  id: z.string().min(1).max(64),
  path: z.array(z.string().max(255)).min(1).max(64),
});
export const EvalMisfiledFolderCandidate = z.strictObject({
  id: z.string().min(1).max(64),
  path: z.array(z.string().max(255)).min(1).max(64),
  current: z.boolean().optional(),
});
export type EvalFolderCandidate = z.infer<typeof EvalFolderCandidate>;
export type EvalMisfiledFolderCandidate = z.infer<
  typeof EvalMisfiledFolderCandidate
>;

/** The always-present "no candidate fits" choice option. */
export const NONE_FOLDER_ID = "none";

/** Expected placement/misfiled label: a candidate folder id or "none". */
const ExpectedFolder = z.string().min(1).max(64);

/** Expected near-duplicate label: the 1–4 `same_content` level. */
const SameContentLevel = z.number().int().min(1).max(4);

export const EvalCategorizeCase = z.strictObject({
  kind: z.literal("categorize"),
  id: Id,
  /** Reference into `EvalCorpus.bookmarks`. */
  bookmark: Id,
  expect: z.strictObject({
    category: Category,
  }),
});
export type EvalCategorizeCase = z.infer<typeof EvalCategorizeCase>;

export const EvalTagsCase = z
  .strictObject({
    kind: z.literal("tags"),
    id: Id,
    bookmark: Id,
    /** Ranked candidates — the `tags` question set's own cap is 30. */
    tags: z.array(EvalTagCandidate).min(1).max(30),
    expect: z.strictObject({
      /** Effective keys (`nameKey ?? name`) of the tags that apply. */
      tags: z.array(z.string().min(1)).max(30),
    }),
  })
  .superRefine((c, ctx) => {
    const keys = c.tags.map((tag) => tag.nameKey ?? tag.name);
    const unique = new Set(keys);
    if (unique.size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["tags"],
        message: "tag candidates resolve to duplicate option keys",
      });
    }
    for (const [index, wanted] of c.expect.tags.entries()) {
      if (!unique.has(wanted)) {
        ctx.addIssue({
          code: "custom",
          path: ["expect", "tags", index],
          message: "expected tag is not one of the case's candidates",
        });
      }
    }
  });
export type EvalTagsCase = z.infer<typeof EvalTagsCase>;

/** Shared checks for the folder-choice cases (placement + misfiled). */
function checkFolderCase(
  folders: readonly { id: string }[],
  expected: string,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, folder] of folders.entries()) {
    if (folder.id === NONE_FOLDER_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["folders", index, "id"],
        message: `a folder candidate id cannot be the reserved ${JSON.stringify(NONE_FOLDER_ID)} option`,
      });
    }
    if (ids.has(folder.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["folders", index, "id"],
        message: "folder candidates share an id",
      });
    }
    ids.add(folder.id);
  }
  if (expected !== NONE_FOLDER_ID && !ids.has(expected)) {
    ctx.addIssue({
      code: "custom",
      path: ["expect", "folder"],
      message: "expected folder is not one of the case's candidates",
    });
  }
}

export const EvalPlacementCase = z
  .strictObject({
    kind: z.literal("placement"),
    id: Id,
    bookmark: Id,
    /** Ranked candidates — the `placement` question set's own cap is 50. */
    folders: z.array(EvalFolderCandidate).min(1).max(50),
    expect: z.strictObject({
      folder: ExpectedFolder,
    }),
  })
  .superRefine((c, ctx) => checkFolderCase(c.folders, c.expect.folder, ctx));
export type EvalPlacementCase = z.infer<typeof EvalPlacementCase>;

export const EvalMisfiledCase = z
  .strictObject({
    kind: z.literal("misfiled"),
    id: Id,
    bookmark: Id,
    /** The bookmark's current folder path, root-first ([] = at root). */
    folderPath: z.array(z.string().max(255)).max(64),
    /**
     * Ranked candidates — cap 51: the scan's 50 ranked folders plus the
     * guaranteed current-folder entry.
     */
    folders: z.array(EvalMisfiledFolderCandidate).min(1).max(51),
    expect: z.strictObject({
      folder: ExpectedFolder,
    }),
  })
  .superRefine((c, ctx) => {
    checkFolderCase(c.folders, c.expect.folder, ctx);
    const current = c.folders.filter((f) => f.current === true);
    if (current.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["folders"],
        message:
          "a misfiled case marks exactly one candidate current: true",
      });
      return;
    }
    const first = current[0];
    if (
      first === undefined ||
      first.path.length !== c.folderPath.length ||
      !first.path.every((segment, i) => segment === c.folderPath[i])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["folders"],
        message:
          "the current candidate's path must equal the case's folderPath",
      });
    }
  });
export type EvalMisfiledCase = z.infer<typeof EvalMisfiledCase>;

export const EvalNearDuplicateCase = z
  .strictObject({
    kind: z.literal("near_duplicate"),
    id: Id,
    /** References into `EvalCorpus.bookmarks`; must be distinct. */
    a: Id,
    b: Id,
    expect: z.strictObject({
      same_content: SameContentLevel,
    }),
  })
  .superRefine((c, ctx) => {
    if (c.a === c.b) {
      ctx.addIssue({
        code: "custom",
        path: ["b"],
        message: "a near-duplicate pair needs two distinct bookmarks",
      });
    }
  });
export type EvalNearDuplicateCase = z.infer<typeof EvalNearDuplicateCase>;

export const EvalRerankCase = z
  .strictObject({
    kind: z.literal("rerank"),
    id: Id,
    /** The "Ask" search string — sent as `state.query`. */
    query: z.string().min(1).max(1_000),
    /** Shortlist references into `EvalCorpus.bookmarks` (cap 30). */
    candidates: z.array(Id).min(1).max(30),
    expect: z.strictObject({
      /** Subset of `candidates` a correct rerank returns. */
      matches: z.array(Id).max(30),
    }),
  })
  .superRefine((c, ctx) => {
    const unique = new Set(c.candidates);
    if (unique.size !== c.candidates.length) {
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "a rerank shortlist never repeats a bookmark",
      });
    }
  });
export type EvalRerankCase = z.infer<typeof EvalRerankCase>;

/** The discriminated union over the six shipped question-set case kinds. */
export const EvalCase = z.discriminatedUnion("kind", [
  EvalCategorizeCase,
  EvalTagsCase,
  EvalPlacementCase,
  EvalMisfiledCase,
  EvalNearDuplicateCase,
  EvalRerankCase,
]);
export type EvalCase = z.infer<typeof EvalCase>;

/** The six question-set names, as recorded in `questionSetVersions`. */
export const EVAL_QUESTION_SETS = [
  "categorize",
  "tags",
  "placement",
  "misfiled",
  "nearDuplicate",
  "rerank",
] as const;
export type EvalQuestionSet = (typeof EVAL_QUESTION_SETS)[number];

/**
 * The corpus: a fixture pool plus labeled cases, versioned together with the
 * question sets it exercises. `questionSetVersions` records the
 * `questionSetVersion` of each shipped set at authoring time — the runner
 * refuses a corpus whose pinned versions no longer match the code (spec
 * FR2.7: any wording/model change requires re-evaluation).
 */
export const EvalCorpus = z
  .strictObject({
    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+$/,
        "corpus version is a semver triple (e.g. 1.0.0)",
      ),
    questionSetVersions: z.strictObject({
      categorize: z.string().min(1),
      tags: z.string().min(1),
      placement: z.string().min(1),
      misfiled: z.string().min(1),
      nearDuplicate: z.string().min(1),
      rerank: z.string().min(1),
    }),
    bookmarks: z.array(EvalBookmark).min(1),
    cases: z.array(EvalCase).min(1),
  })
  .superRefine((corpus, ctx) => {
    const bookmarks = new Map<string, EvalBookmark>();
    for (const [index, bookmark] of corpus.bookmarks.entries()) {
      if (bookmarks.has(bookmark.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["bookmarks", index, "id"],
          message: `duplicate bookmark id ${JSON.stringify(bookmark.id)}`,
        });
      }
      bookmarks.set(bookmark.id, bookmark);
    }

    const caseIds = new Set<string>();
    const ref = (id: string, path: (string | number)[]): void => {
      if (!bookmarks.has(id)) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `unknown bookmark reference ${JSON.stringify(id)}`,
        });
      }
    };

    for (const [index, c] of corpus.cases.entries()) {
      if (caseIds.has(c.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `duplicate case id ${JSON.stringify(c.id)}`,
        });
      }
      caseIds.add(c.id);

      const base = ["cases", index] as (string | number)[];
      switch (c.kind) {
        case "categorize":
        case "tags":
        case "placement":
        case "misfiled":
          ref(c.bookmark, [...base, "bookmark"]);
          break;
        case "near_duplicate":
          ref(c.a, [...base, "a"]);
          ref(c.b, [...base, "b"]);
          break;
        case "rerank": {
          const seen = new Set<string>();
          for (const [i, id] of c.candidates.entries()) {
            ref(id, [...base, "candidates", i]);
            seen.add(id);
          }
          for (const [i, id] of c.expect.matches.entries()) {
            if (!seen.has(id)) {
              ctx.addIssue({
                code: "custom",
                path: [...base, "expect", "matches", i],
                message: "expected match is not one of the case's candidates",
              });
            } else if (bookmarks.get(id)?.excluded === true) {
              ctx.addIssue({
                code: "custom",
                path: [...base, "expect", "matches", i],
                message:
                  "an excluded bookmark can never be an expected match — it is dropped before send",
              });
            }
          }
          break;
        }
      }
    }
  });
export type EvalCorpus = z.infer<typeof EvalCorpus>;
