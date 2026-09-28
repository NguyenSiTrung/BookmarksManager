import { z } from "./z";

/**
 * Restructure contracts (spec FR8). Two wire shapes:
 *
 * - `RestructureProposal` — the LLM's answer: a bounded set of proposed
 *   folder paths with human-facing descriptions. Schema-validated before
 *   anything downstream reads it.
 * - `RestructureAssignment` — Jev's per-bookmark Choice answer mapping a
 *   bookmark id to a proposed folder path, plus the confidence the
 *   proposal/apply UI renders.
 *
 * Everything is bounded by `RESTRUCTURE_LIMITS` — a proposal that exceeds
 * folder count/depth/name/description limits fails validation instead of
 * silently truncating (the failure is the honest signal to the provider).
 */

export const RESTRUCTURE_LIMITS = {
  /** Max folders a proposal may create. */
  folders: 20,
  /** Max `/`-separated depth per proposed path ("/" itself is not a segment). */
  folderDepth: 4,
  /** Max chars per folder name segment. */
  folderName: 80,
  /** Max chars per folder description. */
  description: 500,
  /** Max chars per proposed path overall. */
  path: 400,
  /** Synopsis: max representative titles per folder bucket. */
  representativeTitles: 3,
  /** Synopsis: max chars per representative title. */
  titleLength: 120,
  /** Synopsis: max distinct domains listed. */
  domains: 50,
  /** Synopsis: max folder paths listed. */
  folderPaths: 100,
} as const;

const FOLDER_PATH_SEGMENT = z.string().min(1).max(RESTRUCTURE_LIMITS.folderName);

/** Slash-separated path below the root, e.g. "dev/tools". Depth ≤ limits. */
export const ProposedFolderPath = z
  .string()
  .min(1)
  .max(RESTRUCTURE_LIMITS.path)
  .refine(
    (p) => {
      const segments = p.split("/");
      return (
        segments.every((s) => s.length >= 1 && s.length <= RESTRUCTURE_LIMITS.folderName) &&
        segments.length <= RESTRUCTURE_LIMITS.folderDepth
      );
    },
    { message: "folder path exceeds depth/name limits" },
  );

export const ProposedFolder = z.strictObject({
  /** Slash-separated path under the chosen root (never the root itself). */
  path: ProposedFolderPath,
  /** One-paragraph human description — capped, may be empty on review. */
  description: z.string().max(RESTRUCTURE_LIMITS.description),
});
export type ProposedFolder = z.infer<typeof ProposedFolder>;

export const RestructureProposal = z.strictObject({
  folders: z
    .array(ProposedFolder)
    .min(1)
    .max(RESTRUCTURE_LIMITS.folders)
    .refine(
      (folders) =>
        new Set(folders.map((f) => f.path)).size === folders.length,
      { message: "duplicate folder paths are not allowed" },
    ),
});
export type RestructureProposal = z.infer<typeof RestructureProposal>;

/** Jev's per-bookmark assignment — constrained to the proposal's paths. */
export const RestructureAssignment = z.strictObject({
  bookmarkId: z.string().min(1),
  /** The chosen proposed path, or `null` when Jev left it unresolved. */
  proposedPath: ProposedFolderPath.nullable(),
  /** Jev's reported confidence in [0,1]; `null` when unresolved. */
  confidence: z.number().min(0).max(1).nullable(),
});
export type RestructureAssignment = z.infer<typeof RestructureAssignment>;

/** The LLM synopsis — the only shape the proposal prompt carries. */
export const LibrarySynopsis = z.strictObject({
  /** Existing folder paths, sorted, ≤ `folderPaths`. */
  folderPaths: z.array(z.string().min(1).max(RESTRUCTURE_LIMITS.path)),
  /** Per-category bookmark counts (keys are `Category` enum values). */
  categories: z.record(z.string(), z.number().int().min(0)),
  /** Per-tag (nameKey) bookmark counts. */
  tags: z.record(z.string(), z.number().int().min(0)),
  /** Top domains by bookmark count, ≤ `domains`. */
  domains: z.array(
    z.strictObject({ domain: z.string(), count: z.number().int().min(1) }),
  ),
  /** A handful of representative titles per existing folder, ≤ `titleLength`. */
  representativeTitles: z.record(
    z.string(),
    z.array(z.string().min(1).max(RESTRUCTURE_LIMITS.titleLength)),
  ),
  /** Total bookmark count (sendable rows only). */
  bookmarkCount: z.number().int().min(0),
});
export type LibrarySynopsis = z.infer<typeof LibrarySynopsis>;

void FOLDER_PATH_SEGMENT;
