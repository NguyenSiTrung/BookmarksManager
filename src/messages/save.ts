import { z } from "../schemas/z";
import { isBlockedScheme } from "../io/netscape";
import {
  createTag,
  getTag,
  MetaRepoError,
  patchMeta,
} from "../db/meta";
import { Category } from "../schemas/bookmark";
import { NOTES_MAX_LENGTH, tagNameKey } from "../schemas/meta";
import { setLastFolderId } from "../sync/last-folder";
import { createBookmark, removeTree } from "../sync/mutations";

/**
 * The worker side of the popup's quick save (U06).
 *
 * Why a worker message: the popup is a context Chrome destroys on close —
 * the old flow ran resolve-tags → `createBookmark` → `patchMeta` in the
 * popup itself, so closing mid-save could kill the chain between the
 * bookmark create and its meta write, leaving a half-saved node. With one
 * `SAVE` message the whole sequence runs in the service worker, which
 * outlives the popup: a popup destroyed after the send still yields
 * bookmark + meta (and the last-used-folder preference).
 *
 * Invariants, mirroring `src/messages/decisions.ts`:
 *
 * - **Total.** `handleSaveMessage` never throws: every path resolves to a
 *   `SaveMessageResult`, so the `chrome.runtime.onMessage` adapter can
 *   answer `sendResponse` exactly once.
 * - **Fall-through.** A message this module does not own returns
 *   `undefined`, so the other handlers still receive it.
 * - **Trusted senders only.** Same extension-page check as the decisions
 *   protocol — a content script or foreign extension gets
 *   `untrusted_sender`.
 * - **Redacted error mapping.** A code-shaped thrown `.code` relays its
 *   own (already-redacted) code + message; anything else collapses to
 *   `internal_error` so a raw error string can never cross the boundary.
 * - **Validated write boundary.** `isBlockedScheme` is re-checked in the
 *   worker even though the popup checks it before sending — the message
 *   boundary is the trust line, not the popup's form state.
 */

declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** The `type` discriminators this module owns. */
export const SAVE_MESSAGE_TYPES = ["SAVE"] as const;
const OWNED_TYPES: ReadonlySet<string> = new Set(SAVE_MESSAGE_TYPES);

/**
 * One quick save: the popup's form values. `tags` carries `{key,label}`
 * pairs — each key must be `tagNameKey(label)` exactly (derived data, not
 * free text) so a tag chip can never point at a different def than the one
 * the label resolves. `notes` is bounded by the store's `NOTES_MAX_LENGTH`
 * so an oversized paste fails here as `malformed_message` instead of
 * unwinding a created bookmark in `patchMeta`. `category: ""` and
 * `notes: ""` mean unset.
 */
export const SaveMessage = z.object({
  type: z.literal("SAVE"),
  parentId: z.string().min(1),
  title: z.string(),
  url: z.string(),
  tags: z
    .array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1).max(64),
        })
        .refine((chip) => chip.key === tagNameKey(chip.label), {
          message: "tag key must equal tagNameKey(label)",
        }),
    )
    .max(1000),
  category: z.union([Category, z.literal("")]),
  notes: z.string().max(NOTES_MAX_LENGTH),
});
export type SaveMessage = z.infer<typeof SaveMessage>;

/** Lowercase snake_case token — same shape as DecisionErrorCode. */
const CODE_SHAPE = /^[a-z][a-z0-9_]*$/;
export const SaveErrorCode = z.string().regex(CODE_SHAPE);
export type SaveErrorCode = z.infer<typeof SaveErrorCode>;

/**
 * Every worker response is one of these shapes: the created bookmark's id
 * on success, or a redacted `{code, message}` on failure.
 */
export const SaveMessageResult = z.union([
  z.object({ ok: z.literal(true), bookmarkId: z.string() }),
  z.object({
    ok: z.literal(false),
    code: SaveErrorCode,
    message: z.string(),
  }),
]);
export type SaveMessageResult = z.infer<typeof SaveMessageResult>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface SaveMessageSender {
  url?: string;
}

