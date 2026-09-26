import { defineBackground } from "wxt/utils/define-background";
import { handleProviderMessage } from "../messages/provider";
import { registerBookmarkListeners } from "../sync/listeners";
import { reconcileMetadata } from "../sync/reconcile";

/**
 * At startup the worker subscribes the five bookmark events (which
 * cascade-delete extension metadata for removed subtrees and broadcast
 * `bookmarks-changed` to open pages) and runs one metadata reconcile for
 * deletions missed while the service worker was suspended. It performs no
 * network requests at startup. `chrome` is the lazy-slice house pattern so
 * test stubs work; only `runtime.onMessage` is needed here — the sync
 * modules declare their own slices. Of the provider protocol, only
 * TEST_PROVIDER can produce egress, and only via the consented gate in
 * `src/net/send.ts` — everything else is storage work.
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
