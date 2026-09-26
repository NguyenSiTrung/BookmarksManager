import { defineBackground } from "wxt/utils/define-background";
import { handleProviderMessage } from "../messages/provider";
import { registerOmnibox } from "../search/omnibox";
import { registerContextMenus } from "../sync/context-menu";
import { registerBookmarkListeners } from "../sync/listeners";
import { reconcileMetadata } from "../sync/reconcile";

/**
 * At startup the worker subscribes the five bookmark events (which
 * cascade-delete extension metadata for removed subtrees and broadcast
 * `bookmarks-changed` to open pages), rebuilds the right-click "Save page"/
 * "Save link" context-menu items (`src/sync/context-menu.ts`), and runs one
 * metadata reconcile for deletions missed while the service worker was
 * suspended. It performs no network requests at startup. `chrome` is the
 * lazy-slice house pattern so test stubs work; only `runtime.onMessage` is
 * needed here — the sync modules (including the context-menu slice) declare
 * their own slices. Of the provider protocol, only TEST_PROVIDER can produce
 * egress, and only via the consented gate in `src/net/send.ts` — everything
 * else is storage work.
 */
declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { url?: string },
          sendResponse: (response?: unknown) => void,
        ) => boolean,
      ): void;
    };
  };
};

export default defineBackground(() => {
  // Sync wiring: listeners keep `bookmarkMeta` in step with the native tree
  // while the worker is alive; the one-shot reconcile reaps rows for ids that
  // vanished while it was suspended. Both are fire-and-forget — a sync
  // failure must never take down the provider message handler below.
  registerBookmarkListeners();
  // Right-click save items. Idempotent per worker start (removeAll + create,
  // and a WeakMap-keyed onClicked listener), and it clears any stale badge
  // left by a worker evicted mid-confirmation. Total: a partial `chrome`
  // surface degrades to a no-op rather than taking down the handler below.
  registerContextMenus();
  // `bm` omnibox keyword: session-scoped local index, ≤8 escaped
  // suggestions, disposition routing via the typed tabs slice. A missing
  // `chrome.omnibox` surface (Firefox, tests) degrades to a no-op, and all
  // listeners are total so a failure can never take down the worker.
  registerOmnibox();
  void reconcileMetadata().catch(() => {
    // Best-effort cleanup; the next worker start retries.
  });

  // MV3 async-response pattern: the listener returns `true` synchronously to
  // keep the sendResponse channel open, then resolves it once the handler
  // finishes. `handleProviderMessage` is total (it never throws — every path
  // returns a ProviderMessageResult), so sendResponse runs exactly once.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleProviderMessage(message, sender).then(sendResponse);
    return true;
  });
});
