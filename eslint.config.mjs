import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const egressRestrictionMessage =
  "All outbound requests must go through src/net/; direct egress APIs are restricted in app code.";

/**
 * Egress-capable web APIs banned outside `src/net/` (H03). Bare globals are
 * covered by `no-restricted-globals`; the same names are re-banned as
 * properties of `globalThis`/`self`/`window` because member access sidesteps
 * the globals rule. `navigator.sendBeacon` only exists as a property.
 */
const restrictedEgressGlobals = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
];

export default tseslint.config(
  {
    ignores: [
      ".agents/**",
      ".beads/**",
      ".codex/**",
      ".output/**",
      ".superpowers/**",
      ".worktrees/**",
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
        ...restrictedEgressGlobals.map((name) => ({
          name,
          message: egressRestrictionMessage,
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...restrictedEgressGlobals.flatMap((property) =>
          ["globalThis", "self", "window"].map((object) => ({
            object,
            property,
            message: egressRestrictionMessage,
          })),
        ),
        {
          object: "navigator",
          property: "sendBeacon",
          message: egressRestrictionMessage,
        },
      ],
      // `no-restricted-properties` needs a bare-identifier object, so
      // `window.navigator.sendBeacon(...)` would slip through. A syntax
      // selector bans sendBeacon calls on any `*.navigator` member chain.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='sendBeacon'][callee.object.type='MemberExpression'][callee.object.property.name='navigator']",
          message: egressRestrictionMessage,
        },
      ],
    },
  },
  {
    files: ["src/net/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
    },
  },
);
