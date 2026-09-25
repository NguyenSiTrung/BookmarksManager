import { defineBackground } from "wxt/utils/define-background";
import { handleProviderMessage } from "../messages/provider";

/**
 * The worker only registers listeners added by later tasks and performs no
 * network requests at startup. `chrome` is the lazy-slice house pattern so
 * test stubs work; only `runtime.onMessage` is needed here. Of the provider
 * protocol, only TEST_PROVIDER can produce egress, and only via the
 * consented gate in `src/net/send.ts` — everything else is storage work.
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
  // MV3 async-response pattern: the listener returns `true` synchronously to
  // keep the sendResponse channel open, then resolves it once the handler
  // finishes. `handleProviderMessage` is total (it never throws — every path
  // returns a ProviderMessageResult), so sendResponse runs exactly once.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleProviderMessage(message, sender).then(sendResponse);
    return true;
  });
});
