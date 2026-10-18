// ESLint 扁平配置。规则刻意收紧到「能自动修的小集合」，避免为了过 lint 改乱代码。

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "output/**", "package-lock.json"],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
];