function failure(code: SaveErrorCode, message: string): SaveMessageResult {
  return { ok: false, code, message };
}

/** True only for a page belonging to THIS extension. */
function isTrustedExtensionSender(sender: SaveMessageSender): boolean {
  try {
    const base = chrome.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(base);
  } catch {
    return false;
  }
}

/** The message's discriminator, when it is one this module owns. */
function ownedType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { readonly type?: unknown }).type;
  return typeof type === "string" && OWNED_TYPES.has(type) ? type : undefined;
}

/**
 * Map any thrown cause onto the protocol's error model — the same rule the
 * decisions handler uses: a code-shaped `.code` is a typed, already-redacted
 * service error and relays verbatim; anything else is `internal_error` with
 * a static message so a raw error string never crosses.
 */
function mapError(cause: unknown): SaveMessageResult {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && CODE_SHAPE.test(code)) {
      const message = (cause as { readonly message?: unknown }).message;
      return failure(
        code,
        typeof message === "string" && message !== ""
          ? message
          : "The save failed; nothing was written on purpose.",
      );
    }
  }
  return failure(
    "internal_error",
    "The save failed unexpectedly; nothing was written on purpose.",
  );
}

/**
 * The whole quick-save sequence, formerly inline in the popup:
 * scheme boundary → per-chip tag def resolve-or-create → `createBookmark`
 * → `patchMeta` (unwind on failure) → remember the folder. Runs entirely
 * in the worker so a destroyed popup cannot interrupt it.
 */
async function quickSave(input: SaveMessage): Promise<SaveMessageResult> {
  const url = input.url.trim();
  const title = input.title.trim();
  if (url === "") {
    return failure("invalid_input", "Enter a URL to save.");
  }
  if (isBlockedScheme(url)) {
    return failure(
      "blocked_scheme",
      "This URL scheme cannot be saved as a bookmark.",
    );
  }
  // Tag defs resolve BEFORE the bookmark exists — they are the only step
  // that can fail without touching the tree. A tag_exists race just means
  // the def is already stored.
  for (const chip of input.tags) {
    if ((await getTag(chip.key)) !== undefined) continue;
    try {
      await createTag(chip.label);
    } catch (cause) {
      if (!(cause instanceof MetaRepoError && cause.code === "tag_exists")) {
        throw cause;
      }
    }
  }
  const created = await createBookmark({
    parentId: input.parentId,
    title: title === "" ? url : title,
    url,
  });
  try {
    // The exact staged key list (removed chips are dropped) plus
    // category/notes in one meta write.
    await patchMeta(created.id, {
      tags: input.tags.map((chip) => chip.key),
      category: input.category === "" ? null : input.category,
      notes: input.notes === "" ? null : input.notes,
      url,
    });
  } catch (metaCause) {
    // Nothing should reference a half-saved bookmark — unwind it so the
    // failed save leaves only the (harmless) tag defs behind.
    await removeTree(created.id).catch(() => undefined);
    throw metaCause;
  }
  // Last-used folder preference — worker-side so a closing popup does not
  // lose it. Best-effort by contract (setLastFolderId never throws).
  await setLastFolderId(input.parentId);
  return { ok: true, bookmarkId: created.id };
}

/**
 * Validate and dispatch one save-protocol message. Returns `undefined` for
 * a message this module does not own (a no-op the adapter forwards on),
 * otherwise a `SaveMessageResult`. Total: it never throws — the trust
 * check runs first, validation failures become `malformed_message`, and
 * any throw inside `quickSave` is mapped through {@link mapError}.
 */
export async function handleSaveMessage(
  message: unknown,
  sender: SaveMessageSender,
): Promise<SaveMessageResult | undefined> {
  if (ownedType(message) === undefined) return undefined;
  try {
    if (!isTrustedExtensionSender(sender)) {
      return failure(
        "untrusted_sender",
        "Save messages are only handled from this extension's own pages.",
      );
    }
    const parsed = SaveMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the save protocol.",
      );
    }
    return await quickSave(parsed.data);
  } catch (cause) {
    return mapError(cause);
  }
}
