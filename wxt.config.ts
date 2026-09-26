import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "Bookmarks Manager",
    version: "0.1.0",
    permissions: ["activeTab", "bookmarks", "favicon", "storage", "sidePanel"],
    optional_host_permissions: [
      "https://api.typesafe.ai/*",
      "https://openrouter.ai/*",
    ],
    // `_execute_action` is the MV3 reserved command name that opens the
    // extension's popup when one is declared — no `chrome.commands.onCommand`
    // listener is needed (the browser handles the dispatch). `Ctrl+Shift+Y` /
    // `Command+Shift+Y` is deliberately outside Chrome's built-in shortcut set
    // (Ctrl+Shift+B/O/D/T/N/W/Q/Delete/I/J/Space, Ctrl+D/T/N/W/J/H, F12 and
    // their Command equivalents), so it is not shadowed by a browser action.
    // Users can rebind it at chrome://extensions/shortcuts.
    commands: {
      _execute_action: {
        suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
        description: "Save the current page to Bookmarks Manager",
      },
    },
  },
});
