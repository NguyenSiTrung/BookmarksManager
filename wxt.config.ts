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
    permissions: ["storage", "sidePanel"],
    optional_host_permissions: [
      "https://api.typesafe.ai/*",
      "https://openrouter.ai/*",
    ],
  },
});
