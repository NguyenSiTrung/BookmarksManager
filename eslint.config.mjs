import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const fetchRestrictionMessage =
  "All outbound requests must go through src/net/; fetch is restricted in app code.";

export default tseslint.config(
  {
    ignores: [
      ".agents/**",
      ".beads/**",
      ".codex/**",
      ".output/**",
      ".superpowers/**",
      ".wxt/**",
      "conductor/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  {
    settings: { react: { version: "detect" } },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions,
      },
    },
    rules: {
      "react/prop-types": "off",
    },
  },
  {
    ...reactHooks.configs.flat["recommended-latest"],
    files: ["src/**/*.{ts,tsx}"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: fetchRestrictionMessage },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "globalThis",
          property: "fetch",
          message: fetchRestrictionMessage,
        },
        {
          object: "self",
          property: "fetch",
          message: fetchRestrictionMessage,
        },
        {
          object: "window",
          property: "fetch",
          message: fetchRestrictionMessage,
        },
      ],
    },
  },
  {
    files: ["src/net/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
);
