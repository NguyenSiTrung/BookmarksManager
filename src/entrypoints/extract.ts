import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { runReadabilityExtract } from "../extract/readability";

/**
 * The page-side half of spec FR9 extraction, injected on demand by
 * `extractActivePage` (`src/extract/page.ts`) via
 * `chrome.scripting.executeScript` — unlisted, so it is never a static
 * content script and only runs after an explicit user action on the tab
 * `activeTab` granted for that action.
 *
 * The `main()` return value becomes the injection result the worker reads;
 * it must be structured-cloneable, so only the plain-string
 * `ReadabilityPage` shape crosses back (never a DOM node). `null` tells
 * the worker the page yielded nothing usable.
 */
export default defineUnlistedScript(() => {
  // Capture from this document, not the worker's earlier tabs.get snapshot.
  const url = location.href;
  const documentIdentity = performance.timeOrigin;
  const page = runReadabilityExtract(document);
  return page === null ? null : { ...page, url, documentIdentity };
});
