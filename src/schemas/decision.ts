import { z } from "./z";
import { Category } from "./bookmark";

// Field shapes follow PROJECT_PLAN.md §7 "Data Model (Zod)" verbatim.

const DecisionBase = z.object({
  id: z.uuid(),
  bookmarkIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()).optional(), // raw Jev distribution
  rationale: z.string().max(1_000).optional(), // LLM-written, on request
  status: z.enum([
    "pending",
    "auto_applied",
    "approved",
    "rejected",
    "applied",
    "reverted",
    "unsure",
  ]),
  source: z.object({
    engine: z.enum(["jev", "llm", "rule"]),
    providerId: z.string(),
    model: z.string(), // versioned id from the response, e.g. jev-1.13.0
    questionSetVersion: z.string(), // bump when question wording changes
  }),
  escalation: z
    .object({
      llmVerdict: z.enum(["agree", "disagree", "unsure"]),
      llmModel: z.string(),
      /** The allowed-option id the LLM picked when it disagreed. */
      llmAlternative: z.string().min(1).max(64).optional(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
});

export const Decision = z.discriminatedUnion("kind", [
  DecisionBase.extend({ kind: z.literal("set_category"), category: Category }),
  DecisionBase.extend({ kind: z.literal("add_tags"), tags: z.array(z.string()).min(1) }),
  DecisionBase.extend({ kind: z.literal("move"), targetFolderId: z.string() }),
  DecisionBase.extend({
    kind: z.literal("mark_dead"),
    evidence: z.enum(["http", "soft_404", "parked", "login_wall"]),
  }),
  DecisionBase.extend({ kind: z.literal("merge_duplicates"), keepId: z.string() }),
  DecisionBase.extend({ kind: z.literal("rename"), newTitle: z.string() }),
  DecisionBase.extend({
    kind: z.literal("create_folder"),
    path: z.array(z.string()).min(1),
    description: z.string(),
  }),
]);

export type Decision = z.infer<typeof Decision>;
