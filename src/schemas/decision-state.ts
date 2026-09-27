import { z } from "./z";

/**
 * `DecisionState` is the closed description of everything a Jev question set
 * may place into `SystemOneRequest.state` (PROJECT_PLAN.md §9 — "state is
 * only what is judged"; spec FR1/FR2). The `jev_decisions` gate guard
 * strict-parses the outgoing state with this schema before it reads consent,
 * permissions, or the key, so a state carrying unknown fields, content that
 * is never sent (notes, page text), or URLs that are not already cleaned is
 * refused before anything can leave the device.
 *
 * Named optional fields correspond to the candidate sets each question set
 * populates (categorize/tags/placement/misfiled/nearDuplicate/rerank). There
 * is deliberately **no** `notes` field — bookmark notes never leave the
 * device (plan §12, §13.4).
 */

/**
 * A URL already cleaned by `src/decisions/minimize.ts` `cleanUrl`: it parses
 * as an absolute URL and carries no query string, no fragment, and no
 * `user[:pass]@` credentials — not even a bare trailing `?` or `#` (the
 * WHATWG parser records an empty `search`/`hash` for those spellings, so the
 * raw-string check rejects them).
 */
export const CleanedUrl = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) => {
      if (/[?#]/.test(value)) {
        return false;
      }
      // `.refine` still runs when an earlier check fails (Zod 4), so the
      // throwing parse stays inside try/catch.
      try {
        const url = new URL(value);
        return (
          url.search === "" &&
          url.hash === "" &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "url must be already cleaned: an absolute URL with no query, fragment, or userinfo",
    },
  );
export type CleanedUrl = z.infer<typeof CleanedUrl>;

/**
 * The only bookmark facts Jev may see: title, cleaned URL, and domain. The
 * Chrome node `id` is deliberately absent — ids are a local implementation
 * detail the disclosure (plan §13.4) does not list. `domain` must equal the
 * cleaned URL's hostname so the two fields can never disagree about where
 * the bookmark points.
 */
export const SentBookmark = z
  .strictObject({
    title: z.string().max(500), // untitled bookmarks send ""
    url: CleanedUrl,
    domain: z.string().min(1).max(253), // `new URL(url).hostname`, verbatim
  })
  .superRefine((bookmark, ctx) => {
    let hostname: string;
    try {
      hostname = new URL(bookmark.url).hostname;
    } catch {
      return; // CleanedUrl already reported the parse failure.
    }
    if (hostname !== bookmark.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["domain"],
        message: "domain must equal the url's hostname",
      });
    }
  });
export type SentBookmark = z.infer<typeof SentBookmark>;

/**
 * A tag offered to Jev as a yes/no option: the display name plus the
 * optional description that explains the option's meaning (mirrors the
 * `TagDef` bounds). `nameKey` is deliberately absent — Jev sees names, and
 * answers map back in code.
 */
export const CandidateTag = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(300).optional(),
});
export type CandidateTag = z.infer<typeof CandidateTag>;

/**
 * A folder offered to Jev as a choice option: `id` is the Chrome folder id
 * used as the option key in answers, `path` the human-readable segment list
 * shown as the option's description (root-to-self order).
 */
export const CandidateFolder = z.strictObject({
  id: z.string().min(1),
  path: z.array(z.string()).min(1).max(64),
});
export type CandidateFolder = z.infer<typeof CandidateFolder>;

/**
 * The closed state object. Every field is optional — a question set includes
 * only the fields its questions name — but the state must not be empty.
 * Array caps mirror the candidate pre-filter limits (FR3): 30 tags, 50
 * folders, 30 rerank candidates. `pairPartner` carries the second bookmark
 * of a near-duplicate pair; `candidateBookmarks` carries the rerank
 * shortlist so every URL in the state is `CleanedUrl`-checked;
 * `query` is the "Ask" search string.
 */
export const DecisionState = z
  .strictObject({
    bookmark: SentBookmark.optional(),
    folderPath: z.array(z.string()).max(64).optional(), // [] = lives at root
    candidateTags: z.array(CandidateTag).max(30).optional(),
    candidateFolders: z.array(CandidateFolder).max(50).optional(),
    candidateBookmarks: z.array(SentBookmark).max(30).optional(),
    pairPartner: SentBookmark.optional(),
    query: z.string().min(1).max(1_000).optional(),
  })
  .superRefine((state, ctx) => {
    // `Object.values` skips nothing — `{bookmark: undefined}` still owns the
    // key — so count fields that are actually populated.
    if (!Object.values(state).some((field) => field !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "state must carry at least one field",
      });
    }
  });
export type DecisionState = z.infer<typeof DecisionState>;
