import { z } from "./z";
import { Decision } from "./decision";

/**
 * Append-only decision audit log (spec FR6, PROJECT_PLAN.md §7). One row per
 * decision status change, so the review history can be shown and reasoned
 * about without re-deriving it. The row records only the decision id, the
 * from/to statuses, who made the change, and when — it stores NO bookmark
 * content (no title, URL, folder, or tags), matching the data-minimization
 * rules the `sentLog` and consent rows also follow.
 *
 * `id` is auto-incremented by IndexedDB (`++id`), giving append order for
 * free; `decisionId` and `changedAt` are indexed for per-decision history and
 * chronological listing.
 */

/**
 * The from/to statuses are exactly the `Decision` status values. Deriving the
 * enum from the `Decision` schema keeps the audit and the decision store from
 * ever drifting apart.
 */
const DecisionStatus = Decision.options[0].shape.status;
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** Who changed the status: the user, or the auto-apply policy. */
export const AuditActor = z.enum(["user", "policy"]);
export type AuditActor = z.infer<typeof AuditActor>;

/**
 * One `audit` row. `id` is absent on input and assigned by IndexedDB. A row
 * describes a *change*, so `from` and `to` must differ.
 */
export const AuditEvent = z
  .strictObject({
    id: z.number().int().positive().optional(), // assigned by IndexedDB
    decisionId: z.uuid(),
    from: DecisionStatus,
    to: DecisionStatus,
    actor: AuditActor,
    changedAt: z.iso.datetime(),
  })
  .superRefine((event, ctx) => {
    if (event.from === event.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "a status change must differ from the previous status",
      });
    }
  });
export type AuditEvent = z.infer<typeof AuditEvent>;
