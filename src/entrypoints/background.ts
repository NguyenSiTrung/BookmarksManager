import { defineBackground } from "wxt/utils/define-background";

export default defineBackground(() => {
  // The worker only registers listeners added by later tasks.
  // It performs no network requests at startup.
});
